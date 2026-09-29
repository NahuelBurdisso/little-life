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
import { aggregateEventEffects } from '../../data/worldEventCatalog';

// --- Module-level state for batching and milestones ---

const productionThisTick = new Map<number, { item: string; qty: number }>();

let dailyLivingCostMultiplier = 1.0;
let dailyTaxRateMultiplier = 1.0;

const lastMilestoneLevel = new Map<number, number>();

/** Drop per-agent wealth-milestone tracking for a world replace (agent ids are reused). */
export function clearMilestoneTracking(): void {
  lastMilestoneLevel.clear();
}
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

// --- Per-action purchase tracking ---

/**
 * agentId → what the agent already bought during its current action. The key
 * is `type:action_started` (plus the shop for a shopping trip): decisions and
 * movement stamp `action_started` each time they (re)issue an action, so a new
 * meal or a new trip — even at the same shop — starts with a clean slate, while
 * the ticks of one action share it. A meal is NOT keyed on the location: one
 * eating action is one meal, even if the agent is nudged elsewhere mid-meal.
 * In memory only: after a server restart an agent mid-meal may pay once more.
 */
const purchasesThisAction = new Map<number, { actionKey: string; handled: Set<string> }>();

/** Drop per-action purchase tracking for a world replace (agent ids and ticks restart). */
export function clearPurchaseTracking(): void {
  purchasesThisAction.clear();
  venueVisitPaid.clear();
}

/** Sentinel in the handled set for "this eating action has paid for its meal". */
const MEAL = '__meal__';

// --- Tavern visits ---

/**
 * agentId -> the venue (tavern) whose cover charge they already paid on this
 * visit. A visit is continuous presence: the entry is dropped the first tick
 * the agent is anywhere else. Keyed on the stay rather than the action on
 * purpose: an evening out is socializing -> talking -> idle -> eating, each a
 * fresh `action_started`, and a per-action key would charge the cover 3-4
 * times for one night.
 */
const venueVisitPaid = new Map<number, number>();

/** Actions that make someone a patron (staff at work don't pay the cover). */
const PATRON_ACTIONS = new Set(['socializing', 'idle', 'talking', 'eating']);

/** Wholesale stops restocking an item once the shop holds this many. */
export const WHOLESALE_STOCK_TARGET = 10;
/** Share of the owner's cash one tick's restock may spend, at most. */
export const WHOLESALE_MAX_CASH_FRACTION = 0.5;

/** A shopping trip skips an item the buyer already holds this many of. */
const SHOPPING_STOCK_TARGET = 2;

/** First item in `sells` that is a meal per ITEM_REGISTRY and that the shop has in stock. */
function findMealItem(sells: readonly string[], ownerEcon: typeof economy.$inferSelect): string | null {
  for (const item of sells) {
    if (ITEM_REGISTRY[item]?.satisfies?.need !== 'hunger') continue;
    if (getInventoryCount(ownerEcon.inventory as any[], item) > 0) return item;
  }
  return null;
}

function purchasesFor(agentId: number, actionKey: string): Set<string> {
  const entry = purchasesThisAction.get(agentId);
  if (entry && entry.actionKey === actionKey) return entry.handled;
  const fresh = { actionKey, handled: new Set<string>() };
  purchasesThisAction.set(agentId, fresh);
  return fresh.handled;
}

// --- Helpers ---

type EconRecord = typeof economy.$inferSelect;

/**
 * Move one unit of `item` from the shop owner to the buyer at `price`, then
 * record the sale. Mutates the cached econ rows so later steps of this tick
 * see the new state.
 */
function sellOneItem(
  world: typeof worldState.$inferSelect,
  buyer: { id: number; name: string },
  buyerEcon: EconRecord,
  ownerId: number,
  ownerEcon: EconRecord,
  item: string,
  price: number,
  location: { id: number; name: string },
  now: number,
): void {
  const newOwnerInv = removeFromInventory(ownerEcon.inventory as any[], item, 1);
  const newBuyerInv = addToInventory(buyerEcon.inventory as any[], item, 1, now);
  db.update(economy).set({ inventory: newOwnerInv }).where(eq(economy.id, ownerEcon.id)).run();
  ownerEcon.inventory = newOwnerInv;
  db.update(economy).set({ inventory: newBuyerInv }).where(eq(economy.id, buyerEcon.id)).run();
  buyerEcon.inventory = newBuyerInv;

  recordSale(world, buyer, buyerEcon, ownerId, ownerEcon, price, {
    reason: `purchase:${item}`,
    items: [{ itemId: item, quantity: 1 }],
    feedItem: item,
    memoryItem: item,
  }, location, now);
}

