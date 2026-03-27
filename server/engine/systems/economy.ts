import { db } from '../../db';
import { agents, economy, economyTransactions, worldState, worldEvents, locations, agentStates, facts } from '../../db/schema';
import { logActivity } from '../../lib/activityLogger';
import { eq, and } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import type { Season } from '../../lib/types';
import { emitter } from '../emitter';
import { createFact } from '../../lib/gossip';
import { getRecipeForJob, getMarketPrice, getInventoryCount, addToInventory, removeFromInventory, getTradeRuleForLocation } from '../../lib/economyEngine';
import { SEASON_PRODUCTION_MODIFIERS, LIVING_COSTS, TRADE_RULES, ITEM_REGISTRY } from '../../data/economyData';

// --- Helpers ---

type EconRecord = typeof economy.$inferSelect;

export function mergeEventEffects(
  events: (typeof worldEvents.$inferSelect)[],
): Record<string, number> {
  const effects: Record<string, number> = {};
  for (const event of events) {
    if (event.effects && typeof event.effects === 'object') {
      for (const [key, value] of Object.entries(event.effects)) {
        if (typeof value === 'number') {
          // Multiply stacking effects
          effects[key] = (effects[key] ?? 1) * value;
        }
      }
    }
  }
  return effects;
}

// --- Main tick ---

