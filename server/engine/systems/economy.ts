import { db } from '../../db';
import { agents, economy, economyTransactions, worldState, worldEvents, locations, agentStates, shared_knowledge } from '../../db/schema';
import { logActivity } from '../../lib/activityLogger';
import { eq, and } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import type { Season } from '../../lib/types';
import { emitter } from '../emitter';
import { createFact } from '../../lib/gossip';
import { getRecipeForJob, getMarketPrice, getInventoryCount, addToInventory, removeFromInventory, getTradeRuleForLocation, setEventPriceModifiers, getEventProductionMultiplier } from '../../lib/economyEngine';
import { SEASON_PRODUCTION_MODIFIERS, LIVING_COSTS, TRADE_RULES, ITEM_REGISTRY } from '../../data/economyData';
import { simEvents } from '../../lib/simEvents';
import { getReputationPriceModifier } from '../../lib/reputationEngine';

// --- Module-level state for batching and milestones ---

const productionThisTick = new Map<number, { item: string; qty: number }>();

let dailyLivingCostMultiplier = 1.0;
let dailyTaxRateMultiplier = 1.0;

export function getDailyTaxMultiplier(): number { return dailyTaxRateMultiplier; }
export function getDailyLivingCostMultiplier(): number { return dailyLivingCostMultiplier; }

const lastMilestoneLevel = new Map<number, number>();
const MILESTONES = [10, 25, 50, 100];

