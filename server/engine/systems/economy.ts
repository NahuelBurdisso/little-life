import { db } from '../../db';
import { agents, economy, economyTransactions, worldState, worldEvents, locations, agentStates, shared_knowledge } from '../../db/schema';
import { logActivity } from '../../lib/activityLogger';
import { eq, and } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import type { Season } from '../../lib/types';
import { emitter } from '../emitter';
import { createFact } from '../../lib/gossip';
import { isFood, getRecipeForJob, getMarketPrice, getCheapestFoodPrice, getInventoryCount, addToInventory, removeFromInventory, getTradeRuleForLocation, setEventPriceModifiers, getEventProductionMultiplier } from '../../lib/economyEngine';
import { SEASON_PRODUCTION_MODIFIERS, TRADE_RULES, ITEM_REGISTRY } from '../../data/economyData';
import { simEvents } from '../../lib/simEvents';
import { getReputationPriceModifier } from '../../lib/reputationEngine';
import { aggregateEventEffects } from '../../data/worldEventCatalog';
import { gameMinutes, isOpenAt } from '../../lib/gameClock';
import { getAgentStates } from '../../lib/states';
import {
  dailyUpkeep, stipendFor, wagePayer, balancerMultipliers, treasuryExcess, savingsAllowance,
  upkeepRamp, lateStartTreasury, UPKEEP_RAMP_NIGHTS,
} from '../../lib/townTreasury';

// --- Module-level state for batching and milestones ---

const productionThisTick = new Map<number, { item: string; qty: number }>();

// Set by the day-change balancer, read by the next night's settlement and by
// every sale's tax. Per world: resetMoneySupplyState (worldCaches.ts).
let dailyUpkeepMultiplier = 1.0;
let dailyTaxRateMultiplier = 1.0;

/**
 * Residents who needed the stipend last night. Falling onto it is the "money
 * trouble" moment (financial fact + distress memory); staying on it is not
 * news every night.
 */
const onStipend = new Set<number>();

/** Drop the balancer's multipliers and the stipend roll for a world replace. */
export function resetMoneySupplyState(): void {
  dailyUpkeepMultiplier = 1.0;
  dailyTaxRateMultiplier = 1.0;
  onStipend.clear();
}

/** The money per resident the balancer steers this world to. */
export function worldMoneyTarget(world: Pick<typeof worldState.$inferSelect, 'money_target_per_capita'>): number {
  return world.money_target_per_capita ?? CONFIG.ECONOMY.TARGET_PER_CAPITA_MONEY;
}

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
  mealThisAction.clear();
  pantryMealDay.clear();
}

// --- Meals ---

/**
 * Where the food of one eating action came from.
 * - `bought`    served by a food vendor (shop, bakery, tavern) and paid for
 * - `own_stock` a vendor's owner eating a unit of their own stock
 * - `own_food`  a food item from the eater's inventory (groceries, own harvest)
 * - `pantry`    the starvation safety net: no food, no money (or starving) —
 *               see pantryMealDay below
 * - `ration`    the jail feeds its prisoners (they can't go anywhere to eat)
 */
export type MealSource = 'bought' | 'own_stock' | 'own_food' | 'pantry' | 'ration';
export interface Meal {
  source: MealSource;
  /** Where the meal was had (null outdoors); location services only feed you where you ate. */
  locationId: number | null;
  item: string | null;
}

/**
 * agentId → the meal of their current eating action, keyed like purchases
 * (`eating:action_started`). One eating action is one meal: it is served (and
 * paid for, or an item consumed) once, then feeds the agent for the rest of the
 * action. Needs used to restore hunger for anyone "eating" — and a home's
 * `hunger` service fed anyone standing in it — whether or not there was any
 * food, so nobody ever had to buy any (G2).
 */
const mealThisAction = new Map<number, { actionKey: string; meal: Meal }>();

/**
 * agentId → game day of their last pantry meal. The pantry is the no-deaths
 * guarantee, not a free lunch: once per game day, only at home, only for someone
 * who is broke or already starving. Starvation needs 72 game hours at hunger 0
 * without a break (lifeEventsEngine), so one meal a day is enough to rule it out,
 * and the mood penalty plus the missing home-service bonus keep it strictly worse
 * than buying food.
 */
const pantryMealDay = new Map<number, number>();

export const PANTRY_MOOD_PENALTY = -5;
export const PANTRY_MOOD_MINUTES = 180;

/**
 * The food item a meal from this inventory consumes: `preferred` (a service's
 * `itemRequired`, e.g. a home kitchen wants `food_raw`) when held, else the
 * cheapest food held — bread or a prepared meal from the shop feeds you at home
 * just as well. Items in `keep` (the eater's own production inputs: the
 * baker's food_raw is tomorrow's bread) are eaten only when nothing else is.
 */
