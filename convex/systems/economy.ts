import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { CONFIG } from "../engine/constants";
import { getItemPrice } from "../lib/prices";
import { Season } from "../lib/types";

// --- Helpers ---

function getInventoryCount(econ: Doc<"economy">, itemId: string): number {
  return econ.inventory.find((i) => i.itemId === itemId)?.quantity ?? 0;
}

function addInventoryItem(
  inventory: Doc<"economy">["inventory"],
  itemId: string,
  quantity: number,
  timestamp: number,
): Doc<"economy">["inventory"] {
  const existing = inventory.find((i) => i.itemId === itemId);
  if (existing) {
    return inventory.map((i) =>
      i.itemId === itemId ? { ...i, quantity: i.quantity + quantity } : i,
    );
  }
  return [...inventory, { itemId, quantity, acquiredAt: timestamp }];
}

function removeInventoryItem(
  inventory: Doc<"economy">["inventory"],
  itemId: string,
  quantity: number,
): Doc<"economy">["inventory"] {
  return inventory
    .map((i) =>
      i.itemId === itemId ? { ...i, quantity: i.quantity - quantity } : i,
    )
    .filter((i) => i.quantity > 0);
}

function mergeEventEffects(
  events: Doc<"worldEvents">[],
): Record<string, number> {
  const effects: Record<string, number> = {};
  for (const event of events) {
    if (event.effects && typeof event.effects === "object") {
      for (const [key, value] of Object.entries(event.effects)) {
        if (typeof value === "number") {
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

export async function tick(
  ctx: MutationCtx,
  world: Doc<"worldState">,
): Promise<void> {
  const agents = await ctx.db
    .query("agents")
    .filter((q) => q.eq(q.field("isActive"), true))
    .collect();
  const allEcon = await ctx.db.query("economy").collect();
  const activeEvents = await ctx.db
    .query("worldEvents")
    .filter((q) => q.eq(q.field("isActive"), true))
    .collect();

  const eventEffects = mergeEventEffects(activeEvents);
  const season = world.time.season as Season;
  const currentHour = world.time.hour;
  const now = Date.now();

  // Build lookup maps
  const econByAgent = new Map<string, Doc<"economy">>();
  for (const econ of allEcon) {
    econByAgent.set(econ.agentId as string, econ);
  }

  // How many game-hours elapsed this tick
  const gameMinutesElapsed = world.tickSpeed;
  const gameHoursElapsed = gameMinutesElapsed / 60;

  // Check for day_changed transition
  const dayChanged = world.pendingTransitions.some(
    (t: any) => t.type === "day_changed",
  );

  // ========== 1. PRODUCTION ==========
  for (const agent of agents) {
    const action = agent.currentAction as any;
    if (!action || action.type !== "working") continue;

    const econ = econByAgent.get(agent._id as string);
    if (!econ) continue;

    // Agent must be at their workplace
    if (!agent.workplace || agent.currentLocation !== agent.workplace) continue;

    const job = econ.job;

    if (job === "farmer" || job === "farmhand") {
      // Produce food_raw based on season
      const seasonMult = SEASON_PRODUCTION_MULTIPLIERS[season] ?? 1.0;
      const rawProduction =
        1 * gameHoursElapsed * seasonMult + econ.productionRemainder;
      const wholeUnits = Math.floor(rawProduction);
      const remainder = rawProduction - wholeUnits;

      await ctx.db.patch(econ._id, { productionRemainder: remainder });

      if (wholeUnits > 0) {
        const newInventory = addInventoryItem(
          econ.inventory,
          "food_raw",
          wholeUnits,
          now,
        );
        await ctx.db.patch(econ._id, { inventory: newInventory });
        // Update local reference
        econ.inventory = newInventory;
        econ.productionRemainder = remainder;
      }
    } else if (job === "bartender") {
      // Convert food_raw to drinks: 2 food_raw -> 4 drinks
      const available = getInventoryCount(econ, "food_raw");
      const batches = Math.floor(available / 2);
      if (batches > 0) {
        let inv = removeInventoryItem(econ.inventory, "food_raw", batches * 2);
        inv = addInventoryItem(inv, "drink", batches * 4, now);
        await ctx.db.patch(econ._id, { inventory: inv });
        econ.inventory = inv;
      }
    } else if (job === "doctor" || job === "medical_assistant") {
      // Produce medicine slowly
      const rawProduction =
        0.5 * gameHoursElapsed + econ.productionRemainder;
      const wholeUnits = Math.floor(rawProduction);
      const remainder = rawProduction - wholeUnits;

      await ctx.db.patch(econ._id, { productionRemainder: remainder });

      if (wholeUnits > 0) {
        const newInventory = addInventoryItem(
          econ.inventory,
          "medicine",
          wholeUnits,
          now,
        );
        await ctx.db.patch(econ._id, { inventory: newInventory });
        econ.inventory = newInventory;
        econ.productionRemainder = remainder;
      }
    } else if (job === "baker") {
      // Convert food_raw to food_prepared: 1 food_raw -> 2 food_prepared
      const available = getInventoryCount(econ, "food_raw");
      if (available > 0) {
        let inv = removeInventoryItem(econ.inventory, "food_raw", available);
        inv = addInventoryItem(inv, "food_prepared", available * 2, now);
        await ctx.db.patch(econ._id, { inventory: inv });
        econ.inventory = inv;
      }
    }
    // Other jobs: no production
  }

  // ========== 2. PAYDAY ==========
  const minPaydayIntervalHours = CONFIG.ECONOMY.MIN_PAYDAY_INTERVAL_HOURS;

  for (const agent of agents) {
    const econ = econByAgent.get(agent._id as string);
    if (!econ) continue;

    // Check if it's end of work shift
    const workEnd = agent.schedule.workEnd;
    // Consider payday if current hour matches workEnd (or just passed it)
    if (currentHour < workEnd || currentHour > workEnd + 1) continue;

    // Check lastPayday interval.
    // 1 tick = 1 real second = tickSpeed game minutes.
    // So 1 game hour = 60/tickSpeed real seconds = 60000/tickSpeed real ms.
    // N game hours = N * 60000 / tickSpeed real ms.
    const minPaydayIntervalMs =
      (minPaydayIntervalHours * 60 * 1000) / world.tickSpeed;

    if (econ.lastPayday !== 0 && now - econ.lastPayday < minPaydayIntervalMs) {
      continue;
    }

    // Pay salary
    const newMoney = econ.money + econ.salary;
    await ctx.db.patch(econ._id, {
      money: newMoney,
      lastPayday: now,
    });
    econ.money = newMoney;
    econ.lastPayday = now;

    // Log transaction
    await ctx.db.insert("economyTransactions", {
      fromAgent: null,
      toAgent: agent._id,
      amount: econ.salary,
      reason: "salary",
      itemsExchanged: null,
      locationId: agent.workplace,
      timestamp: now,
    });
  }

  // ========== 3. SHOP TRANSACTIONS ==========
  // Preload locations for shop lookups
  const locationCache = new Map<string, Doc<"locations">>();

  for (const agent of agents) {
    const action = agent.currentAction as any;
    if (!action || action.type !== "shopping") continue;

    const buyerEcon = econByAgent.get(agent._id as string);
    if (!buyerEcon) continue;

    const shopId = action.shopId as Id<"locations">;
    if (!shopId) continue;

    // Get shop location
    let shopLocation = locationCache.get(shopId as string);
    if (!shopLocation) {
      const loc = await ctx.db.get(shopId);
      if (!loc) continue;
      shopLocation = loc;
      locationCache.set(shopId as string, loc);
    }

    // Find shop owner's economy record
    if (!shopLocation.owner) continue;
    const ownerEcon = econByAgent.get(shopLocation.owner as string);
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
      await ctx.db.patch(ownerEcon._id, {
        inventory: newOwnerInv,
        money: ownerEcon.money + sellerReceives,
      });
      ownerEcon.inventory = newOwnerInv;
      ownerEcon.money = ownerEcon.money + sellerReceives;

      // Update buyer
      await ctx.db.patch(buyerEcon._id, {
        inventory: newBuyerInv,
        money: buyerEcon.money - price,
      });
      buyerEcon.inventory = newBuyerInv;
      buyerEcon.money = buyerEcon.money - price;

      // Add tax to world taxPool
      await ctx.db.patch(world._id, {
        taxPool: world.taxPool + tax,
      });
      world.taxPool = world.taxPool + tax;

      // Log transaction
      await ctx.db.insert("economyTransactions", {
        fromAgent: agent._id,
        toAgent: shopLocation.owner,
        amount: price,
        reason: `purchase:${item}`,
        itemsExchanged: [{ itemId: item, quantity: 1 }],
        locationId: shopId,
        timestamp: now,
      });

      // Log to activity feed (purchases are notable)
      await ctx.db.insert("activityLog", {
        type: "economy",
        message: `${agent.name} bought ${item} for ${price} coins`,
        agentIds: [agent._id, shopLocation.owner],
        timestamp: now,
        realTimestamp: now,
      });
    }
  }

  // ========== 4. DAILY EXPENSES (on day change) ==========
  if (dayChanged) {
    const { min, max } = CONFIG.ECONOMY.DAILY_EXPENSES;

    for (const econ of allEcon) {
      const expense = Math.floor(Math.random() * (max - min + 1)) + min;
      const newMoney = Math.max(0, econ.money - expense);
      await ctx.db.patch(econ._id, {
        money: newMoney,
        dailyExpenses: expense,
      });
      econ.money = newMoney;
    }
  }

  // ========== 5. MONEY SUPPLY BALANCER (on day change) ==========
  if (dayChanged) {
    const totalMoney = allEcon.reduce((sum: number, e: { money: number }) => sum + e.money, 0);
    const targetTotal =
      agents.length * CONFIG.ECONOMY.TARGET_PER_CAPITA_MONEY;
    const ratio = targetTotal > 0 ? totalMoney / targetTotal : 1;

    if (ratio > CONFIG.ECONOMY.INFLATION_THRESHOLD) {
      // Inflation detected - soft check for v1, just log
      await ctx.db.insert("activityLog", {
        type: "economy",
        message: `Money supply check: inflation detected (ratio ${ratio.toFixed(2)}). Total: ${totalMoney}, target: ${targetTotal}`,
        agentIds: [],
        timestamp: now,
        realTimestamp: now,
      });
    } else if (ratio < CONFIG.ECONOMY.DEFLATION_THRESHOLD) {
      // Deflation detected - soft check for v1, just log
      await ctx.db.insert("activityLog", {
        type: "economy",
        message: `Money supply check: deflation detected (ratio ${ratio.toFixed(2)}). Total: ${totalMoney}, target: ${targetTotal}`,
        agentIds: [],
        timestamp: now,
        realTimestamp: now,
      });
    }
  }
}