function checkMilestone(agentId: number, money: number): void {
  const currentLevel = MILESTONES.filter(m => money >= m).length;
  const lastLevel = lastMilestoneLevel.get(agentId);
  if (lastLevel !== undefined && currentLevel !== lastLevel) {
    const crossedUp = currentLevel > lastLevel;
    const threshold = crossedUp ? MILESTONES[currentLevel - 1] : MILESTONES[lastLevel - 1];
    simEvents.emit('economy:milestone', { agentId, amount: threshold, direction: crossedUp ? 'up' : 'down' });
  }
  lastMilestoneLevel.set(agentId, currentLevel);
}

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

  const eventEffects = mergeEventEffects(activeEvents);
  setEventPriceModifiers(eventEffects); // Apply event price modifiers (market_day, festival, harvest)
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

      const prevProc = productionThisTick.get(agent.id) ?? { item: recipe.output, qty: 0 };
      prevProc.qty += recipe.outputQuantity;
      productionThisTick.set(agent.id, prevProc);
    } else {
      // Raw production: rate-based with seasonal modifier and remainder
      const seasonMult = recipe.seasonal ? (SEASON_PRODUCTION_MODIFIERS[season] ?? 1.0) : 1.0;
      const eventMult = getEventProductionMultiplier();
      const rawProduction = recipe.rate * gameHoursElapsed * seasonMult * eventMult + econ.production_remainder;
      const wholeUnits = Math.floor(rawProduction);
      const remainder = rawProduction - wholeUnits;

      db.update(economy).set({ production_remainder: remainder }).where(eq(economy.id, econ.id)).run();
      econ.production_remainder = remainder;

      if (wholeUnits > 0) {
        const outputQuantity = wholeUnits * recipe.outputQuantity;
        const newInv = addToInventory(econ.inventory as any[], recipe.output, outputQuantity, now);
        db.update(economy).set({ inventory: newInv }).where(eq(economy.id, econ.id)).run();
        econ.inventory = newInv;

        const prev = productionThisTick.get(agent.id) ?? { item: recipe.output, qty: 0 };
        prev.qty += outputQuantity;
        productionThisTick.set(agent.id, prev);
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
    simEvents.emit('economy:transaction', { agentId: agent.id, amount: effectiveSalary });
    checkMilestone(agent.id, newMoney);

    // Process blackmail payments (victim pays 10% of salary to blackmailer)
    const blackmailFacts = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.type, 'blackmail'), eq(shared_knowledge.is_active, true), eq(shared_knowledge.target_id, agent.id))).all();
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
          simEvents.emit('economy:blackmail_paid', { agentId: agent.id, amount: paymentAmount });
          checkMilestone(agent.id, econ.money);
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
          const price = Math.round(getMarketPrice(itemToBuy, season, shopStock) * getReputationPriceModifier(agent.id));
          if (buyerEcon.money < price) { continue; }

          // Transfer item
          const newOwnerInv = removeFromInventory(ownerEcon.inventory as any[], itemToBuy, 1);
          const newBuyerInv = addToInventory(buyerEcon.inventory as any[], itemToBuy, 1, now);
          const tax = Math.round(price * CONFIG.ECONOMY.TAX_RATE * dailyTaxRateMultiplier);
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
          simEvents.emit('economy:purchase', { agentId: agent.id, item: itemToBuy, price, locationName: eatLocation.name });
          checkMilestone(agent.id, buyerEcon.money);
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

      // Get price (modified by buyer's reputation)
      const price = Math.round(getMarketPrice(item, season, shopStock) * getReputationPriceModifier(agent.id));
      if (buyerEcon.money < price) continue;

      // Transfer item: remove from shop, add to buyer
      const newOwnerInv = removeFromInventory(ownerEcon.inventory as any[], item, 1);
      const newBuyerInv = addToInventory(buyerEcon.inventory as any[], item, 1, now);

      // Calculate tax
      const tax = Math.round(price * CONFIG.ECONOMY.TAX_RATE * dailyTaxRateMultiplier);
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
      simEvents.emit('economy:purchase', { agentId: agent.id, item, price, locationName: shopLocation.name });
      checkMilestone(agent.id, buyerEcon.money);
    }
  }

  // ========== 4. LIVING COSTS (data-driven) ==========
  if (dayChanged) {
    for (const cost of LIVING_COSTS) {
      if (cost.frequency !== 'per_day') continue;
      for (const econ of allEcon) {
        const newMoney = Math.max(0, econ.money - cost.amount * dailyLivingCostMultiplier);
        db.update(economy).set({ money: newMoney, daily_expenses: cost.amount })
          .where(eq(economy.id, econ.id)).run();
        econ.money = newMoney;
        checkMilestone(econ.agent_id, newMoney);

        if (newMoney < 10) {
          createFact('financial', econ.agent_id, null, 1, [econ.agent_id], 'observed');
          simEvents.emit('economy:distress', { agentId: econ.agent_id });
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

    if (ratio > 1.5) {
      // Exponential scaling — punishes runaway inflation hard
      const excess = ratio - 1.0;
      dailyLivingCostMultiplier = 1.0 + excess * excess * 0.5;
      dailyTaxRateMultiplier = 1.0 + excess * excess * 0.8;
    } else if (ratio < 0.5) {
      dailyLivingCostMultiplier = Math.max(0.3, ratio);
      dailyTaxRateMultiplier = 0.5;
    } else {
      dailyLivingCostMultiplier = 1.0;
      dailyTaxRateMultiplier = 1.0;
    }

    // ── ECONOMIC CRISIS EVENTS (ratio > 2.0) ──
    if (ratio > 2.0) {
      const sortedByWealth = [...allEcon].sort((a, b) => b.money - a.money);
      const crisisRoll = Math.random();

      if (crisisRoll < 0.25) {
        // ROBBERY: poorest agent robs richest
        const richest = sortedByWealth[0];
        const poorest = sortedByWealth[sortedByWealth.length - 1];
        if (richest && poorest && richest.agent_id !== poorest.agent_id && richest.money > 20) {
          const stolen = Math.floor(richest.money * (0.1 + Math.random() * 0.2));
          db.update(economy).set({ money: richest.money - stolen }).where(eq(economy.id, richest.id)).run();
          db.update(economy).set({ money: poorest.money + stolen }).where(eq(economy.id, poorest.id)).run();
          richest.money -= stolen;
          poorest.money += stolen;
          const richAgent = activeAgents.find(a => a.id === richest.agent_id);
          const poorAgent = activeAgents.find(a => a.id === poorest.agent_id);
          if (richAgent && poorAgent) {
            createFact('theft', poorest.agent_id, richest.agent_id, 2, [poorest.agent_id], 'committed');
            logActivity({ type: 'drama', initiator: poorest.agent_id, target: richest.agent_id,
              templateData: { description: `${poorAgent.name} stole $${stolen} from ${richAgent.name} during the economic crisis` } });
            simEvents.emit('economy:theft', { thief: poorest.agent_id, victim: richest.agent_id, amount: stolen });
          }
        }
      } else if (crisisRoll < 0.45) {
        // EMERGENCY TAX: government seizes % from everyone
        const taxRate = 0.05 + Math.random() * 0.10; // 5-15%
        let totalSeized = 0;
        for (const econ of allEcon) {
          const seized = Math.floor(econ.money * taxRate);
          if (seized > 0) {
            db.update(economy).set({ money: econ.money - seized }).where(eq(economy.id, econ.id)).run();
            econ.money -= seized;
            totalSeized += seized;
          }
        }
        db.update(worldState).set({ tax_pool: world.tax_pool + totalSeized }).where(eq(worldState.id, world.id)).run();
        logActivity({ type: 'system',
          templateData: { message: `Emergency tax! Government seized ${Math.round(taxRate * 100)}% from all citizens ($${totalSeized} total) to combat inflation` } });
      } else if (crisisRoll < 0.60) {
        // SCAM: con artist targets top 3 wealthiest
        const targets = sortedByWealth.slice(0, 3);
        for (const target of targets) {
          if (Math.random() < 0.5 && target.money > 15) {
            const lost = Math.floor(target.money * (0.05 + Math.random() * 0.15));
            db.update(economy).set({ money: target.money - lost }).where(eq(economy.id, target.id)).run();
            target.money -= lost;
            const agent = activeAgents.find(a => a.id === target.agent_id);
            if (agent) {
              logActivity({ type: 'drama', initiator: target.agent_id,
                templateData: { description: `${agent.name} lost $${lost} to a traveling scammer` } });
              simEvents.emit('economy:scam', { agentId: target.agent_id, amount: lost });
            }
          }
        }
      } else if (crisisRoll < 0.75) {
        // PRICE GOUGING: random agent hoards and everyone pays more next day
        dailyLivingCostMultiplier *= 1.5;
        const hoarder = sortedByWealth[Math.floor(Math.random() * Math.min(3, sortedByWealth.length))];
        const hoarderAgent = activeAgents.find(a => a.id === hoarder?.agent_id);
        if (hoarderAgent) {
          logActivity({ type: 'drama', initiator: hoarder.agent_id,
            templateData: { description: `${hoarderAgent.name} is hoarding supplies — prices spike across town` } });
          createFact('hoarding', hoarder.agent_id, null, 1, [hoarder.agent_id], 'observed');
        }
      }
      // else: no crisis event this day (25% chance of reprieve)
    }

    // ── EXTREME INFLATION DRAIN (ratio > 3.0): money literally rots ──
    if (ratio > 3.0) {
      const rotRate = Math.min(0.15, (ratio - 3.0) * 0.05); // 5-15% wealth decay
      for (const econ of allEcon) {
        const lost = Math.floor(econ.money * rotRate);
        if (lost > 0) {
          db.update(economy).set({ money: econ.money - lost }).where(eq(economy.id, econ.id)).run();
          econ.money -= lost;
        }
      }
      logActivity({ type: 'system',
        templateData: { message: `Hyperinflation! Currency devalued — everyone lost ${Math.round(rotRate * 100)}% purchasing power (ratio ${ratio.toFixed(2)})` } });
    }

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

  // Emit production events (batched per agent per tick)
  for (const [agentId, prod] of productionThisTick) {
    if (prod.qty > 0) simEvents.emit('economy:production', { agentId, item: prod.item, quantity: prod.qty });
  }
  productionThisTick.clear();

  // Cleanup: prune milestone tracking for inactive agents (prevents memory leak)
  if (dayChanged) {
    const activeIds = new Set(activeAgents.map(a => a.id));
    for (const id of lastMilestoneLevel.keys()) {
      if (!activeIds.has(id)) lastMilestoneLevel.delete(id);
    }
  }

  emitter.markDirty('agents.all');
}
