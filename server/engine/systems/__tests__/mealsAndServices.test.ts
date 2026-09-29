import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { db } from '../../../db';
import { agents, agentStates, economy, economyTransactions, locations, needs, worldState } from '../../../db/schema';
import { and, eq, like } from 'drizzle-orm';
import { needsTick, serviceApplies } from '../needs';
import { clearPurchaseTracking, economyTick, PANTRY_MOOD_PENALTY } from '../economy';
import { chooseMealTarget, groceryList, checkEmergency, HUNGER_INTERRUPTS_WORK } from '../decisions';
import { CONFIG } from '../../../lib/constants';

/**
 * G2 (playtest #2): location services refilled needs for free. Every service of
 * a location applied to anyone standing in it, whatever they were doing, with
 * `itemRequired` ignored and `cost` never charged — homes fed their sleepers
 * +10 hunger/h, the shop fed its own clerks +15/h. Needs sat at 100, "eating"
 * was 6 of 611 samples and almost nothing was bought. And eating restored
 * hunger with no food at all. A meal now needs food: bought, or from the
 * agent's own inventory, or (broke or starving, once a day) the pantry.
 */

type Inv = { itemId: string; quantity: number; acquiredAt: number }[];
type Service = { needSatisfied: string; amount: number; cost: number; itemRequired: string | null };

const HOME_SERVICES: Service[] = [
  { needSatisfied: 'energy', amount: 8, cost: 0, itemRequired: null },
  { needSatisfied: 'comfort', amount: 5, cost: 0, itemRequired: null },
  { needSatisfied: 'hunger', amount: 10, cost: 0, itemRequired: 'food_raw' },
];
const SHOP_SERVICES: Service[] = [{ needSatisfied: 'hunger', amount: 15, cost: 6, itemRequired: null }];
const TAVERN_SERVICES: Service[] = [
  { needSatisfied: 'social', amount: 6, cost: 0, itemRequired: null },
  { needSatisfied: 'fun', amount: 8, cost: 4, itemRequired: null },
  { needSatisfied: 'hunger', amount: 8, cost: 5, itemRequired: null },
];

const DAY = 3;
function setClock(hour = 12, minute = 0, day = DAY): void {
  const time = { day, hour, minute, totalTicks: day * 1440 + hour * 60 + minute, seasonDay: 1, season: 'spring' as const };
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, pending_transitions: [], tick_speed: 1, weather: 'cloudy' }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time, day_phase: 'afternoon', weather: 'cloudy', weather_duration: 120, tick_speed: 1, is_paused: true,
    last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
    map_width: 40, map_height: 30, collision_grid: '',
  }).run();
}

