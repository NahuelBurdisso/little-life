import { db } from '../../db';
import { agents, economy, economyTransactions, worldState, worldEvents, activityLog, locations, agentStates, facts } from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { getItemPrice } from '../../lib/prices';
import type { Season } from '../../lib/types';
import { emitter } from '../emitter';
import { createFact } from '../../lib/gossip';

// --- Helpers ---

type EconRecord = typeof economy.$inferSelect;
type InventoryItem = { itemId: string; quantity: number; acquiredAt: number };

function getInventoryCount(econ: EconRecord, itemId: string): number {
  return econ.inventory.find((i) => i.itemId === itemId)?.quantity ?? 0;
}

function addInventoryItem(
  inventory: InventoryItem[],
  itemId: string,
  quantity: number,
  timestamp: number,
): InventoryItem[] {
  const existing = inventory.find((i) => i.itemId === itemId);
  if (existing) {
    return inventory.map((i) =>
      i.itemId === itemId ? { ...i, quantity: i.quantity + quantity } : i,
    );
  }
  return [...inventory, { itemId, quantity, acquiredAt: timestamp }];
}

function removeInventoryItem(
  inventory: InventoryItem[],
  itemId: string,
  quantity: number,
): InventoryItem[] {
  return inventory
    .map((i) =>
      i.itemId === itemId ? { ...i, quantity: i.quantity - quantity } : i,
    )
    .filter((i) => i.quantity > 0);
}

