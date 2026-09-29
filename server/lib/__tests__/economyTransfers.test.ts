import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../db';
import { agents, economy, locations, worldState } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { payTavernRound, shopliftFrom } from '../economyTransfers';

/**
 * Two money moves that broke the treasury loop's conservation: a tavern round
 * was burned, shoplifting was minted. Each dollar now leaves one account for
 * another.
 */

let n = 0;
let home = 0;
function resident(money: number): number {
  n++;
  const id = db.insert(agents).values({
    name: `Transfer ${n}`, bio: 'test', traits: [], personality: null, age: 30, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 }, current_destination: null,
    current_location: null, current_action: { type: 'idle' }, action_started: 0, action_duration: null,
    action_queue: [], current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, workplace: null, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
  db.insert(economy).values({
    agent_id: id, job: 'unemployed', job_title: 'Test', salary: 0, work_performance: 0.5, money,
    daily_expenses: 0, inventory: [], last_payday: 0, production_remainder: 0,
  }).run();
  return id;
}

const cash = (id: number) => db.select().from(economy).where(eq(economy.agent_id, id)).get()!.money;
const pool = () => db.select().from(worldState).get()!.tax_pool;

beforeAll(() => {
  home = db.insert(locations).values({
    name: 'transfer home', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 1, y: 4 }, owner: null, capacity: 10, current_occupants: [],
    operating_hours: null, services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  if (db.select().from(worldState).get()) return;
  db.insert(worldState).values({
    time: { day: 1, hour: 9, minute: 0, totalTicks: 0, seasonDay: 1, season: 'spring' },
    day_phase: 'morning', weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true,
    last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [],
    tax_pool: 100, map_width: 40, map_height: 30, collision_grid: '',
  }).run();
});

describe('payTavernRound', () => {
  it("the drinker's $2 goes to the tavern's owner", () => {
    const drinker = resident(10);
    const owner = resident(50);
    expect(payTavernRound(drinker, owner, 2)).toBe(2);
    expect(cash(drinker)).toBe(8);
    expect(cash(owner)).toBe(52);
  });

  it('a tavern nobody runs pays the town', () => {
    const drinker = resident(10);
    const before = pool();
    payTavernRound(drinker, null, 2);
    expect(cash(drinker)).toBe(8);
    expect(pool()).toBeCloseTo(before + 2, 2);
  });

  it('drinking at your own bar costs nothing, and nobody drinks on credit', () => {
    const owner = resident(10);
    expect(payTavernRound(owner, owner, 2)).toBe(0);
    expect(cash(owner)).toBe(10);
    const broke = resident(1);
    expect(payTavernRound(broke, owner, 2)).toBe(0);
    expect(cash(broke)).toBe(1);
  });
});

describe('shopliftFrom', () => {
  it("the take comes out of the owner's till", () => {
    const thief = resident(2);
    const owner = resident(100);
    expect(shopliftFrom(thief, owner, 12)).toBe(12);
    expect(cash(thief)).toBe(14);
    expect(cash(owner)).toBe(88);
  });

  it('never more than the till holds', () => {
    const thief = resident(0);
    const owner = resident(7.5);
    expect(shopliftFrom(thief, owner, 12)).toBe(7);
    expect(cash(thief)).toBe(7);
    expect(cash(owner)).toBeCloseTo(0.5, 2);
  });

  it('nothing from your own shop or a shop nobody owns (the treasury is not a till)', () => {
    const owner = resident(100);
    expect(shopliftFrom(owner, owner, 10)).toBe(0);
    expect(cash(owner)).toBe(100);
    const thief = resident(0);
    const before = pool();
    expect(shopliftFrom(thief, null, 10)).toBe(0);
    expect(cash(thief)).toBe(0);
    expect(pool()).toBe(before);
  });
});