function pickFood(
  inventory: readonly { itemId: string; quantity: number }[],
  preferred: string | null,
  keep: ReadonlySet<string> = new Set(),
): string | null {
  const foods = inventory.filter((i) => i.quantity > 0 && isFood(i.itemId));
  const spare = foods.filter((i) => !keep.has(i.itemId));
  const pool = spare.length > 0 ? spare : foods;
  if (preferred && pool.some((i) => i.itemId === preferred)) return preferred;
  pool.sort((a, b) => ITEM_REGISTRY[a.itemId].basePrice - ITEM_REGISTRY[b.itemId].basePrice);
  return pool[0]?.itemId ?? null;
}

/** Items the agent's job consumes (a baker's food_raw), kept back from meals. */
function productionInputs(job: string): ReadonlySet<string> {
  return new Set(Object.keys(getRecipeForJob(job)?.inputs ?? {}));
}

type LocationRow = typeof locations.$inferSelect;
type ServiceRow = NonNullable<LocationRow['services']>[number];

/** A location's hunger service (the menu, at a vendor; the kitchen, at home). */
export function hungerService(loc: Pick<LocationRow, 'services'>): ServiceRow | null {
  return (loc.services ?? []).find((s) => s.needSatisfied === 'hunger') ?? null;
}

/**
 * What a meal at this vendor would be right now: the food item it uses and the
 * price. Null when the location sells no food or the kitchen is out.
 *
 * The item comes from the owner's stock — the items the vendor `sells` first,
 * then any other food it holds as ingredients (a tavern restocks `food_raw` it
 * never sold, E3). The price is the location's hunger-service `cost` (the menu
 * price of a served meal), moved by the same season/supply/event factors as
 * that item's market price; a vendor with no priced hunger service charges the
 * item's market price. Reputation applies last, as for any purchase.
 */
export function quoteMeal(
  loc: Pick<LocationRow, 'type' | 'services'>,
  ownerEcon: Pick<EconRecord, 'inventory'>,
  season: string,
  buyerId: number,
): { item: string; price: number } | null {
  const rule = getTradeRuleForLocation(loc.type);
  if (!rule) return null;
  const inv = ownerEcon.inventory;
  const item = findMealItem(rule.sells, ownerEcon)
    ?? pickFood(inv.filter((i) => rule.buys.includes(i.itemId)), null);
  if (!item) return null;
  const stock = getInventoryCount(inv, item);
  const market = getMarketPrice(item, season, stock);
  const service = hungerService(loc);
  const base = service && service.cost > 0
    ? service.cost * (market / ITEM_REGISTRY[item].basePrice)
    : market;
  return { item, price: Math.max(1, Math.round(base * getReputationPriceModifier(buyerId))) };
}

/**
 * Serve (or look up) the meal of an agent's current eating action. Idempotent
 * per action; needs.ts calls it before deciding whether eating restores hunger,
 * and economyTick calls it again (a restock or payday earlier in the tick can
 * turn a "no meal yet" into a meal). Returns null — and records nothing, so the
 * next tick retries — when there is nothing to eat: a vendor out of stock or
 * unaffordable, no food held, and no pantry meal left.
 *
 * Order: a food vendor serves first (bought, or own stock for its owner); then
 * the eater's own food, anywhere; then the pantry. A bought meal is eaten on the
 * spot — it used to be dropped into the buyer's inventory and never eaten (E4).
 */
export function serveMeal(
  world: typeof worldState.$inferSelect,
  agent: { id: number; name: string; home: number | null; action_started: number },
  location: LocationRow | null,
  econByAgent: Map<number, EconRecord>,
  opts: { hunger?: number; critical?: number; now?: number } = {},
): Meal | null {
  const actionKey = `eating:${agent.action_started}`;
  const cached = mealThisAction.get(agent.id);
  if (cached && cached.actionKey === actionKey) return cached.meal;

  const eaterEcon = econByAgent.get(agent.id);
  if (!eaterEcon) return null;
  const now = opts.now ?? Date.now();
  const season = world.time!.season as string;
  const serve = (meal: Meal): Meal => {
    mealThisAction.set(agent.id, { actionKey, meal });
    // Once per meal (the cache above makes later calls return early). The soak
    // counts pantry meals from this; nothing in the sim listens.
    simEvents.emit('economy:meal', { agentId: agent.id, source: meal.source, money: eaterEcon.money });
    return meal;
  };

  // 1. A food vendor — while it is open (someone lingering past closing time
  // used to be served).
  if (location?.owner != null && (location.owner === agent.id || isOpenAt(location.operating_hours, world.time!.hour))) {
    const ownerEcon = econByAgent.get(location.owner);
    const quote = ownerEcon ? quoteMeal(location, ownerEcon, season, agent.id) : null;
    if (ownerEcon && quote) {
      // The owner eating in their own shop used to "buy" from themselves:
      // money went round in a circle minus tax, and the feed got a purchase
      // line. They just eat one unit of their own stock — no sale, no tax,
      // no ledger row, no feed line.
      if (location.owner === agent.id) {
        consumeItem(ownerEcon, quote.item);
        return serve({ source: 'own_stock', locationId: location.id, item: quote.item });
      }
      if (eaterEcon.money >= quote.price) {
        consumeItem(ownerEcon, quote.item);
        recordSale(world, agent, eaterEcon, location.owner, ownerEcon, quote.price, {
          reason: `purchase:${quote.item}`,
          items: [{ itemId: quote.item, quantity: 1 }],
          feedItem: quote.item,
          memoryItem: quote.item,
        }, location, now);
        return serve({ source: 'bought', locationId: location.id, item: quote.item });
      }
    }
  }

  // 2. Own food — at home that is cooking your groceries; elsewhere a packed lunch.
  const preferred = location ? hungerService(location)?.itemRequired ?? null : null;
  const food = pickFood(eaterEcon.inventory, preferred, productionInputs(eaterEcon.job));
  if (food) {
    consumeItem(eaterEcon, food);
    return serve({ source: 'own_food', locationId: location?.id ?? null, item: food });
  }

  // 3. Prison rations. An arrested agent is held in the cell for up to 48 game
  // hours and can reach neither a shop nor their pantry; unfed, a sentence was
  // most of the 72-hour starvation clock.
  if (location?.type === 'prison' && getAgentStates(agent.id).includes('arrested')) {
    return serve({ source: 'ration', locationId: location.id, item: null });
  }

  // 4. The pantry safety net.
  const day = world.time!.day;
  if (location != null && location.id === agent.home
    && pantryWouldServe(agent.id, eaterEcon.money, opts.hunger, day, opts.critical)) {
    pantryMealDay.set(agent.id, day);
    return serve({ source: 'pantry', locationId: location.id, item: null });
  }

  return null;
}

