import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { db } from '../../../db';
import { activityLog, agents, economy, economyTransactions, locations, worldState } from '../../../db/schema';
import { and, eq, like } from 'drizzle-orm';
import {
  economyTick,
  clearPurchaseTracking,
  WHOLESALE_STOCK_TARGET,
  WHOLESALE_MAX_CASH_FRACTION,
} from '../economy';

/**
 * Playtest bug: eating at a shop bought one item EVERY tick of the meal, and a
 * shopping action bought its whole list every tick of the trip. Dr. Sofia bought
 * 23 items in a row until she hit $0; the feed got 20+ "purchase food_raw" lines.
 */

type Inv = { itemId: string; quantity: number; acquiredAt: number }[];

function ensureWorld(day = 1, hour = 9, minute = 0): void {
  // No pending transitions: day-change living costs and crisis events would
  // otherwise move the buyer's money under the test.
  const totalTicks = day * 1440 + hour * 60 + minute;
  const time = { day, hour, minute, totalTicks, seasonDay: 1, season: 'spring' as const };
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, pending_transitions: [], tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time,
    day_phase: 'morning',
    weather: 'sunny',
    weather_duration: 120,
    tick_speed: 1,
    is_paused: true,
    last_tick_completed: 0,
    current_tick_phase: 0,
    tick_id: 'test',
    pending_transitions: [],
    tax_pool: 0,
    map_width: 40,
    map_height: 30,
    collision_grid: '',
  }).run();
}

function insertLocation(name: string, type: string, owner: number | null): number {
  return db.insert(locations).values({
    name,
    type,
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 1, y: 4 },
    owner,
    capacity: 10,
    current_occupants: [],
    operating_hours: null,
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, home: number): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality: null,
    age: 30,
    gender: 'female',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 0, y: 0 },
    current_destination: null,
    current_location: home,
    current_action: { type: 'idle' },
    action_started: 0,
    action_duration: null,
    action_queue: [],
    current_path: null,
    // workEnd far from the world clock's 09:00 so payday never fires here.
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 18, workEnd: 20, lunchTime: 12, freeTimePreferences: [] },
    home,
    workplace: null,
    created_at: Date.now(),
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function insertEconomy(agentId: number, money: number, inventory: Inv): void {
  db.insert(economy).values({
    agent_id: agentId,
    job: 'unemployed', // no recipe: no production, no wholesale selling
    job_title: 'Test',
    salary: 0,
    work_performance: 0.5,
    money,
    daily_expenses: 0,
    inventory,
    last_payday: 0,
    production_remainder: 0,
  }).run();
}

const econ = (agentId: number) => db.select().from(economy).where(eq(economy.agent_id, agentId)).get()!;
const count = (agentId: number, item: string) =>
  (econ(agentId).inventory as Inv).find((i) => i.itemId === item)?.quantity ?? 0;

const purchasesBy = (agentId: number) =>
  db.select().from(economyTransactions).where(and(
    eq(economyTransactions.from_agent, agentId),
    like(economyTransactions.reason, 'purchase:%'),
  )).all();

const feedPurchasesBy = (agentId: number) =>
  db.select().from(activityLog).where(and(
    eq(activityLog.type, 'purchase'),
    eq(activityLog.initiator_id, agentId),
  )).all();

function setAction(agentId: number, action: Record<string, unknown>, startedAt: number, at: number): void {
  db.update(agents)
    .set({ current_action: action, action_started: startedAt, action_duration: 20, current_location: at })
    .where(eq(agents.id, agentId))
    .run();
}

function ticks(n: number): void {
  for (let i = 0; i < n; i++) economyTick();
}

let n = 0;
function scene(shopStock: Inv, buyerMoney = 100, buyerInv: Inv = [], shopType = 'shop') {
  n++;
  const home = insertLocation(`purchase home ${n}`, 'home', null);
  const owner = insertAgent(`Shopkeeper ${n}`, home);
  const buyer = insertAgent(`Buyer ${n}`, home);
  const shop = insertLocation(`purchase shop ${n}`, shopType, owner);
  insertEconomy(owner, 500, shopStock);
  insertEconomy(buyer, buyerMoney, buyerInv);
  return { owner, buyer, shop };
}

const stock = (items: Record<string, number>): Inv =>
  Object.entries(items).map(([itemId, quantity]) => ({ itemId, quantity, acquiredAt: 0 }));