function mergeEventEffects(
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

const SEASON_PRODUCTION_MULTIPLIERS: Record<string, number> = {
  spring: 1.2,
  summer: 1.0,
  autumn: 0.8,
  winter: 0.4,
};

// --- Main tick ---

export function economyTick(): void {
  const world = db.select().from(worldState).get();
  if (!world) return;

  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const allEcon = db.select().from(economy).all();
  const activeEvents = db.select().from(worldEvents).where(eq(worldEvents.is_active, true)).all();

  const eventEffects = mergeEventEffects(activeEvents);
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

  // ========== 1. PRODUCTION ==========
  for (const agent of activeAgents) {
    const action = agent.current_action as any;
    if (!action || action.type !== 'working') continue;

    const econ = econByAgent.get(agent.id);
    if (!econ) continue;

    // Agent must be at their workplace
    if (!agent.workplace || agent.current_location !== agent.workplace) continue;

    const job = econ.job;

    if (job === 'farmer' || job === 'farmhand') {
      // Produce food_raw based on season
      const seasonMult = SEASON_PRODUCTION_MULTIPLIERS[season] ?? 1.0;
      const rawProduction =
        1 * gameHoursElapsed * seasonMult + econ.production_remainder;
      const wholeUnits = Math.floor(rawProduction);
      const remainder = rawProduction - wholeUnits;

      db.update(economy).set({ production_remainder: remainder }).where(eq(economy.id, econ.id)).run();

      if (wholeUnits > 0) {
        const newInventory = addInventoryItem(
          econ.inventory,
          'food_raw',
          wholeUnits,
          now,
        );
        db.update(economy).set({ inventory: newInventory }).where(eq(economy.id, econ.id)).run();
        // Update local reference
        econ.inventory = newInventory;
        econ.production_remainder = remainder;
      }
    } else if (job === 'bartender') {
      // Convert food_raw to drinks: 2 food_raw -> 4 drinks
      const available = getInventoryCount(econ, 'food_raw');
      const batches = Math.floor(available / 2);
      if (batches > 0) {
        let inv = removeInventoryItem(econ.inventory, 'food_raw', batches * 2);
        inv = addInventoryItem(inv, 'drink', batches * 4, now);
        db.update(economy).set({ inventory: inv }).where(eq(economy.id, econ.id)).run();
        econ.inventory = inv;
      }
    } else if (job === 'doctor' || job === 'medical_assistant') {
      // Produce medicine slowly
      const rawProduction =
        0.5 * gameHoursElapsed + econ.production_remainder;
      const wholeUnits = Math.floor(rawProduction);
      const remainder = rawProduction - wholeUnits;

      db.update(economy).set({ production_remainder: remainder }).where(eq(economy.id, econ.id)).run();

      if (wholeUnits > 0) {
        const newInventory = addInventoryItem(
          econ.inventory,
          'medicine',
          wholeUnits,
          now,
        );
        db.update(economy).set({ inventory: newInventory }).where(eq(economy.id, econ.id)).run();
        econ.inventory = newInventory;
        econ.production_remainder = remainder;
      }
    } else if (job === 'baker') {
      // Convert food_raw to food_prepared: 1 food_raw -> 2 food_prepared
      const available = getInventoryCount(econ, 'food_raw');
      if (available > 0) {
        let inv = removeInventoryItem(econ.inventory, 'food_raw', available);
        inv = addInventoryItem(inv, 'food_prepared', available * 2, now);
        db.update(economy).set({ inventory: inv }).where(eq(economy.id, econ.id)).run();
        econ.inventory = inv;
      }
    }
    // Other jobs: no production
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
      if (eatLocation && (eatLocation.type === 'shop' || eatLocation.type === 'tavern') && eatLocation.owner) {
        const buyerEcon = econByAgent.get(agent.id);
        if (!buyerEcon) continue;

        // Determine what to buy based on location type
        const itemToBuy = eatLocation.type === 'tavern' ? 'drink' : 'food_prepared';
        const fallbackItem = 'food_raw';
        const ownerEcon = econByAgent.get(eatLocation.owner);
        if (!ownerEcon) continue;

        // Try preferred item first, then fallback
        let item = itemToBuy;
        let shopStock = getInventoryCount(ownerEcon, item);
        if (shopStock <= 0) {
          item = fallbackItem;
          shopStock = getInventoryCount(ownerEcon, item);
        }
        if (shopStock <= 0) continue;

        const price = getItemPrice(item, season, eventEffects);
        if (buyerEcon.money < price) continue;

        // Transfer item
        const newOwnerInv = removeInventoryItem(ownerEcon.inventory, item, 1);
        const newBuyerInv = addInventoryItem(buyerEcon.inventory, item, 1, now);
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
          reason: `purchase:${item}`,
          items_exchanged: [{ itemId: item, quantity: 1 }],
          location_id: agent.current_location,
          timestamp: now,
        }).run();

        db.insert(activityLog).values({
          type: 'economy',
          message: `${agent.name} bought ${item} for ${price} coins`,
          agent_ids: [agent.id, eatLocation.owner],
          timestamp: world.time!.totalTicks,
          real_timestamp: now,
        }).run();
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
      const shopStock = getInventoryCount(ownerEcon, item);
      if (shopStock <= 0) continue;

      // Get price
      const price = getItemPrice(item, season, eventEffects);
      if (buyerEcon.money < price) continue;

      // Transfer item: remove from shop, add to buyer
      const newOwnerInv = removeInventoryItem(ownerEcon.inventory, item, 1);
      const newBuyerInv = addInventoryItem(buyerEcon.inventory, item, 1, now);

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
      db.insert(activityLog).values({
        type: 'economy',
        message: `${agent.name} bought ${item} for ${price} coins`,
        agent_ids: [agent.id, shopLocation.owner],
        timestamp: world.time!.totalTicks,
        real_timestamp: now,
      }).run();
    }
  }

  // ========== 4. DAILY EXPENSES (on day change) ==========
  if (dayChanged) {
    const { min, max } = CONFIG.ECONOMY.DAILY_EXPENSES;

    for (const econ of allEcon) {
      const expense = Math.floor(Math.random() * (max - min + 1)) + min;
      const newMoney = Math.max(0, econ.money - expense);
      db.update(economy).set({
        money: newMoney,
        daily_expenses: expense,
      }).where(eq(economy.id, econ.id)).run();
      econ.money = newMoney;

      if (newMoney < 10) {
        createFact('financial', econ.agent_id, null, 1, [econ.agent_id], 'observed');
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
      db.insert(activityLog).values({
        type: 'economy',
        message: `Money supply check: inflation detected (ratio ${ratio.toFixed(2)}). Total: ${totalMoney}, target: ${targetTotal}`,
        agent_ids: [],
        timestamp: world.time!.totalTicks,
        real_timestamp: now,
      }).run();
    } else if (ratio < CONFIG.ECONOMY.DEFLATION_THRESHOLD) {
      db.insert(activityLog).values({
        type: 'economy',
        message: `Money supply check: deflation detected (ratio ${ratio.toFixed(2)}). Total: ${totalMoney}, target: ${targetTotal}`,
        agent_ids: [],
        timestamp: world.time!.totalTicks,
        real_timestamp: now,
      }).run();
    }
  }

  emitter.markDirty('agents.all');
}