/**
 * Would the pantry feed this agent today (at home)? Broke — can't afford the
 * cheapest food — or starving, and not used yet this game day. `critical` is
 * the agent's own threshold (needs.thresholds.critical), the same one the
 * decision engine's hunger emergency uses, so "starving" means one thing.
 */
export function pantryWouldServe(
  agentId: number,
  money: number,
  hunger: number | undefined,
  day: number,
  critical: number = CONFIG.NEEDS.THRESHOLDS.critical,
): boolean {
  if (pantryMealDay.get(agentId) === day) return false;
  const broke = money < getCheapestFoodPrice();
  const starving = hunger !== undefined && hunger < critical;
  return broke || starving;
}

/**
 * What one visit to this venue costs a patron: the tavern-style cover from
 * TRADE_RULES, else the dearest priced non-food service it offers (the Dive's
 * $3 fun, the pawnshop's $2, the clinic's $12 energy). Food is paid per meal
 * (serveMeal). Zero for free places.
 */
export function visitFee(venue: Pick<LocationRow, 'type' | 'services'>): number {
  const cover = getTradeRuleForLocation(venue.type)?.entertainmentCost ?? 0;
  if (cover > 0) return cover;
  let fee = 0;
  for (const svc of venue.services ?? []) {
    if (svc.needSatisfied !== 'hunger' && svc.cost > fee) fee = svc.cost;
  }
  return fee;
}

/**
 * A visit fee at a venue nobody owns: paid to the town (tax pool), with the
 * same ledger row and feed line as a sale, minus a seller.
 */
function chargeTownFee(
  world: typeof worldState.$inferSelect,
  patron: { id: number; name: string },
  patronEcon: EconRecord,
  fee: number,
  venue: { id: number; name: string; type: string },
  now: number,
): void {
  db.update(economy).set({ money: patronEcon.money - fee }).where(eq(economy.id, patronEcon.id)).run();
  patronEcon.money -= fee;
  db.update(worldState).set({ tax_pool: world.tax_pool + fee }).where(eq(worldState.id, world.id)).run();
  world.tax_pool += fee;
  db.insert(economyTransactions).values({
    from_agent: patron.id,
    to_agent: null,
    amount: fee,
    reason: `entertainment:${venue.type}`,
    items_exchanged: null,
    location_id: venue.id,
    timestamp: now,
  }).run();
  logActivity({
    type: 'purchase',
    initiator: patron.id,
    location: venue.id,
    templateData: { agent: patron.name, item: `a visit to ${venue.name}`, amount: fee },
  });
  simEvents.emit('economy:purchase', { agentId: patron.id, item: `a visit to ${venue.name}`, price: fee, locationName: venue.name });
  checkMilestone(patron.id, patronEcon.money);
}

function consumeItem(econ: EconRecord, item: string): void {
  const inv = removeFromInventory(econ.inventory, item, 1);
  db.update(economy).set({ inventory: inv }).where(eq(economy.id, econ.id)).run();
  econ.inventory = inv;
}

/**
 * Has this agent paid to be at this venue on the current visit? Paid non-food
 * services (the tavern's `fun`) only entertain patrons who paid the cover.
 */