/**
 * The money side of any sale to a shop owner: buyer pays `price`, the owner
 * gets it minus tax, the tax goes to the town pool, and the sale is written to
 * the ledger, the activity feed (`purchase`) and `economy:purchase`.
 */
function recordSale(
  world: typeof worldState.$inferSelect,
  buyer: { id: number; name: string },
  buyerEcon: EconRecord,
  ownerId: number,
  ownerEcon: EconRecord,
  price: number,
  what: {
    reason: string;
    items: { itemId: string; quantity: number }[] | null;
    feedItem: string;
    memoryItem: string;
  },
  location: { id: number; name: string },
  now: number,
): void {
  const tax = Math.round(price * CONFIG.ECONOMY.TAX_RATE * dailyTaxRateMultiplier);
  const sellerReceives = price - tax;

  db.update(economy).set({ money: ownerEcon.money + sellerReceives }).where(eq(economy.id, ownerEcon.id)).run();
  ownerEcon.money += sellerReceives;

  db.update(economy).set({ money: buyerEcon.money - price }).where(eq(economy.id, buyerEcon.id)).run();
  buyerEcon.money -= price;

  db.update(worldState).set({
    tax_pool: world.tax_pool + tax,
  }).where(eq(worldState.id, world.id)).run();
  world.tax_pool += tax;

  db.insert(economyTransactions).values({
    from_agent: buyer.id,
    to_agent: ownerId,
    amount: price,
    reason: what.reason,
    items_exchanged: what.items,
    location_id: location.id,
    timestamp: now,
  }).run();

  logActivity({
    type: 'purchase',
    initiator: buyer.id,
    target: ownerId,
    location: location.id,
    templateData: { agent: buyer.name, item: what.feedItem, amount: price },
  });
  simEvents.emit('economy:purchase', { agentId: buyer.id, item: what.memoryItem, price, locationName: location.name });
  checkMilestone(buyer.id, buyerEcon.money);
}

// --- Main tick ---