describe('shop purchases', () => {
  beforeAll(() => ensureWorld());
  beforeEach(() => clearPurchaseTracking());

  it('a meal at the shop is paid for once, however many ticks it lasts', () => {
    const { buyer, shop, owner } = scene(stock({ food_raw: 50, bread: 50 }));
    setAction(buyer, { type: 'eating', locationId: shop }, 100, shop);

    ticks(30);

    const bought = purchasesBy(buyer);
    expect(bought).toHaveLength(1);
    expect(bought[0].to_agent).toBe(owner);
    expect(econ(buyer).money).toBe(100 - bought[0].amount);
    expect(feedPurchasesBy(buyer)).toHaveLength(1);
  });

  it('the next meal is a new purchase', () => {
    const { buyer, shop } = scene(stock({ food_raw: 50 }));
    setAction(buyer, { type: 'eating', locationId: shop }, 100, shop);
    ticks(10);
    setAction(buyer, { type: 'eating', locationId: shop }, 400, shop);
    ticks(10);

    expect(purchasesBy(buyer)).toHaveLength(2);
  });

  it('one eating action is one meal even if the agent ends up somewhere else', () => {
    const { buyer, shop } = scene(stock({ food_raw: 50 }));
    const other = scene(stock({ food_raw: 50 }));
    setAction(buyer, { type: 'eating', locationId: shop }, 100, shop);
    ticks(5);
    // Same action (same action_started), different shop.
    setAction(buyer, { type: 'eating', locationId: shop }, 100, other.shop);
    ticks(5);

    expect(purchasesBy(buyer)).toHaveLength(1);
  });

  it('pays once the shop restocks mid-meal, and only once', () => {
    const { buyer, shop, owner } = scene([]);
    setAction(buyer, { type: 'eating', locationId: shop }, 100, shop);
    ticks(5);
    expect(purchasesBy(buyer)).toHaveLength(0);

    db.update(economy).set({ inventory: stock({ bread: 10 }) }).where(eq(economy.agent_id, owner)).run();
    ticks(10);
    expect(purchasesBy(buyer)).toHaveLength(1);
  });

  it('a shopping trip buys each listed item once', () => {
    const { buyer, shop } = scene(stock({ food_raw: 50, bread: 50 }));
    setAction(buyer, { type: 'shopping', shopId: shop, items: ['bread', 'food_raw', 'bread'] }, 100, shop);

    ticks(20);

    const reasons = purchasesBy(buyer).map((t) => t.reason).sort();
    expect(reasons).toEqual(['purchase:bread', 'purchase:food_raw']);
    expect(count(buyer, 'bread')).toBe(1);
    expect(count(buyer, 'food_raw')).toBe(1);
    expect(feedPurchasesBy(buyer)).toHaveLength(2);
  });

  it('a shopping trip skips what the buyer already has enough of', () => {
    const { buyer, shop } = scene(stock({ food_raw: 50, bread: 50 }), 100, stock({ bread: 2 }));
    setAction(buyer, { type: 'shopping', shopId: shop, items: ['bread', 'food_raw'] }, 100, shop);

    ticks(20);

    expect(purchasesBy(buyer).map((t) => t.reason)).toEqual(['purchase:food_raw']);
    expect(count(buyer, 'bread')).toBe(2);
  });

  it('does not buy what the buyer cannot afford', () => {
    const { buyer, shop } = scene(stock({ food_raw: 50 }), 0);
    setAction(buyer, { type: 'eating', locationId: shop }, 100, shop);

    ticks(10);

    expect(purchasesBy(buyer)).toHaveLength(0);
    expect(econ(buyer).money).toBe(0);
  });

  it('eating at the clinic does not buy medicine', () => {
    const { buyer, shop } = scene(stock({ medicine: 10 }), 100, [], 'clinic');
    setAction(buyer, { type: 'eating', locationId: shop }, 100, shop);

    ticks(5);

    expect(purchasesBy(buyer)).toHaveLength(0);
    expect(econ(buyer).money).toBe(100);
  });

  it('a tavern meal is food, never a drink standing in for it', () => {
    // Drinks satisfy `fun`, not hunger — with the kitchen out there is no meal to buy.
    const dry = scene(stock({ drink: 10 }), 100, [], 'tavern');
    setAction(dry.buyer, { type: 'eating', locationId: dry.shop }, 100, dry.shop);
    ticks(5);
    expect(purchasesBy(dry.buyer)).toHaveLength(0);

    const fed = scene(stock({ drink: 10, food_prepared: 10 }), 100, [], 'tavern');
    setAction(fed.buyer, { type: 'eating', locationId: fed.shop }, 100, fed.shop);
    ticks(5);
    expect(purchasesBy(fed.buyer).map((t) => t.reason)).toEqual(['purchase:food_prepared']);
  });

  it('a shopkeeper eating in their own shop eats their stock without selling to themselves', () => {
    // A tavern, so wholesale from other files' producers (it buys drink/food_raw)
    // can't touch the food_prepared count under test. Money isn't asserted for
    // the same reason; the ledger is: a self-sale would be a purchase row.
    const { owner, shop } = scene(stock({ food_prepared: 10 }), 100, [], 'tavern');
    setAction(owner, { type: 'eating', locationId: shop }, 100, shop);

    ticks(10);

    expect(purchasesBy(owner)).toHaveLength(0);
    expect(feedPurchasesBy(owner)).toHaveLength(0);
    expect(count(owner, 'food_prepared')).toBe(9); // one meal, once
  });

  it('a shopkeeper shopping in their own shop buys nothing', () => {
    const { owner, shop } = scene(stock({ food_prepared: 1 }), 100, [], 'tavern');
    setAction(owner, { type: 'shopping', shopId: shop, items: ['food_prepared'] }, 100, shop);

    ticks(5);

    expect(purchasesBy(owner)).toHaveLength(0);
    expect(count(owner, 'food_prepared')).toBe(1);
  });
});