export function hasPaidVisit(agentId: number, locationId: number): boolean {
  return venueVisitPaid.get(agentId) === locationId;
}

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
function findMealItem(sells: readonly string[], ownerEcon: Pick<typeof economy.$inferSelect, 'inventory'>): string | null {
  for (const item of sells) {
    if (ITEM_REGISTRY[item]?.satisfies?.need !== 'hunger') continue;
    if (getInventoryCount(ownerEcon.inventory, item) > 0) return item;
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
  const newOwnerInv = removeFromInventory(ownerEcon.inventory, item, 1);
  const newBuyerInv = addToInventory(buyerEcon.inventory, item, 1, now);
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
  // To the cent, not the dollar: `Math.round(price * 0.05)` is 0 for every
  // price under $10 — i.e. every sale in town — so no sales tax was ever
  // collected (E2). Money and tax_pool are REAL columns.
  const tax = Math.round(price * CONFIG.ECONOMY.TAX_RATE * dailyTaxRateMultiplier * 100) / 100;
  const sellerReceives = Math.round((price - tax) * 100) / 100;

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

/**
 * TRADE_RULES entries in the order their shops restock: types whose owner turns
 * food into more food (the baker: 1 food_raw → 2 bread) first, the rest in
 * registry order. See the supply-chain step of economyTick.
 */
export function wholesaleBuyerOrder(
  allLocations: readonly Pick<LocationRow, 'type' | 'owner'>[],
  econByAgent: Map<number, Pick<EconRecord, 'job'>>,
): [string, (typeof TRADE_RULES)[string]][] {
  const processesFood = (locType: string) => allLocations.some((l) => {
    if (l.type !== locType || l.owner == null) return false;
    const recipe = getRecipeForJob(econByAgent.get(l.owner)?.job ?? '');
    return !!recipe?.inputs && isFood(recipe.output);
  });
  return Object.entries(TRADE_RULES)
    .sort(([a], [b]) => Number(processesFood(b)) - Number(processesFood(a)));
}

/**
 * Whole units in an accumulated production total. Per-tick increments like
 * 4/60 don't add up exactly in floating point (fifteen of them are 0.99999…),
 * so a plain floor lost a unit every few hours — a third of a 4x baker's
 * output in a 3-hour test. The epsilon absorbs that drift.
 */
function wholeUnitsOf(total: number): number {
  return Math.floor(total + 1e-9);
}

// --- Treasury settlement ---

/**
 * Decide, once per world, whether the treasury loop is starting late. A world made with the loop
 * (it stores a money target) needs nothing. An old save (no stored target) whose ledger has never
 * seen an `upkeep` row gets two things: an opening reserve like a new town's, so wages don't
 * drive the pool negative before the first midnight, and a few nights of eased-in lifestyle upkeep
 * (`upkeepRamp`), so its first settlements don't take 60% of everyone's savings at once. The verdict
 * is stored in `world_state.treasury_ramp_left` (NULL = not decided), so a restart doesn't redo it.
 * Returns the ramp nights left.
 */
export function ensureTreasuryLoopStarted(
  world: typeof worldState.$inferSelect,
  residents: number,
): number {
  if (world.treasury_ramp_left != null) return world.treasury_ramp_left;
  const ranBefore = world.money_target_per_capita != null
    || db.select({ id: economyTransactions.id }).from(economyTransactions)
      .where(eq(economyTransactions.reason, 'upkeep')).limit(1).get() != null;
  const left = ranBefore ? 0 : UPKEEP_RAMP_NIGHTS;
  const patch: Partial<typeof worldState.$inferInsert> = { treasury_ramp_left: left };
  if (!ranBefore) {
    const pool = lateStartTreasury(world.tax_pool, residents, CONFIG.ECONOMY.TREASURY_START_PER_CAPITA);
    if (pool !== world.tax_pool) {
      patch.tax_pool = Math.round(pool * 100) / 100;
      world.tax_pool = patch.tax_pool;
    }
  }
  db.update(worldState).set(patch).where(eq(worldState.id, world.id)).run();
  world.treasury_ramp_left = left;
  return left;
}

/**
 * The day-change half of the treasury loop (server/lib/townTreasury.ts):
 * every active resident pays upkeep into the treasury, then anyone left below
 * the stipend floor is topped up from it. Replaces the flat $9 living cost that
 * was burned (and was charged to dead residents' empty accounts too).
 *
 * One ledger row per payment (`upkeep`, `town:stipend`, treasury side null)
 * and one feed line naming the stipend recipients: the town looking after its
 * poorest is part of the story; the daily upkeep is not.
 */
export function settleTreasury(
  world: typeof worldState.$inferSelect,
  activeAgents: readonly (typeof agents.$inferSelect)[],
  econByAgent: Map<number, EconRecord>,
  now: number,
): void {
  const { UPKEEP, STIPEND_FLOOR } = CONFIG.ECONOMY;
  const allowance = savingsAllowance(worldMoneyTarget(world), UPKEEP.ALLOWANCE_OF_TARGET);
  let pool = world.tax_pool;
  const rampLeft = world.treasury_ramp_left ?? 0;
  const ramp = upkeepRamp(rampLeft);
  const ledger = (from: number | null, to: number | null, amount: number, reason: string) =>
    db.insert(economyTransactions).values({
      from_agent: from, to_agent: to, amount, reason, items_exchanged: null, location_id: null, timestamp: now,
    }).run();

  for (const agent of activeAgents) {
    const econ = econByAgent.get(agent.id);
    if (!econ) continue;
    const upkeep = dailyUpkeep(econ.money, {
      base: UPKEEP.BASE, allowance, rate: UPKEEP.LIFESTYLE_RATE,
      multiplier: dailyUpkeepMultiplier, ramp,
    });
    econ.money = Math.round((econ.money - upkeep) * 100) / 100;
    pool += upkeep;
    db.update(economy).set({ money: econ.money, daily_expenses: upkeep }).where(eq(economy.id, econ.id)).run();
    if (upkeep > 0) ledger(agent.id, null, upkeep, 'upkeep');
    checkMilestone(agent.id, econ.money);
  }

  const helped: string[] = [];
  let paidOut = 0;
  for (const agent of activeAgents) {
    const econ = econByAgent.get(agent.id);
    if (!econ) continue;
    const stipend = stipendFor(econ.money, STIPEND_FLOOR);
    if (stipend <= 0) {
      onStipend.delete(agent.id);
      continue;
    }
    // Money trouble is news the night someone falls onto the stipend. It used
    // to fire every night anyone ended under $10 after the living costs — and
    // before the stipend topped them up.
    if (!onStipend.has(agent.id)) {
      onStipend.add(agent.id);
      createFact('financial', agent.id, null, 1, [agent.id], 'observed');
      simEvents.emit('economy:distress', { agentId: agent.id });
    }
    econ.money = Math.round((econ.money + stipend) * 100) / 100;
    pool -= stipend;
    paidOut += stipend;
    db.update(economy).set({ money: econ.money }).where(eq(economy.id, econ.id)).run();
    ledger(null, agent.id, stipend, 'town:stipend');
    checkMilestone(agent.id, econ.money);
    helped.push(agent.name);
  }

  // Money that came from outside the loop (player gifts, shoplifting, an old
  // save's minted inflation) ends up here via the upkeep; above the cap it is
  // retired so the pool can't grow without bound. A diagnostic, not a story.
  const retired = treasuryExcess(pool, activeAgents.length, CONFIG.ECONOMY.TREASURY_CAP_PER_CAPITA);
  if (retired > 0) {
    pool -= retired;
    console.log(`[economy] treasury over its cap: retired $${retired.toFixed(2)}`);
  }

  pool = Math.round(pool * 100) / 100;
  const nextRamp = Math.max(0, rampLeft - 1);
  db.update(worldState).set({ tax_pool: pool, ...(rampLeft > 0 ? { treasury_ramp_left: nextRamp } : {}) })
    .where(eq(worldState.id, world.id)).run();
  world.tax_pool = pool;
  world.treasury_ramp_left = rampLeft > 0 ? nextRamp : world.treasury_ramp_left;

  if (helped.length > 0) {
    const names = helped.length === 1 ? helped[0]
      : `${helped.slice(0, -1).join(', ')} and ${helped[helped.length - 1]}`;
    logActivity({
      type: 'system',
      templateData: { message: `The town paid a stipend to ${names} ($${Math.round(paidOut)}) so no one goes hungry` },
    });
  }
}

// --- Main tick ---

export function economyTick(): void {
  const world = db.select().from(worldState).get();
  if (!world) return;

  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  // Before the first wage of a late-starting loop is paid (it draws on the pool).
  ensureTreasuryLoopStarted(world, activeAgents.length);
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
    (t) => t.type === 'day_changed',
  );

  // Location cache for shop lookups
  const locationCache = new Map<number, typeof locations.$inferSelect>();

  // ========== 1. PRODUCTION (data-driven) ==========
  for (const agent of activeAgents) {
    const action = agent.current_action;
    if (!action || action.type !== 'working') continue;

    const econ = econByAgent.get(agent.id);
    if (!econ) continue;
    if (!agent.workplace || agent.current_location !== agent.workplace) continue;

    const recipe = getRecipeForJob(econ.job);
    if (!recipe) continue;

    if (recipe.inputs) {
      // Processing job: convert inputs to outputs at `recipe.rate` batches per
      // game hour, with the same fractional accumulator as raw production. It
      // used to run one batch per TICK, ignoring the rate, so output depended on
      // tick speed: a stocked baker could bake 60 batches a game hour at 1x but
      // only 15 at 4x.
      //
      // And not past what the shop can hold: a bartender turned every food_raw
      // the tavern restocked into drinks nobody bought (19 in stock after two
      // soak days) and the tavern restocked more — once meals had to be real
      // food (G2) that sink starved the town.
      if (getInventoryCount(econ.inventory, recipe.output) >= WHOLESALE_STOCK_TARGET) {
        // Idle time is not banked: a full shelf doesn't earn a burst later.
        if (econ.production_remainder !== 0) {
          db.update(economy).set({ production_remainder: 0 }).where(eq(economy.id, econ.id)).run();
          econ.production_remainder = 0;
        }
        continue;
      }
      const progress = recipe.rate * gameHoursElapsed + econ.production_remainder;
      const whole = wholeUnitsOf(progress);
      let batches = whole;
      for (const [inputItem, inputQty] of Object.entries(recipe.inputs)) {
        batches = Math.min(batches, Math.floor(getInventoryCount(econ.inventory, inputItem) / inputQty));
      }
      // Batches the inputs couldn't cover are dropped, not banked — only the
      // fraction toward the next batch carries over (so no ingredients means no
      // pent-up burst when a delivery arrives).
      const remainder = Math.max(0, progress - whole);
      if (remainder !== econ.production_remainder) {
        db.update(economy).set({ production_remainder: remainder }).where(eq(economy.id, econ.id)).run();
        econ.production_remainder = remainder;
      }
      if (batches <= 0) continue;

      let inv = econ.inventory;
      for (const [inputItem, inputQty] of Object.entries(recipe.inputs)) {
        inv = removeFromInventory(inv, inputItem, inputQty * batches);
      }
      const made = recipe.outputQuantity * batches;
      inv = addToInventory(inv, recipe.output, made, now);
      db.update(economy).set({ inventory: inv }).where(eq(economy.id, econ.id)).run();
      econ.inventory = inv;

      const prevProc = productionThisTick.get(agent.id) ?? { item: recipe.output, qty: 0 };
      prevProc.qty += made;
      productionThisTick.set(agent.id, prevProc);
    } else {
      // Raw production: rate-based with seasonal modifier and remainder
      const seasonMult = recipe.seasonal ? (SEASON_PRODUCTION_MODIFIERS[season] ?? 1.0) : 1.0;
      const eventMult = getEventProductionMultiplier();
      const rawProduction = recipe.rate * gameHoursElapsed * seasonMult * eventMult + econ.production_remainder;
      const wholeUnits = wholeUnitsOf(rawProduction);
      const remainder = Math.max(0, rawProduction - wholeUnits);

      db.update(economy).set({ production_remainder: remainder }).where(eq(economy.id, econ.id)).run();
      econ.production_remainder = remainder;

      if (wholeUnits > 0) {
        const outputQuantity = wholeUnits * recipe.outputQuantity;
        const newInv = addToInventory(econ.inventory, recipe.output, outputQuantity, now);
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
  //
  // Food processors buy first. TRADE_RULES order let the shop take every unit
  // of farm surplus, so the bakery — which turns 1 food_raw into 2 bread — sat
  // idle from day 2 of every soak once meals had to be real food (G2): the same
  // harvest fed half as many people.
  for (const [locType, rules] of wholesaleBuyerOrder(allLocations, econByAgent)) {
    if (rules.buys.length === 0) continue;

    for (const loc of allLocations) {
      if (loc.type !== locType || !loc.owner) continue;
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

          const agentStock = getInventoryCount(agentEcon.inventory, buyItem);
          const surplus = agentStock - 3;
          if (surplus <= 0) continue;

          const shopStock = getInventoryCount(ownerEcon.inventory, buyItem);
          const room = WHOLESALE_STOCK_TARGET - shopStock;
          if (room <= 0) continue;
          const price = getMarketPrice(buyItem, season, shopStock);
          if (price <= 0) continue;
          const buyAmount = Math.min(surplus, room, Math.floor(restockBudget / price));
          if (buyAmount <= 0) continue;

          const totalCost = price * buyAmount;
          restockBudget -= totalCost;

          const newProducerInv = removeFromInventory(agentEcon.inventory, buyItem, buyAmount);
          const newShopInv = addToInventory(ownerEcon.inventory, buyItem, buyAmount, now);

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
  // `economy.last_payday` is GAME MINUTES (`gameMinutes(world.time)`). It used
  // to be Date.now() compared against "6 hours" converted to real ms by
  // assuming one tick per real second — wrong whenever a tick isn't a second
  // (the loop runs every TICK_INTERVAL_MS / tick_speed) or the game is paused.
  const minPaydayIntervalMinutes = CONFIG.ECONOMY.MIN_PAYDAY_INTERVAL_HOURS * 60;
  const nowGameMinute = gameMinutes(world.time!);

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
      const meta = alcoholicState.metadata ?? {};
      if (meta.stage === 3) {
        effectiveSalary = Math.floor(econ.salary * 0.6);
      } else {
        effectiveSalary = Math.floor(econ.salary * 0.7);
      }
    }
    // Who pays (E1): wages used to be minted here. Staff of someone else's
    // business are paid from that owner's till; everyone else by the town
    // treasury, which the daily upkeep refills (settleTreasury below).
    const workplace = agent.workplace != null ? allLocations.find((l) => l.id === agent.workplace) : undefined;
    const payer = wagePayer({
      agentId: agent.id,
      workplaceOwner: workplace?.owner,
      workplaceIsBusiness: !!workplace && !!TRADE_RULES[workplace.type],
      employerCash: workplace?.owner != null && activeAgents.some((a) => a.id === workplace.owner)
        ? econByAgent.get(workplace.owner)?.money
        : undefined,
      wage: effectiveSalary,
      employerFloor: CONFIG.ECONOMY.EMPLOYER_CASH_FLOOR,
    });
    if (payer.kind === 'employer') {
      const employerEcon = econByAgent.get(payer.employerId)!;
      db.update(economy).set({ money: employerEcon.money - effectiveSalary }).where(eq(economy.id, employerEcon.id)).run();
      employerEcon.money -= effectiveSalary;
      checkMilestone(payer.employerId, employerEcon.money);
    } else {
      db.update(worldState).set({ tax_pool: world.tax_pool - effectiveSalary }).where(eq(worldState.id, world.id)).run();
      world.tax_pool -= effectiveSalary;
    }

    const newMoney = econ.money + effectiveSalary;
    db.update(economy).set({
      money: newMoney,
      last_payday: nowGameMinute,
    }).where(eq(economy.id, econ.id)).run();
    econ.money = newMoney;
    econ.last_payday = nowGameMinute;

    // Log transaction (from_agent null = the treasury)
    db.insert(economyTransactions).values({
      from_agent: payer.kind === 'employer' ? payer.employerId : null,
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
    const action = agent.current_action;
    if (!action) continue;

    // A meal not served yet (vendor restocked by wholesale this tick, payday
    // landed mid-meal): needs.ts already asked this tick; ask again now.
    // A meal is whatever the item data says feeds you: `satisfies.need ===
    // 'hunger'` (food_raw, food_prepared, bread). There used to be a fallback to
    // "any item the shop sells", which charged someone eating at the clinic for
    // medicine and a tavern diner for a drink when the kitchen was out.
    if (action.type === 'eating') {
      let eatLocation: typeof locations.$inferSelect | null = null;
      if (agent.current_location != null) {
        eatLocation = locationCache.get(agent.current_location)
          ?? allLocations.find((l) => l.id === agent.current_location) ?? null;
        if (eatLocation) locationCache.set(eatLocation.id, eatLocation);
      }
      serveMeal(world, agent, eatLocation, econByAgent, { now });
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
      if (getInventoryCount(buyerEcon.inventory, item) >= SHOPPING_STOCK_TARGET) {
        handled.add(item);
        continue;
      }

      // Out of stock / unaffordable stay unhandled, so a restock or payday
      // later in the same trip can still complete the purchase (once).
      const shopStock = getInventoryCount(ownerEcon.inventory, item);
      if (shopStock <= 0) continue;

      // Get price (modified by buyer's reputation)
      const price = Math.round(getMarketPrice(item, season, shopStock) * getReputationPriceModifier(agent.id));
      if (buyerEcon.money < price) continue;

      sellOneItem(world, agent, buyerEcon, shopLocation.owner, ownerEcon, item, price, shopLocation, now);
      handled.add(item);
    }
  }

  // ========== 3b. VENUE VISITS: cover charge / service fee ==========
  // Taverns had no patron income once eating stopped passing drinks off as meals
  // (no recipe makes the food_prepared a tavern sells). Their TRADE_RULES
  // `entertainmentCost` was defined but never charged; it is now the cover, paid
  // once per visit by patrons (not the owner, not staff whose workplace it is).
  // A drink in stock is poured as part of it, consumed from the owner's stock.
  //
  // Every other venue with a priced non-food service charges that price the
  // same way, once per visit (visitFee): needs.ts only lets a priced service
  // work on someone who paid (or the owner, or off-shift staff). Before this,
  // the Dive, the pawnshop and the clinic's paid services worked on nobody.
  // An ownerless venue (nobody in town works the Dive) is run by the town: the
  // fee goes to the tax pool.
  for (const agent of activeAgents) {
    const at = agent.current_location;
    const paidAt = venueVisitPaid.get(agent.id);
    if (paidAt !== undefined && paidAt !== at) venueVisitPaid.delete(agent.id);
    if (at == null || venueVisitPaid.has(agent.id)) continue;

    const actionType = agent.current_action?.type;
    if (!PATRON_ACTIONS.has(actionType)) continue;

    const venue = locationCache.get(at) ?? allLocations.find((l) => l.id === at);
    if (!venue) continue;
    locationCache.set(at, venue);
    const fee = visitFee(venue);
    if (fee <= 0 || !isOpenAt(venue.operating_hours, currentHour)) continue;
    if (venue.owner === agent.id || agent.workplace === at) continue;

    const patronEcon = econByAgent.get(agent.id);
    if (!patronEcon) continue;
    // Can't pay: not charged yet, retried next tick (payday can land mid-visit).
    if (patronEcon.money < fee) continue;

    if (venue.owner == null) {
      chargeTownFee(world, agent, patronEcon, fee, venue, now);
      venueVisitPaid.set(agent.id, at);
      continue;
    }
    const ownerEcon = econByAgent.get(venue.owner);
    if (!ownerEcon) continue;

    const isCover = (getTradeRuleForLocation(venue.type)?.entertainmentCost ?? 0) > 0;
    const pours = isCover && getInventoryCount(ownerEcon.inventory, 'drink') > 0;
    if (pours) {
      const newInv = removeFromInventory(ownerEcon.inventory, 'drink', 1);
      db.update(economy).set({ inventory: newInv }).where(eq(economy.id, ownerEcon.id)).run();
      ownerEcon.inventory = newInv;
    }
    recordSale(world, agent, patronEcon, venue.owner, ownerEcon, fee, {
      reason: `entertainment:${venue.type}`,
      items: pours ? [{ itemId: 'drink', quantity: 1 }] : null,
      feedItem: pours ? `a drink at ${venue.name}` : isCover ? `a night out at ${venue.name}` : `a visit to ${venue.name}`,
      memoryItem: pours ? 'a drink' : isCover ? 'a night out' : `a visit to ${venue.name}`,
    }, venue, now);
    venueVisitPaid.set(agent.id, at);
  }

  // ========== 4. TREASURY SETTLEMENT (on day change) ==========
  if (dayChanged) settleTreasury(world, activeAgents, econByAgent, now);

  // ========== 5. MONEY SUPPLY BALANCER (on day change) ==========
  // With wages paid out of the treasury the daily cycle no longer creates
  // money. The multiplier set here steers tomorrow night's lifestyle share
  // (balancerMultipliers), which holds the ratio near 1; the crisis events
  // below (ratio > 2) now answer money that really entered from outside the
  // loop — player gifts, an old inflated save — instead of firing in every
  // soak from day 4.
  if (dayChanged) {
    // Residents only. The dead keep an economy row at $0: counted, they
    // dragged the ratio down; picked as "the poorest", a robbery moved cash
    // into an account nobody would ever spend.
    const activeIds = new Set(activeAgents.map((a) => a.id));
    const residentEcon = allEcon.filter((e) => activeIds.has(e.agent_id));
    const totalMoney = residentEcon.reduce((sum, e) => sum + e.money, 0);
    const targetTotal = activeAgents.length * worldMoneyTarget(world);
    const ratio = targetTotal > 0 ? totalMoney / targetTotal : 1;

    const mult = balancerMultipliers(ratio);
    dailyUpkeepMultiplier = mult.upkeep;
    dailyTaxRateMultiplier = mult.tax;

    // Savings visibly shrinking needs a reason on screen. Only when the pull
    // is strong (ratio ≥ ~1.15): normal nights sit near 1 and say nothing.
    if (mult.upkeep >= 1.5) {
      logActivity({
        type: 'system',
        templateData: {
          message: `There is more money in town than it needs (${Math.round((ratio - 1) * 100)}% over): upkeep on savings is up, and the well-off will see theirs shrink`,
        },
      });
    }

    // ── ECONOMIC CRISIS EVENTS (ratio > 2.0) ──
    if (ratio > 2.0) {
      const sortedByWealth = [...residentEcon].sort((a, b) => b.money - a.money);
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
              templateData: { description: `${poorAgent.name} stole $${stolen} from ${richAgent.name} during the economic crisis` }, metadata: { beat: 'theft' } });
            simEvents.emit('economy:theft', { thief: poorest.agent_id, victim: richest.agent_id, amount: stolen });
          }
        }
      } else if (crisisRoll < 0.45) {
        // EMERGENCY TAX: government seizes % from everyone
        const taxRate = 0.05 + Math.random() * 0.10; // 5-15%
        let totalSeized = 0;
        for (const econ of residentEcon) {
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
                templateData: { description: `${agent.name} lost $${lost} to a traveling scammer` }, metadata: { beat: 'theft' } });
              simEvents.emit('economy:scam', { agentId: target.agent_id, amount: lost });
            }
          }
        }
      } else if (crisisRoll < 0.75) {
        // PRICE GOUGING: random agent hoards and everyone pays more next day
        dailyUpkeepMultiplier *= 1.5;
        const hoarder = sortedByWealth[Math.floor(Math.random() * Math.min(3, sortedByWealth.length))];
        const hoarderAgent = activeAgents.find(a => a.id === hoarder?.agent_id);
        if (hoarderAgent) {
          logActivity({ type: 'drama', initiator: hoarder.agent_id,
            templateData: { description: `${hoarderAgent.name} is hoarding supplies — prices spike across town` }, metadata: { beat: 'misdeed' } });
          createFact('hoarding', hoarder.agent_id, null, 1, [hoarder.agent_id], 'observed');
        }
      }
      // else: no crisis event this day (25% chance of reprieve)
    }

    // ── EXTREME INFLATION DRAIN (ratio > 3.0): money literally rots ──
    if (ratio > 3.0) {
      const rotRate = Math.min(0.15, (ratio - 3.0) * 0.05); // 5-15% wealth decay
      for (const econ of residentEcon) {
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
    for (const id of mealThisAction.keys()) {
      if (!activeIds.has(id)) mealThisAction.delete(id);
    }
    for (const id of pantryMealDay.keys()) {
      if (!activeIds.has(id)) pantryMealDay.delete(id);
    }
  }

  emitter.markDirty('agents.all');
}
