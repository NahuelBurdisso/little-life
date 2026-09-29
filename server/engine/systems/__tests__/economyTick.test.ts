import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { db } from '../../../db';
import { activityLog, agents, economy, economyTransactions, locations, worldState } from '../../../db/schema';
import { and, eq, inArray, like } from 'drizzle-orm';
import { CONFIG } from '../../../lib/constants';
import {
  economyTick,
  clearPurchaseTracking,
  WHOLESALE_STOCK_TARGET,
  WHOLESALE_MAX_CASH_FRACTION,
  wholesaleBuyerOrder,
  settleTreasury,
} from '../economy';
import { TRADE_RULES } from '../../../data/economyData';
import { simEvents } from '../../../lib/simEvents';

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

const coversBy = (agentId: number) =>
  db.select().from(economyTransactions).where(and(
    eq(economyTransactions.from_agent, agentId),
    like(economyTransactions.reason, 'entertainment:%'),
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
    // The tavern still earns: the cover charge (see 'tavern visits' below).
    expect(coversBy(dry.buyer)).toHaveLength(1);

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

/**
 * Taverns earned $0 from patrons once drinks stopped counting as meals. The
 * TRADE_RULES `entertainmentCost` is now a cover charge, once per visit.
 */
describe('tavern visits', () => {
  beforeAll(() => ensureWorld(7, 19, 0));
  beforeEach(() => clearPurchaseTracking());

  const COVER = TRADE_RULES.tavern.entertainmentCost;

  it('charges the cover once per visit, however many actions the evening has', () => {
    const { buyer, shop, owner } = scene(stock({ drink: 5 }), 100, [], 'tavern');

    setAction(buyer, { type: 'socializing', locationId: shop }, 100, shop);
    ticks(5);
    setAction(buyer, { type: 'talking' }, 105, shop);
    ticks(5);
    setAction(buyer, { type: 'idle' }, 110, shop);
    ticks(5);

    const covers = coversBy(buyer);
    expect(covers).toHaveLength(1);
    expect(covers[0]).toMatchObject({ to_agent: owner, amount: COVER, reason: 'entertainment:tavern' });
    expect(covers[0].items_exchanged).toEqual([{ itemId: 'drink', quantity: 1 }]);
    expect(econ(buyer).money).toBe(100 - COVER);
    // The drink came out of the owner's stock. (Owner money isn't asserted: the
    // tavern also restocks food_raw wholesale from the farmers seeded above.)
    expect(count(owner, 'drink')).toBe(4);

    const feed = feedPurchasesBy(buyer);
    expect(feed).toHaveLength(1);
    expect(String((feed[0].template_data as any).item)).toContain('a drink at');
  });

  it('a new visit after leaving is charged again', () => {
    const { buyer, shop } = scene(stock({ drink: 5 }), 100, [], 'tavern');
    const home = insertLocation(`tavern-goer home ${n}`, 'home', null);

    setAction(buyer, { type: 'socializing' }, 100, shop);
    ticks(3);
    setAction(buyer, { type: 'idle' }, 200, home);
    ticks(3);
    setAction(buyer, { type: 'socializing' }, 300, shop);
    ticks(3);

    expect(coversBy(buyer)).toHaveLength(2);
  });

  it('with no drink in stock the cover is still a night out', () => {
    const { buyer, shop } = scene([], 100, [], 'tavern');
    setAction(buyer, { type: 'socializing' }, 100, shop);
    ticks(3);

    const covers = coversBy(buyer);
    expect(covers).toHaveLength(1);
    expect(covers[0].items_exchanged).toBeNull();
    expect(String((feedPurchasesBy(buyer)[0].template_data as any).item)).toContain('a night out at');
  });

  it('owners, staff and people at work do not pay', () => {
    const { buyer, owner, shop } = scene(stock({ drink: 5 }), 100, [], 'tavern');
    const barmaid = insertAgent(`Barmaid ${n}`, shop);
    insertEconomy(barmaid, 100, []);
    db.update(agents).set({ workplace: shop }).where(eq(agents.id, barmaid)).run();

    setAction(owner, { type: 'socializing' }, 100, shop);
    setAction(barmaid, { type: 'idle' }, 100, shop);
    setAction(buyer, { type: 'working' }, 100, shop);
    ticks(3);

    expect(coversBy(owner)).toHaveLength(0);
    expect(coversBy(barmaid)).toHaveLength(0);
    expect(coversBy(buyer)).toHaveLength(0);
  });

  it('someone who cannot afford the cover is not charged', () => {
    const { buyer, shop } = scene(stock({ drink: 5 }), COVER - 1, [], 'tavern');
    setAction(buyer, { type: 'socializing' }, 100, shop);
    ticks(3);
    expect(coversBy(buyer)).toHaveLength(0);
    expect(econ(buyer).money).toBe(COVER - 1);
  });
});

/**
 * Once meals had to be real food (G2) the soak town ran out of it: the tavern
 * brewed every food_raw it restocked into drinks nobody bought, and the shop
 * took all farm surplus before the bakery (1 food_raw → 2 bread) got any.
 */
describe('food supply', () => {
  beforeAll(() => ensureWorld(8, 10, 0));

  it('a processor stops making output once the shop holds a full stock of it', () => {
    n++;
    const home = insertLocation(`brew home ${n}`, 'home', null);
    const barkeep = insertAgent(`Barkeep ${n}`, home);
    const tavern = insertLocation(`brew tavern ${n}`, 'tavern', barkeep);
    insertEconomy(barkeep, 0, stock({ drink: WHOLESALE_STOCK_TARGET, food_raw: 4 }));
    db.update(economy).set({ job: 'bartender' }).where(eq(economy.agent_id, barkeep)).run();
    db.update(agents).set({ workplace: tavern }).where(eq(agents.id, barkeep)).run();
    setAction(barkeep, { type: 'working' }, 100, tavern);

    // Watch production itself: wholesale may sell the drink surplus to other
    // files' taverns and restock food_raw, which would mask the counts.
    const made: string[] = [];
    const onMade = (p: { agentId: number; item: string }) => { if (p.agentId === barkeep) made.push(p.item); };
    simEvents.on('economy:production', onMade);
    try {
      ticks(1);
    } finally {
      simEvents.off('economy:production', onMade);
    }

    expect(made).toEqual([]);
  });

  /** Processing ran one batch per tick, ignoring recipe.rate: output tracked tick speed. */
  it.each([1, 4])('a baker bakes by rate per game hour, the same at %ix', (speed) => {
    n++;
    const home = insertLocation(`bake home ${n}`, 'home', null);
    const baker = insertAgent(`Baker ${n}`, home);
    const bakery = insertLocation(`bake bakery ${n}`, 'bakery', baker);
    insertEconomy(baker, 0, stock({ food_raw: 20 }));
    db.update(economy).set({ job: 'baker' }).where(eq(economy.agent_id, baker)).run();
    db.update(agents).set({ workplace: bakery }).where(eq(agents.id, baker)).run();
    setAction(baker, { type: 'working' }, 100, bakery);
    db.update(worldState).set({ tick_speed: speed }).run();

    // Count production events: wholesale may sell the bread on to other files' shops.
    let bread = 0;
    const onMade = (p: { agentId: number; item: string; quantity: number }) => {
      if (p.agentId === baker) bread += p.quantity;
    };
    simEvents.on('economy:production', onMade);
    try {
      ticks((3 * 60) / speed); // three game hours
    } finally {
      simEvents.off('economy:production', onMade);
      db.update(worldState).set({ tick_speed: 1 }).run();
    }

    // Baker recipe: rate 1.0 batch/h, 1 food_raw -> 2 bread.
    expect(bread).toBe(6);
  });

  it('the bakery restocks farm surplus before the shop and the tavern', () => {
    const locs = [
      { type: 'shop', owner: 1 },
      { type: 'tavern', owner: 2 },
      { type: 'bakery', owner: 3 },
    ];
    const jobs = new Map([[1, { job: 'shopkeeper' }], [2, { job: 'bartender' }], [3, { job: 'baker' }]]);
    const order = wholesaleBuyerOrder(locs, jobs).map(([type]) => type);
    expect(order[0]).toBe('bakery');
    // A drink is not food: the bartender's recipe earns the tavern no priority.
    expect(order.indexOf('shop')).toBeLessThan(order.indexOf('tavern'));
  });
});

/** E2: tax was `Math.round(price * 0.05)` — $0 for every sale under $10. */
describe('sales tax', () => {
  beforeAll(() => {
    ensureWorld(9, 10, 0);
    // Earlier scenes left diners and patrons mid-action; their sales would be
    // taxed into the same pool this tick.
    db.update(agents).set({ current_action: { type: 'idle' }, current_location: null }).run();
  });
  beforeEach(() => clearPurchaseTracking());

  it('taxes a small sale to the cent', () => {
    const { buyer, shop } = scene(stock({ food_raw: 50 }));
    const pool0 = db.select().from(worldState).get()!.tax_pool;
    setAction(buyer, { type: 'eating', locationId: shop }, 100, shop);
    ticks(1);

    const [sale] = purchasesBy(buyer);
    expect(sale.amount).toBeLessThan(10);
    const tax = Math.round(sale.amount * 0.05 * 100) / 100;
    expect(tax).toBeGreaterThan(0);
    expect(db.select().from(worldState).get()!.tax_pool).toBeCloseTo(pool0 + tax, 2);
  });
});

/**
 * E1: salaries were minted at shift end. They now come out of the treasury
 * (tax_pool), or out of the employer's till for staff of someone else's shop,
 * so a payday moves money instead of creating it.
 */
describe('who pays the wage', () => {
  const pool = () => db.select().from(worldState).get()!.tax_pool;

  function staffed(ownerMoney: number) {
    n++;
    const home = insertLocation(`wage home ${n}`, 'home', null);
    const owner = insertAgent(`Owner ${n}`, home);
    const clerk = insertAgent(`Clerk ${n}`, home); // shift ends at 20:00
    // A clinic: a business that buys no wholesale stock, so the till only moves by the wage.
    const shop = insertLocation(`wage clinic ${n}`, 'clinic', owner);
    insertEconomy(owner, ownerMoney, []);
    insertEconomy(clerk, 10, []);
    db.update(economy).set({ salary: 20 }).where(eq(economy.agent_id, clerk)).run();
    // The owner's own payday must not land in this tick.
    db.update(economy).set({ last_payday: 11 * 1440 + 20 * 60 }).where(eq(economy.agent_id, owner)).run();
    db.update(agents).set({ workplace: shop }).where(eq(agents.id, clerk)).run();
    return { owner, clerk, shop };
  }

  beforeAll(() => {
    ensureWorld(11, 19, 0);
    // Earlier scenes' workers share the 20:00 shift end; pay them first so this
    // block's paydays are the only ones in the ticks below.
    ensureWorld(11, 20, 0);
    economyTick();
  });

  it('a public wage comes out of the treasury', () => {
    n++;
    const home = insertLocation(`wage home ${n}`, 'home', null);
    const clerk = insertAgent(`Public servant ${n}`, home);
    insertEconomy(clerk, 10, []);
    db.update(economy).set({ salary: 25 }).where(eq(economy.agent_id, clerk)).run();
    const before = pool();

    economyTick();

    expect(econ(clerk).money).toBe(35);
    expect(pool()).toBeCloseTo(before - 25, 2);
  });

  it('staff of a shop are paid from the owner\'s till, not the treasury', () => {
    const { owner, clerk } = staffed(200);
    const before = pool();

    economyTick();

    expect(econ(clerk).money).toBe(30);
    expect(econ(owner).money).toBe(180);
    expect(pool()).toBeCloseTo(before, 2);
    const row = db.select().from(economyTransactions).where(and(
      eq(economyTransactions.to_agent, clerk), eq(economyTransactions.reason, 'salary'),
    )).get()!;
    expect(row.from_agent).toBe(owner);
  });

  it('the treasury covers staff when the till is too thin', () => {
    const { owner, clerk } = staffed(60);
    const before = pool();

    economyTick();

    expect(econ(clerk).money).toBe(30);
    expect(econ(owner).money).toBe(60);
    expect(pool()).toBeCloseTo(before - 20, 2);
  });
});

/** E1/E5: the nightly settlement — upkeep into the treasury, stipend out of it. */
describe('treasury settlement', () => {
  it('charges upkeep, tops the broke up to the floor, and creates no money', () => {
    ensureWorld(12, 0, 0);
    n++;
    const home = insertLocation(`settle home ${n}`, 'home', null);
    const rich = insertAgent(`Saver ${n}`, home);
    const poor = insertAgent(`Broke ${n}`, home);
    insertEconomy(rich, 160, []);
    insertEconomy(poor, 2, []);
    const world = db.select().from(worldState).get()!;
    const pool0 = world.tax_pool;
    const residents = db.select().from(agents).where(inArray(agents.id, [rich, poor])).all();
    const econByAgent = new Map([rich, poor].map((id) => [id, econ(id)]));

    settleTreasury(world, residents, econByAgent, 0);

    const { UPKEEP, STIPEND_FLOOR } = CONFIG.ECONOMY;
    const richUpkeep = UPKEEP.BASE + UPKEEP.LIFESTYLE_RATE * (160 - UPKEEP.SAVINGS_ALLOWANCE);
    expect(econ(rich).money).toBeCloseTo(160 - richUpkeep, 2);
    expect(econ(rich).daily_expenses).toBeCloseTo(richUpkeep, 2);
    // Paid the $2 they had, then topped up to the floor.
    expect(econ(poor).money).toBe(STIPEND_FLOOR);
    // Conservation: what the residents lost, the treasury gained.
    const pool1 = db.select().from(worldState).get()!.tax_pool;
    expect(pool1 + econ(rich).money + econ(poor).money).toBeCloseTo(pool0 + 162, 2);
    expect(db.select().from(economyTransactions).where(and(
      eq(economyTransactions.to_agent, poor), eq(economyTransactions.reason, 'town:stipend'),
    )).all()).toHaveLength(1);
    const feed = db.select().from(activityLog).where(eq(activityLog.type, 'system')).all()
      .map((r) => String((r.template_data as any)?.message ?? ''));
    expect(feed.some((m) => m.includes(`stipend to Broke ${n}`))).toBe(true);
  });
});