/**
 * `economy.last_payday` was Date.now() compared against 6 game hours converted to
 * real ms by assuming one tick per real second, so paydays depended on how fast
 * the game ran in real time. It is game minutes now.
 */
describe('payday interval', () => {
  const salaryRows = (agentId: number) =>
    db.select().from(economyTransactions).where(and(
      eq(economyTransactions.to_agent, agentId),
      eq(economyTransactions.reason, 'salary'),
    )).all();

  function worker(lastPayday = 0): number {
    n++;
    const home = insertLocation(`payday home ${n}`, 'home', null);
    const agent = insertAgent(`Worker ${n}`, home); // shift ends at 20:00
    insertEconomy(agent, 10, []);
    db.update(economy).set({ salary: 50, last_payday: lastPayday }).where(eq(economy.agent_id, agent)).run();
    return agent;
  }

  it('pays once per shift end and again the next game day, however fast real time runs', () => {
    const agent = worker();

    ensureWorld(3, 20, 0);
    economyTick();
    expect(salaryRows(agent)).toHaveLength(1);
    expect(econ(agent).last_payday).toBe(3 * 1440 + 20 * 60);

    // Still inside the 20:00-21:59 window: no second salary.
    ensureWorld(3, 21, 30);
    economyTick();
    expect(salaryRows(agent)).toHaveLength(1);

    // Next game day's shift end — milliseconds later in real time. The wall-clock
    // check wanted 6 real minutes to pass and skipped this payday.
    ensureWorld(4, 20, 0);
    economyTick();
    expect(salaryRows(agent)).toHaveLength(2);
    expect(econ(agent).money).toBe(110);
  });

  it('pays an agent whose last payday is a wall-clock stamp from an older save', () => {
    const agent = worker(Date.now());

    ensureWorld(5, 20, 0);
    economyTick();

    expect(salaryRows(agent)).toHaveLength(1);
    expect(econ(agent).last_payday).toBe(5 * 1440 + 20 * 60);
  });
});

/**
 * Wholesale used to buy every unit of producer surplus the owner could afford,
 * every tick, with no stock cap — the owner's whole till went on stock.
 */
describe('wholesale restock', () => {
  beforeAll(() => ensureWorld(6, 9, 0));

  function supplyScene(ownerMoney: number, shopFoodRaw: number) {
    n++;
    const home = insertLocation(`wholesale home ${n}`, 'home', null);
    const owner = insertAgent(`Grocer ${n}`, home);
    const farmer = insertAgent(`Farmer ${n}`, home);
    const shop = insertLocation(`wholesale shop ${n}`, 'shop', owner);
    insertEconomy(owner, ownerMoney, stock({ food_raw: shopFoodRaw }));
    insertEconomy(farmer, 0, stock({ food_raw: 200 }));
    // Idle farmer: a recipe that outputs food_raw makes them a supplier, and
    // not working means no production changes their stock under the test.
    db.update(economy).set({ job: 'farmer' }).where(eq(economy.agent_id, farmer)).run();
    return { owner, farmer, shop };
  }

  it('never spends more than the cash fraction in one tick', () => {
    const { owner } = supplyScene(40, 0);
    economyTick();
    const spent = 40 - econ(owner).money;
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThanOrEqual(40 * WHOLESALE_MAX_CASH_FRACTION);
  });

  it('stops restocking at the stock target', () => {
    const { owner } = supplyScene(1000, WHOLESALE_STOCK_TARGET - 3);
    for (let i = 0; i < 20; i++) economyTick();
    expect(count(owner, 'food_raw')).toBe(WHOLESALE_STOCK_TARGET);
  });

  it('buys nothing when already stocked', () => {
    const { owner } = supplyScene(1000, WHOLESALE_STOCK_TARGET);
    for (let i = 0; i < 5; i++) economyTick();
    expect(count(owner, 'food_raw')).toBe(WHOLESALE_STOCK_TARGET);
    expect(econ(owner).money).toBe(1000);
  });
});
