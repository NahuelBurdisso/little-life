import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { db } from '../../../db';
import { activityLog, agents, economy, economyTransactions, locations, worldState } from '../../../db/schema';
import { and, eq, like } from 'drizzle-orm';
import { economyTick, clearPurchaseTracking } from '../economy';

/**
 * Playtest bug: eating at a shop bought one item EVERY tick of the meal, and a
 * shopping action bought its whole list every tick of the trip. Dr. Sofia bought
 * 23 items in a row until she hit $0; the feed got 20+ "purchase food_raw" lines.
 */

type Inv = { itemId: string; quantity: number; acquiredAt: number }[];

function ensureWorld(): void {
  // No pending transitions: day-change living costs and crisis events would
  // otherwise move the buyer's money under the test.
  const time = { day: 1, hour: 9, minute: 0, totalTicks: 1980, seasonDay: 1, season: 'spring' as const };
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
function scene(shopStock: Inv, buyerMoney = 100, buyerInv: Inv = []) {
  n++;
  const home = insertLocation(`purchase home ${n}`, 'home', null);
  const owner = insertAgent(`Shopkeeper ${n}`, home);
  const buyer = insertAgent(`Buyer ${n}`, home);
  const shop = insertLocation(`purchase shop ${n}`, 'shop', owner);
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
});