let n = 0;
function loc(type: string, services: Service[], owner: number | null = null, x = 0, hours: { open: number; close: number } | null = null): number {
  n++;
  return db.insert(locations).values({
    name: `${type} ${n}`, type,
    position: { x, y: 0, width: 4, height: 4 }, entry_point: { x, y: 4 },
    owner, capacity: 10, current_occupants: [], operating_hours: hours, services, description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function agent(home: number, opts: { money?: number; inventory?: Inv; hunger?: number } = {}): number {
  n++;
  const id = db.insert(agents).values({
    name: `Eater ${n}`, bio: 'test', traits: [], personality: null, age: 30, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 }, current_destination: null,
    current_location: home, current_action: { type: 'idle' }, action_started: 0, action_duration: null,
    action_queue: [], current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, workplace: null, created_at: Date.now(), is_active: true,
  }).returning({ id: agents.id }).get().id;
  db.insert(needs).values({
    agent_id: id, hunger: opts.hunger ?? 50, energy: 50, social: 50, comfort: 50, fun: 50, mood: 50, stress: 20,
    decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES }, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
    mood_modifiers: [], last_updated: 0,
  }).run();
  db.insert(economy).values({
    agent_id: id, job: 'unemployed', job_title: 'Test', salary: 0, work_performance: 0.5,
    money: opts.money ?? 100, daily_expenses: 0, inventory: opts.inventory ?? [], last_payday: 0, production_remainder: 0,
  }).run();
  return id;
}

const stock = (items: Record<string, number>): Inv =>
  Object.entries(items).map(([itemId, quantity]) => ({ itemId, quantity, acquiredAt: 0 }));
const needsOf = (id: number) => db.select().from(needs).where(eq(needs.agent_id, id)).get()!;
const econOf = (id: number) => db.select().from(economy).where(eq(economy.agent_id, id)).get()!;
const count = (id: number, item: string) => (econOf(id).inventory as Inv).find((i) => i.itemId === item)?.quantity ?? 0;
const purchasesBy = (id: number) => db.select().from(economyTransactions)
  .where(and(eq(economyTransactions.from_agent, id), like(economyTransactions.reason, 'purchase:%'))).all();

function act(id: number, action: Record<string, unknown>, at: number | null, startedAt = 500): void {
  db.update(agents).set({ current_action: action, action_started: startedAt, action_duration: 60, current_location: at })
    .where(eq(agents.id, id)).run();
}
function setNeeds(id: number, values: Partial<Record<'hunger' | 'energy' | 'social' | 'comfort' | 'fun', number>>): void {
  db.update(needs).set(values).where(eq(needs.agent_id, id)).run();
}
function ticks(k: number): void {
  for (let i = 0; i < k; i++) needsTick();
}

describe('serviceApplies', () => {
  const eatingMods = { hunger: -4, energy: 0.8, social: 0.8, comfort: -0.3, fun: 0.9 };
  const workingMods = { hunger: 1.2, energy: 1.5, social: 0.9, comfort: 1.2, fun: 1.3 };
  const sleepingMods = { hunger: 0.5, energy: -2.3, social: 1, comfort: -0.5, fun: 0 };
  const socialMods = { hunger: 1, energy: 1.1, social: -3, comfort: -0.3, fun: -1.5 };
  const base = { agentId: 1, location: { id: 10, owner: 99 }, meal: null, inventory: [], paidVisit: false };
  const [energy, , homeHunger] = HOME_SERVICES;
  const shopHunger = SHOP_SERVICES[0];
  const tavernFun = TAVERN_SERVICES[1];

  it('needs an activity that restores that need there', () => {
    expect(serviceApplies(energy, { ...base, modifiers: sleepingMods })).toBe(true);
    expect(serviceApplies(energy, { ...base, modifiers: workingMods })).toBe(false);
  });

  it('social/fun reach a patron at leisure there, never staff at work', () => {
    const idleMods = { hunger: 0.8, energy: -0.5, social: 1, comfort: -1, fun: 1.2 };
    const tavernSocial = TAVERN_SERVICES[0];
    expect(serviceApplies(tavernSocial, { ...base, modifiers: idleMods, actionType: 'idle' })).toBe(true);
    expect(serviceApplies(tavernSocial, { ...base, modifiers: workingMods, actionType: 'working' })).toBe(false);
  });

  it('a shop clerk at work is not fed by the shop', () => {
    expect(serviceApplies(shopHunger, { ...base, agentId: 99, modifiers: workingMods })).toBe(false);
  });

  it('a priced menu feeds only a meal bought (or the owner\'s stock) here', () => {
    const bought = { source: 'bought' as const, locationId: 10, item: 'food_raw' };
    expect(serviceApplies(shopHunger, { ...base, modifiers: eatingMods, meal: bought })).toBe(true);
    expect(serviceApplies(shopHunger, { ...base, modifiers: eatingMods, meal: { ...bought, locationId: 11 } })).toBe(false);
    expect(serviceApplies(shopHunger, { ...base, modifiers: eatingMods, meal: { ...bought, source: 'own_food' } })).toBe(false);
    expect(serviceApplies(shopHunger, { ...base, modifiers: eatingMods, meal: null })).toBe(false);
  });

  it('a kitchen (itemRequired) feeds only a meal cooked from an item, never the pantry', () => {
    const cooked = { source: 'own_food' as const, locationId: 10, item: 'food_raw' };
    expect(serviceApplies(homeHunger, { ...base, modifiers: eatingMods, meal: cooked })).toBe(true);
    expect(serviceApplies(homeHunger, { ...base, modifiers: eatingMods, meal: { ...cooked, source: 'pantry', item: null } })).toBe(false);
  });

  it('a paid non-food service needs the visit paid for, or the owner', () => {
    expect(serviceApplies(tavernFun, { ...base, modifiers: socialMods })).toBe(false);
    expect(serviceApplies(tavernFun, { ...base, modifiers: socialMods, paidVisit: true })).toBe(true);
    expect(serviceApplies(tavernFun, { ...base, agentId: 99, modifiers: socialMods })).toBe(true);
    // An ownerless venue has nobody to pay.
    expect(serviceApplies(tavernFun, { ...base, location: { id: 10, owner: null }, modifiers: socialMods })).toBe(false);
  });
});

describe('needsTick: meals and services', () => {
  beforeAll(() => setClock());
  beforeEach(() => { clearPurchaseTracking(); setClock(); });

  it('sleeping at home restores energy but no longer feeds the sleeper', () => {
    const home = loc('home', HOME_SERVICES);
    const a = agent(home, { inventory: stock({ food_raw: 5 }) });
    act(a, { type: 'sleeping' }, home);
    ticks(60);
    const after = needsOf(a);
    expect(after.energy).toBeGreaterThan(50);
    expect(after.hunger).toBeLessThan(50);
    expect(count(a, 'food_raw')).toBe(5);
  });

  it('a clerk working in the shop gets hungry like anyone else', () => {
    const home = loc('home', HOME_SERVICES);
    const clerk = agent(home);
    const shop = loc('shop', SHOP_SERVICES, clerk);
    act(clerk, { type: 'working' }, shop);
    ticks(60);
    expect(needsOf(clerk).hunger).toBeLessThan(50);
  });

  it('eating at home cooks one food item, once per meal, and feeds', () => {
    const home = loc('home', HOME_SERVICES);
    const a = agent(home, { inventory: stock({ food_raw: 3 }) });
    act(a, { type: 'eating', locationId: home }, home);
    ticks(30);
    expect(count(a, 'food_raw')).toBe(2);
    expect(needsOf(a).hunger).toBeGreaterThan(60);
  });

  it('eating at home with an empty pantry (and money) feeds nothing', () => {
    const home = loc('home', HOME_SERVICES);
    const a = agent(home, { money: 100 });
    act(a, { type: 'eating', locationId: home }, home);
    ticks(30);
    expect(needsOf(a).hunger).toBeLessThan(50);
  });

  it('a meal at the shop is charged once from the menu price and eaten on the spot', () => {
    const home = loc('home', HOME_SERVICES);
    const owner = agent(home, { money: 0, inventory: stock({ food_raw: 10 }) });
    const shop = loc('shop', SHOP_SERVICES, owner);
    const a = agent(home, { money: 100 });
    act(a, { type: 'eating', locationId: shop }, shop);
    ticks(30);

    const bought = purchasesBy(a);
    expect(bought).toHaveLength(1);
    expect(bought[0].to_agent).toBe(owner);
    // Menu price $6 × (spring market price / base price) — not the $3 raw item.
    expect(bought[0].amount).toBeGreaterThanOrEqual(5);
    expect(econOf(a).money).toBe(100 - bought[0].amount);
    expect(count(owner, 'food_raw')).toBe(9);
    // Eaten, not pocketed (E4: bought meals used to pile up in inventory).
    expect(count(a, 'food_raw')).toBe(0);
    expect(needsOf(a).hunger).toBeGreaterThan(60);
  });

  it('the owner eating in their own shop eats their stock, no sale', () => {
    const home = loc('home', HOME_SERVICES);
    const owner = agent(home, { money: 10, inventory: stock({ bread: 4 }) });
    const shop = loc('bakery', [{ needSatisfied: 'hunger', amount: 12, cost: 5, itemRequired: null }], owner);
    act(owner, { type: 'eating', locationId: shop }, shop);
    ticks(10);
    expect(purchasesBy(owner)).toHaveLength(0);
    expect(count(owner, 'bread')).toBe(3);
    expect(needsOf(owner).hunger).toBeGreaterThan(50);
  });

  it('a patron is only entertained by the tavern after paying the cover', () => {
    const home = loc('home', HOME_SERVICES);
    const barkeep = agent(home, { money: 0 });
    const tavern = loc('tavern', TAVERN_SERVICES, barkeep);
    const unpaid = agent(home, { money: 100 });
    act(unpaid, { type: 'socializing', locationId: tavern }, tavern);
    setNeeds(unpaid, { fun: 50 });
    // needsTick alone never charges the cover, so this is an unpaid visit.
    ticks(60);
    // Socializing restores fun on its own (-1.5 × 3.6/h); the service would add 8/h.
    expect(needsOf(unpaid).fun).toBeLessThan(50 + 1.5 * 3.6 + 1);
  });

  describe('the pantry safety net', () => {
    it('feeds a broke agent with no food at home, once a day, with a mood penalty', () => {
      const home = loc('home', HOME_SERVICES);
      const a = agent(home, { money: 0, hunger: 20 });
      act(a, { type: 'eating', locationId: home }, home, 500);
      ticks(30);
      const fed = needsOf(a);
      expect(fed.hunger).toBeGreaterThan(20);
      expect(fed.mood_modifiers.some((m) => m.source === 'meager_meal' && m.value === PANTRY_MOOD_PENALTY)).toBe(true);

      // A second meal the same day: the pantry is empty.
      act(a, { type: 'eating', locationId: home }, home, 600);
      const before = needsOf(a).hunger;
      ticks(30);
      expect(needsOf(a).hunger).toBeLessThan(before);

      // Next day it is there again.
      setClock(8, 0, DAY + 1);
      act(a, { type: 'eating', locationId: home }, home, 700);
      const before2 = needsOf(a).hunger;
      ticks(10);
      expect(needsOf(a).hunger).toBeGreaterThan(before2);
    });

    it('feeds a starving agent even with money (shops closed at night)', () => {
      const home = loc('home', HOME_SERVICES);
      const a = agent(home, { money: 50, hunger: 5 });
      act(a, { type: 'eating', locationId: home }, home);
      ticks(20);
      expect(needsOf(a).hunger).toBeGreaterThan(5);
    });

    it('is not a free meal for someone who can afford food and is not starving', () => {
      const home = loc('home', HOME_SERVICES);
      const a = agent(home, { money: 50, hunger: 40 });
      act(a, { type: 'eating', locationId: home }, home);
      ticks(20);
      expect(needsOf(a).hunger).toBeLessThan(40);
    });
  });
});

describe('decisions: where to eat and what to buy', () => {
  const time = { hour: 12, season: 'spring', day: 99 };

  function world() {
    const home = loc('home', HOME_SERVICES, null, 0);
    const grocerId = agent(home, { money: 0, inventory: stock({ food_raw: 10 }) });
    const near = loc('shop', SHOP_SERVICES, grocerId, 100, { open: 8, close: 18 });
    const bakerId = agent(home, { money: 0, inventory: stock({ bread: 10 }) });
    const far = loc('bakery', [{ needSatisfied: 'hunger', amount: 12, cost: 5, itemRequired: null }], bakerId, 900, { open: 4, close: 14 });
    const park = loc('park', [], null, 500);
    // Only this scene's places: other tests' shops (open, stocked, at x=0) would be nearer.
    const all = db.select().from(locations).all().filter((l) => [home, near, far, park].includes(l.id));
    const econMap = new Map(db.select().from(economy).all().map((e) => [e.agent_id, e]));
    return { home, near, far, park, all, econMap, grocerId };
  }
  const me = (home: number, at: number | null = home) => ({ id: -1, home, position: { x: 0, y: 0 }, current_location: at });
  const to = (id: number) => ({ locationId: id, here: false });

  it('hungry with no food and some money: the nearest open vendor, not home', () => {
    const w = world();
    expect(chooseMealTarget(me(w.home), { money: 20, inventory: [] }, w.home, w.all, w.econMap, time)).toEqual(to(w.near));
  });

  it('skips a closed vendor', () => {
    const w = world();
    expect(chooseMealTarget(me(w.home), { money: 20, inventory: [] }, w.home, w.all, w.econMap, { ...time, hour: 6 })).toEqual(to(w.far));
  });

  it('carrying food: eats it where they stand, even when a vendor was requested', () => {
    const w = world();
    const groceries = { money: 20, inventory: stock({ food_raw: 1 }) };
    expect(chooseMealTarget(me(w.home, w.park), groceries, w.park, w.all, w.econMap, time)).toEqual({ locationId: w.park, here: true });
    expect(chooseMealTarget(me(w.home, w.park), groceries, w.far, w.all, w.econMap, time)).toEqual({ locationId: w.park, here: true });
    // Outdoors: no location, still here.
    expect(chooseMealTarget(me(w.home, null), groceries, w.near, w.all, w.econMap, time)).toEqual({ locationId: undefined, here: true });
  });

  it('carrying food but already sitting in a vendor that serves them: buys there', () => {
    const w = world();
    expect(chooseMealTarget(me(w.home, w.near), { money: 20, inventory: stock({ food_raw: 1 }) }, w.near, w.all, w.econMap, time))
      .toEqual(to(w.near));
  });

  it('broke with no food: home, where the pantry is', () => {
    const w = world();
    expect(chooseMealTarget(me(w.home), { money: 0, inventory: [] }, w.near, w.all, w.econMap, time)).toEqual(to(w.home));
  });

  it('nothing open, money, not starving: no meal (the caller drops eating)', () => {
    const w = world();
    expect(chooseMealTarget(me(w.home), { money: 20, inventory: [] }, w.home, w.all, w.econMap, { ...time, hour: 22 }, 40)).toBeNull();
  });

  it('nothing open but starving by the agent\'s own threshold: home, for the pantry', () => {
    const w = world();
    const late = { ...time, hour: 22 };
    expect(chooseMealTarget(me(w.home), { money: 20, inventory: [] }, w.home, w.all, w.econMap, late, 5)).toEqual(to(w.home));
    // A custom critical threshold of 25 makes hunger 20 "starving" for the pantry too.
    expect(chooseMealTarget(me(w.home), { money: 20, inventory: [] }, w.home, w.all, w.econMap, late, 20, 25)).toEqual(to(w.home));
  });

  it('the shopping list restocks an empty pantry with the shop\'s cheapest foods', () => {
    const w = world();
    const shop = w.all.find((l) => l.id === w.near)!;
    expect(groceryList({ inventory: [] }, shop)).toEqual(['food_raw', 'bread']);
    expect(groceryList({ inventory: stock({ bread: 2 }) }, shop)).toEqual([]);
  });
});

describe('decisions: the hunger emergency', () => {
  function subject(hunger: number, action: string) {
    const home = loc('home', HOME_SERVICES);
    const id = agent(home, { hunger });
    act(id, { type: action }, home);
    return {
      agent: db.select().from(agents).where(eq(agents.id, id)).get()!,
      needs: { ...needsOf(id), energy: 80, social: 80, mood: 60 },
      home,
    };
  }

  it('is skipped when there is no meal to be had anywhere', () => {
    const { agent: a, needs: n } = subject(5, 'idle');
    expect(checkEmergency(a, n, [], [], [], undefined, () => null)).toBeNull();
  });

  it('goes where the meal is when there is one', () => {
    const { agent: a, needs: n, home } = subject(5, 'idle');
    const d = checkEmergency(a, n, [], [], [], undefined, () => ({ locationId: home, here: false }));
    expect(d).toMatchObject({ action: 'eating', targetLocationId: home });
  });

  it('does not pull someone off their shift until hunger is below the work threshold', () => {
    const meal = () => ({ locationId: undefined, here: true });
    const peckish = subject(HUNGER_INTERRUPTS_WORK + 5, 'working');
    expect(checkEmergency(peckish.agent, peckish.needs, [], [], [], undefined, meal)).toBeNull();
    const starving = subject(HUNGER_INTERRUPTS_WORK - 1, 'working');
    expect(checkEmergency(starving.agent, starving.needs, [], [], [], undefined, meal)).toMatchObject({ action: 'eating' });
  });
});

describe('meal edge cases', () => {
  beforeEach(() => { clearPurchaseTracking(); setClock(); });

  it('needsTick and economyTick in the same tick charge a shop meal once', () => {
    const home = loc('home', HOME_SERVICES);
    const owner = agent(home, { money: 0, inventory: stock({ food_raw: 10 }) });
    const shop = loc('shop', SHOP_SERVICES, owner);
    const a = agent(home, { money: 100 });
    act(a, { type: 'eating', locationId: shop }, shop);
    for (let i = 0; i < 5; i++) { needsTick(); economyTick(); }
    expect(purchasesBy(a)).toHaveLength(1);
    expect(count(owner, 'food_raw')).toBeLessThanOrEqual(9);
  });

  it('a closed vendor does not serve (someone lingering after closing)', () => {
    const home = loc('home', HOME_SERVICES);
    const owner = agent(home, { money: 0, inventory: stock({ food_raw: 10 }) });
    const shop = loc('shop', SHOP_SERVICES, owner, 0, { open: 8, close: 11 });
    const a = agent(home, { money: 100 });
    act(a, { type: 'eating', locationId: shop }, shop);
    ticks(5);
    expect(purchasesBy(a)).toHaveLength(0);
  });

  it('the pantry only feeds at home', () => {
    const home = loc('home', HOME_SERVICES);
    const park = loc('park', []);
    const a = agent(home, { money: 0, hunger: 20 });
    act(a, { type: 'eating', locationId: park }, park);
    ticks(20);
    expect(needsOf(a).hunger).toBeLessThan(20);
  });

  it('a baker eats bread at home and keeps the food_raw for baking', () => {
    const home = loc('home', HOME_SERVICES);
    const baker = agent(home, { inventory: stock({ food_raw: 3, bread: 2 }) });
    db.update(economy).set({ job: 'baker' }).where(eq(economy.agent_id, baker)).run();
    act(baker, { type: 'eating', locationId: home }, home);
    ticks(5);
    expect(count(baker, 'food_raw')).toBe(3);
    expect(count(baker, 'bread')).toBe(1);
  });

  it('a prisoner is fed by the jail', () => {
    const home = loc('home', HOME_SERVICES);
    const prison = loc('prison', []);
    const a = agent(home, { money: 0, hunger: 10 });
    db.insert(agentStates).values({
      agent_id: a, type: 'arrested', severity: 1, started_at: 0, duration: 99999, source: 'test', metadata: null,
    }).run();
    act(a, { type: 'eating', locationId: prison }, prison);
    ticks(30);
    expect(needsOf(a).hunger).toBeGreaterThan(10);
  });
});