export function economyTick(): void {
  const world = db.select().from(worldState).get();
  if (!world) return;

  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const allEcon = db.select().from(economy).all();
  const activeEvents = db.select().from(worldEvents).where(eq(worldEvents.is_active, true)).all();
  const allLocations = db.select().from(locations).all();

  const eventEffects = aggregateEventEffects(activeEvents.map((e) => e.effects));
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
  // Owners used to buy every unit of producer surplus they could afford, every
  // tick, with no stock cap — spending their whole till on stock that a handful
  // of diners a day never drew down. Now a shop only restocks an item up to
  // WHOLESALE_STOCK_TARGET, and never spends more than WHOLESALE_MAX_CASH_FRACTION
  // of the cash it had when this tick's restock began.
  for (const [locType, rules] of Object.entries(TRADE_RULES)) {
    if (rules.buys.length === 0) continue;

    for (const loc of allLocations) {
      if ((loc as any).type !== locType || !loc.owner) continue;
      const ownerEcon = econByAgent.get(loc.owner);
      if (!ownerEcon) continue;
      let restockBudget = ownerEcon.money * WHOLESALE_MAX_CASH_FRACTION;

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
          const room = WHOLESALE_STOCK_TARGET - shopStock;
          if (room <= 0) continue;
          const price = getMarketPrice(buyItem, season, shopStock);
          if (price <= 0) continue;
          const buyAmount = Math.min(surplus, room, Math.floor(restockBudget / price));
          if (buyAmount <= 0) continue;

          const totalCost = price * buyAmount;
          restockBudget -= totalCost;

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
  // `economy.last_payday` is GAME MINUTES (day*1440 + hour*60 + minute). It used
  // to be Date.now() compared against "6 hours" converted to real ms by
  // assuming one tick per real second — wrong whenever a tick isn't a second
  // (the loop runs every TICK_INTERVAL_MS / tick_speed) or the game is paused.
  const minPaydayIntervalMinutes = CONFIG.ECONOMY.MIN_PAYDAY_INTERVAL_HOURS * 60;
  const nowGameMinute = world.time!.day * 1440 + world.time!.hour * 60 + world.time!.minute;

  for (const agent of activeAgents) {
    const econ = econByAgent.get(agent.id);
    if (!econ) continue;

    // Check if it's end of work shift
    const workEnd = agent.schedule.workEnd;
    // Consider payday if current hour matches workEnd (or just passed it)
    if (currentHour < workEnd || currentHour > workEnd + 1) continue;

    // Check lastPayday interval. 0 = never paid. A stamp AHEAD of the clock is a
    // wall-clock ms value from a save made before the switch to game minutes
    // (~1.7e12); treat it as "long ago" so those agents get their next payday
    // instead of never being paid again.
    const last = econ.last_payday;
    if (last !== 0 && last <= nowGameMinute && nowGameMinute - last < minPaydayIntervalMinutes) {
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
      last_payday: nowGameMinute,
    }).where(eq(economy.id, econ.id)).run();
    econ.money = newMoney;
    econ.last_payday = nowGameMinute;

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
  // Process both explicit 'shopping' actions and 'eating' at shop/tavern locations.
  // Both used to buy EVERY tick for as long as the action lasted: a 20-tick meal
  // at the shop was 20 "purchase food_raw" lines, and a playtest saw Dr. Sofia buy
  // 23 items in a row until she hit $0. Purchases are now tracked per action (see
  // purchasesThisAction): one meal per eating action, one of each item per trip.
  for (const agent of activeAgents) {
    const action = agent.current_action as any;
    if (!action) continue;

    // Auto-purchase food when eating at a shop or tavern
    if (action.type === 'eating' && agent.current_location != null) {
      const handled = purchasesFor(agent.id, `eating:${agent.action_started}`);
      if (handled.has(MEAL)) continue;

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

          // A meal is whatever the item data says feeds you: `satisfies.need ===
          // 'hunger'` (food_raw, food_prepared, bread). There used to be a
          // fallback to "any item the shop sells", which charged someone eating at
          // the clinic for medicine and a tavern diner for a drink when the kitchen
          // was out — a drink satisfies `fun`, not hunger, so it isn't a meal.
          const itemToBuy = findMealItem(tradeRule.sells, ownerEcon);
          // No meal in stock, or unaffordable: leave the meal unpaid for now and
          // retry next tick — restocking (wholesale) or payday can land mid-meal.
          if (!itemToBuy) { continue; }

          // The owner eating in their own shop used to "buy" from themselves:
          // money went round in a circle minus tax, and the feed got a purchase
          // line. They just eat one unit of their own stock — no sale, no tax,
          // no ledger row, no feed line.
          if (eatLocation.owner === agent.id) {
            const newInv = removeFromInventory(ownerEcon.inventory as any[], itemToBuy, 1);
            db.update(economy).set({ inventory: newInv }).where(eq(economy.id, ownerEcon.id)).run();
            ownerEcon.inventory = newInv;
            handled.add(MEAL);
            continue;
          }

          const shopStock = getInventoryCount(ownerEcon.inventory as any[], itemToBuy);
          const price = Math.round(getMarketPrice(itemToBuy, season, shopStock) * getReputationPriceModifier(agent.id));
          if (buyerEcon.money < price) { continue; }

          sellOneItem(world, agent, buyerEcon, eatLocation.owner, ownerEcon, itemToBuy, price, eatLocation, now);
          handled.add(MEAL);
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

    // Find shop owner's economy record. Shopping in your own shop is a no-op:
    // the stock is already yours (same self-purchase loop as eating, above).
    if (!shopLocation.owner || shopLocation.owner === agent.id) continue;
    const ownerEcon = econByAgent.get(shopLocation.owner);
    if (!ownerEcon) continue;

    const handled = purchasesFor(agent.id, `shopping:${agent.action_started}:${shopId}`);
    // A Set so a list that names an item twice still buys it once per trip.
    const items = new Set<string>(action.items ?? []);

    for (const item of items) {
      if (handled.has(item)) continue;

      // Only buy what's needed: someone already carrying a couple of this item
      // doesn't restock it. Marked handled so it isn't re-checked all trip.
      if (getInventoryCount(buyerEcon.inventory as any[], item) >= SHOPPING_STOCK_TARGET) {
        handled.add(item);
        continue;
      }

      // Out of stock / unaffordable stay unhandled, so a restock or payday
      // later in the same trip can still complete the purchase (once).
      const shopStock = getInventoryCount(ownerEcon.inventory as any[], item);
      if (shopStock <= 0) continue;

      // Get price (modified by buyer's reputation)
      const price = Math.round(getMarketPrice(item, season, shopStock) * getReputationPriceModifier(agent.id));
      if (buyerEcon.money < price) continue;

      sellOneItem(world, agent, buyerEcon, shopLocation.owner, ownerEcon, item, price, shopLocation, now);
      handled.add(item);
    }
  }

  // ========== 3b. TAVERN VISITS: cover charge ==========
  // Taverns had no patron income once eating stopped passing drinks off as meals
  // (no recipe makes the food_prepared a tavern sells). Their TRADE_RULES
  // `entertainmentCost` was defined but never charged; it is now the cover, paid
  // once per visit by patrons (not the owner, not staff whose workplace it is).
  // A drink in stock is poured as part of it, consumed from the owner's stock.
  for (const agent of activeAgents) {
    const at = agent.current_location;
    const paidAt = venueVisitPaid.get(agent.id);
    if (paidAt !== undefined && paidAt !== at) venueVisitPaid.delete(agent.id);
    if (at == null || venueVisitPaid.has(agent.id)) continue;

    const actionType = (agent.current_action as any)?.type;
    if (!PATRON_ACTIONS.has(actionType)) continue;

    const venue = locationCache.get(at) ?? allLocations.find((l) => l.id === at);
    if (!venue) continue;
    locationCache.set(at, venue);
    const fee = getTradeRuleForLocation(venue.type)?.entertainmentCost ?? 0;
    if (fee <= 0 || !venue.owner) continue;
    if (venue.owner === agent.id || agent.workplace === at) continue;

    const patronEcon = econByAgent.get(agent.id);
    const ownerEcon = econByAgent.get(venue.owner);
    if (!patronEcon || !ownerEcon) continue;
    // Can't pay: not charged yet, retried next tick (payday can land mid-visit).
    if (patronEcon.money < fee) continue;

    const pours = getInventoryCount(ownerEcon.inventory as any[], 'drink') > 0;
    if (pours) {
      const newInv = removeFromInventory(ownerEcon.inventory as any[], 'drink', 1);
      db.update(economy).set({ inventory: newInv }).where(eq(economy.id, ownerEcon.id)).run();
      ownerEcon.inventory = newInv;
    }
    recordSale(world, agent, patronEcon, venue.owner, ownerEcon, fee, {
      reason: `entertainment:${venue.type}`,
      items: pours ? [{ itemId: 'drink', quantity: 1 }] : null,
      feedItem: pours ? `a drink at ${venue.name}` : `a night out at ${venue.name}`,
      memoryItem: pours ? 'a drink' : 'a night out',
    }, venue, now);
    venueVisitPaid.set(agent.id, at);
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

    // Diagnostics, not story: the player feed shows `system` rows, and a daily
    // "Money supply check: inflation detected (ratio 1.84)" there means nothing
    // to a spectator. The consequences the player should see (emergency tax,
    // scams, hyperinflation) log their own entries above.
    if (ratio > CONFIG.ECONOMY.INFLATION_THRESHOLD) {
      console.log(`[economy] money supply: inflation (ratio ${ratio.toFixed(2)}, total ${Math.round(totalMoney)}, target ${Math.round(targetTotal)})`);
    } else if (ratio < CONFIG.ECONOMY.DEFLATION_THRESHOLD) {
      console.log(`[economy] money supply: deflation (ratio ${ratio.toFixed(2)}, total ${Math.round(totalMoney)}, target ${Math.round(targetTotal)})`);
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
    for (const id of purchasesThisAction.keys()) {
      if (!activeIds.has(id)) purchasesThisAction.delete(id);
    }
  }

  emitter.markDirty('agents.all');
}