export function economyTick(): void {
  const world = db.select().from(worldState).get();
  if (!world) return;

  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const allEcon = db.select().from(economy).all();
  const activeEvents = db.select().from(worldEvents).where(eq(worldEvents.is_active, true)).all();
  const allLocations = db.select().from(locations).all();

  mergeEventEffects(activeEvents); // reserved for future event price modifiers
  const season = world.time!.season as Season;
  const currentHour = world.time!.hour;
  const now = Date.now();

  // Build lookup maps
  const econByAgent = new Map<number, EconRecord>();
  for (const econ of allEcon) {
    econByAgent.set(econ.agent_id, econ);
  }

  // How many game-hours elapsed this tick
  const gameMinutesElapsed = world.tick_speed;
  const gameHoursElapsed = gameMinutesElapsed / 60;

  // Check for day_changed transition
  const dayChanged = world.pending_transitions.some(
    (t: any) => t.type === 'day_changed',
  );

  // Location cache for shop lookups
  const locationCache = new Map<number, typeof locations.$inferSelect>();

  // ========== 1. PRODUCTION (data-driven) ==========
  for (const agent of activeAgents) {
    const action = agent.current_action as any;
    if (!action || action.type !== 'working') continue;

    const econ = econByAgent.get(agent.id);
    if (!econ) continue;
    if (!agent.workplace || agent.current_location !== agent.workplace) continue;

    const recipe = getRecipeForJob(econ.job);
    if (!recipe) continue;

    if (recipe.inputs) {
      // Processing job: convert inputs to outputs
      let canProduce = true;
      for (const [inputItem, inputQty] of Object.entries(recipe.inputs)) {
        if (getInventoryCount(econ.inventory as any[], inputItem) < inputQty) {
          canProduce = false;
          break;
        }
      }
      if (!canProduce) continue;

      let inv = econ.inventory as any[];
      for (const [inputItem, inputQty] of Object.entries(recipe.inputs)) {
        inv = removeFromInventory(inv, inputItem, inputQty);
      }
      inv = addToInventory(inv, recipe.output, recipe.outputQuantity, now);
      db.update(economy).set({ inventory: inv }).where(eq(economy.id, econ.id)).run();
      econ.inventory = inv;
    } else {
      // Raw production: rate-based with seasonal modifier and remainder
      const seasonMult = recipe.seasonal ? (SEASON_PRODUCTION_MODIFIERS[season] ?? 1.0) : 1.0;
      const rawProduction = recipe.rate * gameHoursElapsed * seasonMult + econ.production_remainder;
      const wholeUnits = Math.floor(rawProduction);
      const remainder = rawProduction - wholeUnits;

      db.update(economy).set({ production_remainder: remainder }).where(eq(economy.id, econ.id)).run();
      econ.production_remainder = remainder;

      if (wholeUnits > 0) {
        const newInv = addToInventory(econ.inventory as any[], recipe.output, wholeUnits * recipe.outputQuantity, now);
        db.update(economy).set({ inventory: newInv }).where(eq(economy.id, econ.id)).run();
        econ.inventory = newInv;
      }
    }
  }

  // ========== 1.5. SUPPLY CHAIN — producers sell surplus to shops ==========
  for (const [locType, rules] of Object.entries(TRADE_RULES)) {
    if (rules.buys.length === 0) continue;

    for (const loc of allLocations) {
      if ((loc as any).type !== locType || !loc.owner) continue;
      const ownerEcon = econByAgent.get(loc.owner);
      if (!ownerEcon) continue;

      for (const buyItem of rules.buys) {
        for (const agent of activeAgents) {
          if (agent.id === loc.owner) continue;
          const agentEcon = econByAgent.get(agent.id);
          if (!agentEcon) continue;

          const recipe = getRecipeForJob(agentEcon.job);
          if (!recipe || recipe.output !== buyItem) continue;

          const agentStock = getInventoryCount(agentEcon.inventory as any[], buyItem);
          const surplus = agentStock - 3;
          if (surplus <= 0) continue;

          const shopStock = getInventoryCount(ownerEcon.inventory as any[], buyItem);
          const price = getMarketPrice(buyItem, season, shopStock);
          const buyAmount = Math.min(surplus, Math.floor(ownerEcon.money / price));
          if (buyAmount <= 0 || price <= 0) continue;

          const totalCost = price * buyAmount;

          const newProducerInv = removeFromInventory(agentEcon.inventory as any[], buyItem, buyAmount);
          const newShopInv = addToInventory(ownerEcon.inventory as any[], buyItem, buyAmount, now);

          db.update(economy).set({ inventory: newProducerInv, money: agentEcon.money + totalCost }).where(eq(economy.id, agentEcon.id)).run();
          db.update(economy).set({ inventory: newShopInv, money: ownerEcon.money - totalCost }).where(eq(economy.id, ownerEcon.id)).run();
          agentEcon.inventory = newProducerInv;
          agentEcon.money += totalCost;
          ownerEcon.inventory = newShopInv;
          ownerEcon.money -= totalCost;

          db.insert(economyTransactions).values({
            from_agent: loc.owner,
            to_agent: agent.id,
            amount: totalCost,
            reason: `wholesale:${buyItem}`,
            items_exchanged: [{ itemId: buyItem, quantity: buyAmount }],
            location_id: loc.id,
            timestamp: now,
          }).run();
        }
      }
    }
  }

  // ========== 2. PAYDAY ==========
  const minPaydayIntervalHours = CONFIG.ECONOMY.MIN_PAYDAY_INTERVAL_HOURS;

  for (const agent of activeAgents) {
    const econ = econByAgent.get(agent.id);
    if (!econ) continue;

    // Check if it's end of work shift
    const workEnd = agent.schedule.workEnd;
    // Consider payday if current hour matches workEnd (or just passed it)
    if (currentHour < workEnd || currentHour > workEnd + 1) continue;

    // Check lastPayday interval.
    const minPaydayIntervalMs =
      (minPaydayIntervalHours * 60 * 1000) / world.tick_speed;

    if (econ.last_payday !== 0 && now - econ.last_payday < minPaydayIntervalMs) {
      continue;
    }

    // Pay salary
    // Check for alcoholic state — reduce salary
    let effectiveSalary = econ.salary;
    const alcoholicState = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, 'alcoholic'))).get();
    if (alcoholicState) {
      const meta = (alcoholicState.metadata as Record<string, any> | null) ?? {};
      if (meta.stage === 3) {
        effectiveSalary = Math.floor(econ.salary * 0.6);
      } else {
        effectiveSalary = Math.floor(econ.salary * 0.7);
      }
    }
    const newMoney = econ.money + effectiveSalary;
    db.update(economy).set({
      money: newMoney,
      last_payday: now,
    }).where(eq(economy.id, econ.id)).run();
    econ.money = newMoney;
    econ.last_payday = now;

    // Log transaction
    db.insert(economyTransactions).values({
      from_agent: null,
      to_agent: agent.id,
      amount: effectiveSalary,
      reason: 'salary',
      items_exchanged: null,
      location_id: agent.workplace,
      timestamp: now,
    }).run();

    // Process blackmail payments (victim pays 10% of salary to blackmailer)
    const blackmailFacts = db.select().from(facts)
      .where(and(eq(facts.type, 'blackmail'), eq(facts.is_active, true), eq(facts.target_id, agent.id))).all();
    for (const fact of blackmailFacts) {
      const blackmailerId = fact.subject_id;
      const paymentAmount = Math.floor(econ.salary * 0.1);
      if (econ.money >= paymentAmount && paymentAmount > 0) {
        const blackmailerEcon = econByAgent.get(blackmailerId);
        if (blackmailerEcon) {
          db.update(economy).set({ money: econ.money - paymentAmount }).where(eq(economy.id, econ.id)).run();
          econ.money -= paymentAmount;
          db.update(economy).set({ money: blackmailerEcon.money + paymentAmount }).where(eq(economy.id, blackmailerEcon.id)).run();
          blackmailerEcon.money += paymentAmount;

          db.insert(economyTransactions).values({
            from_agent: agent.id,
            to_agent: blackmailerId,
            amount: paymentAmount,
            reason: 'blackmail_payment',
            items_exchanged: null,
            location_id: null,
            timestamp: now,
          }).run();
        }
      }
    }
  }

  // ========== 3. SHOP TRANSACTIONS ==========
  // Process both explicit 'shopping' actions and 'eating' at shop/tavern locations
  for (const agent of activeAgents) {
    const action = agent.current_action as any;
    if (!action) continue;

    // Auto-purchase food when eating at a shop or tavern
    if (action.type === 'eating' && agent.current_location != null) {
      let eatLocation = locationCache.get(agent.current_location);
      if (!eatLocation) {
        const loc = db.select().from(locations).where(eq(locations.id, agent.current_location)).get();
        if (loc) {
          eatLocation = loc;
          locationCache.set(agent.current_location, loc);
        }
      }
      if (eatLocation) {
        const tradeRule = getTradeRuleForLocation(eatLocation.type);
        if (tradeRule && eatLocation.owner) {
          const buyerEcon = econByAgent.get(agent.id);
          if (!buyerEcon) { continue; }

          const ownerEcon = econByAgent.get(eatLocation.owner);
          if (!ownerEcon) { continue; }

          // Find best food item the shop sells and has in stock
          let itemToBuy: string | null = null;
          for (const sellItem of tradeRule.sells) {
            const def = ITEM_REGISTRY[sellItem];
            if (!def?.satisfies || def.satisfies.need !== 'hunger') continue;
            if (getInventoryCount(ownerEcon.inventory as any[], sellItem) > 0) {
              itemToBuy = sellItem;
              break;
            }
          }
          // Fallback: try any item the shop sells
          if (!itemToBuy) {
            for (const sellItem of tradeRule.sells) {
              if (getInventoryCount(ownerEcon.inventory as any[], sellItem) > 0) {
                itemToBuy = sellItem;
                break;
              }
            }
          }
          if (!itemToBuy) { continue; }

          const shopStock = getInventoryCount(ownerEcon.inventory as any[], itemToBuy);
          const price = getMarketPrice(itemToBuy, season, shopStock);
          if (buyerEcon.money < price) { continue; }

          // Transfer item
          const newOwnerInv = removeFromInventory(ownerEcon.inventory as any[], itemToBuy, 1);
          const newBuyerInv = addToInventory(buyerEcon.inventory as any[], itemToBuy, 1, now);
          const tax = Math.round(price * CONFIG.ECONOMY.TAX_RATE);
          const sellerReceives = price - tax;

          db.update(economy).set({
            inventory: newOwnerInv,
            money: ownerEcon.money + sellerReceives,
          }).where(eq(economy.id, ownerEcon.id)).run();
          ownerEcon.inventory = newOwnerInv;
          ownerEcon.money += sellerReceives;

          db.update(economy).set({
            inventory: newBuyerInv,
            money: buyerEcon.money - price,
          }).where(eq(economy.id, buyerEcon.id)).run();
          buyerEcon.inventory = newBuyerInv;
          buyerEcon.money -= price;

          db.update(worldState).set({
            tax_pool: world.tax_pool + tax,
          }).where(eq(worldState.id, world.id)).run();
          world.tax_pool += tax;

          db.insert(economyTransactions).values({
            from_agent: agent.id,
            to_agent: eatLocation.owner,
            amount: price,
            reason: `purchase:${itemToBuy}`,
            items_exchanged: [{ itemId: itemToBuy, quantity: 1 }],
            location_id: agent.current_location,
            timestamp: now,
          }).run();

          logActivity({
            type: 'purchase',
            initiator: agent.id,
            target: eatLocation.owner,
            templateData: { agent: agent.name, item: itemToBuy, amount: price },
          });
        }
      }
      continue;
    }

    if (action.type !== 'shopping') continue;

    const buyerEcon = econByAgent.get(agent.id);
    if (!buyerEcon) continue;

    const shopId = action.shopId as number;
    if (!shopId) continue;

    // Get shop location
    let shopLocation = locationCache.get(shopId);
    if (!shopLocation) {
      const loc = db.select().from(locations).where(eq(locations.id, shopId)).get();
      if (!loc) continue;
      shopLocation = loc;
      locationCache.set(shopId, loc);
    }

    // Find shop owner's economy record
    if (!shopLocation.owner) continue;
    const ownerEcon = econByAgent.get(shopLocation.owner);
    if (!ownerEcon) continue;

    const items: string[] = action.items ?? [];

    for (const item of items) {
      // Check shop has stock
      const shopStock = getInventoryCount(ownerEcon.inventory as any[], item);
      if (shopStock <= 0) continue;

      // Get price
      const price = getMarketPrice(item, season, shopStock);
      if (buyerEcon.money < price) continue;

      // Transfer item: remove from shop, add to buyer
      const newOwnerInv = removeFromInventory(ownerEcon.inventory as any[], item, 1);
      const newBuyerInv = addToInventory(buyerEcon.inventory as any[], item, 1, now);

      // Calculate tax
      const tax = Math.round(price * CONFIG.ECONOMY.TAX_RATE);
      const sellerReceives = price - tax;

      // Update shop owner
      db.update(economy).set({
        inventory: newOwnerInv,
        money: ownerEcon.money + sellerReceives,
      }).where(eq(economy.id, ownerEcon.id)).run();
      ownerEcon.inventory = newOwnerInv;
      ownerEcon.money = ownerEcon.money + sellerReceives;

      // Update buyer
      db.update(economy).set({
        inventory: newBuyerInv,
        money: buyerEcon.money - price,
      }).where(eq(economy.id, buyerEcon.id)).run();
      buyerEcon.inventory = newBuyerInv;
      buyerEcon.money = buyerEcon.money - price;

      // Add tax to world taxPool
      db.update(worldState).set({
        tax_pool: world.tax_pool + tax,
      }).where(eq(worldState.id, world.id)).run();
      world.tax_pool = world.tax_pool + tax;

      // Log transaction
      db.insert(economyTransactions).values({
        from_agent: agent.id,
        to_agent: shopLocation.owner,
        amount: price,
        reason: `purchase:${item}`,
        items_exchanged: [{ itemId: item, quantity: 1 }],
        location_id: shopId,
        timestamp: now,
      }).run();

      // Log to activity feed
      logActivity({
        type: 'purchase',
        initiator: agent.id,
        target: shopLocation.owner,
        templateData: { agent: agent.name, item, amount: price },
      });
    }
  }

  // ========== 4. LIVING COSTS (data-driven) ==========
  if (dayChanged) {
    for (const cost of LIVING_COSTS) {
      if (cost.frequency !== 'per_day') continue;
      for (const econ of allEcon) {
        const newMoney = Math.max(0, econ.money - cost.amount);
        db.update(economy).set({ money: newMoney, daily_expenses: cost.amount })
          .where(eq(economy.id, econ.id)).run();
        econ.money = newMoney;

        if (newMoney < 10) {
          createFact('financial', econ.agent_id, null, 1, [econ.agent_id], 'observed');
        }
      }
    }
  }

  // ========== 5. MONEY SUPPLY BALANCER (on day change) ==========
  if (dayChanged) {
    const totalMoney = allEcon.reduce((sum, e) => sum + e.money, 0);
    const targetTotal =
      activeAgents.length * CONFIG.ECONOMY.TARGET_PER_CAPITA_MONEY;
    const ratio = targetTotal > 0 ? totalMoney / targetTotal : 1;

    if (ratio > CONFIG.ECONOMY.INFLATION_THRESHOLD) {
      logActivity({
        type: 'system',
        templateData: { message: `Money supply check: inflation detected (ratio ${ratio.toFixed(2)}). Total: ${totalMoney}, target: ${targetTotal}` },
      });
    } else if (ratio < CONFIG.ECONOMY.DEFLATION_THRESHOLD) {
      logActivity({
        type: 'system',
        templateData: { message: `Money supply check: deflation detected (ratio ${ratio.toFixed(2)}). Total: ${totalMoney}, target: ${targetTotal}` },
      });
    }
  }

  emitter.markDirty('agents.all');
}
