import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../db';
import { agents, economy, locations, worldState } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { executeZoneAction, gatherSeasonMultiplier } from '../zoneActions';

/**
 * E11: fishing and foraging brought home one food_raw whatever the season, so a
 * soak's winter food_raw was as high as spring's while farm output (which
 * follows SEASON_PRODUCTION_MODIFIERS, winter 0.4) was already lean.
 */

type Season = 'spring' | 'summer' | 'autumn' | 'winter';

function setSeason(season: Season): void {
  const time = { day: 1, hour: 10, minute: 0, totalTicks: 600, seasonDay: 1, season };
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time }).where(eq(worldState.id, existing.id)).run();
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

let n = 0;
function insertGatherer(): number {
  n++;
  const home = db.insert(locations).values({
    name: `Gatherer home ${n}`,
    type: 'home',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 1, y: 4 },
    owner: null,
    capacity: 4,
    current_occupants: [],
    operating_hours: null,
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
  const id = db.insert(agents).values({
    name: `Gatherer ${n}`,
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
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home,
    workplace: null,
    created_at: Date.now(),
    is_active: true,
  }).returning({ id: agents.id }).get().id;
  db.insert(economy).values({
    agent_id: id,
    job: 'unemployed',
    job_title: 'Unemployed',
    salary: 0,
    work_performance: 0.5,
    money: 50,
    daily_expenses: 0,
    inventory: [],
    last_payday: 0,
    production_remainder: 0,
  }).run();
  return id;
}

const foodRaw = (agentId: number) =>
  ((db.select().from(economy).where(eq(economy.agent_id, agentId)).get()!.inventory as
    { itemId: string; quantity: number }[]).find((i) => i.itemId === 'food_raw')?.quantity) ?? 0;

/** Total food_raw brought home over `trips` trips, with Math.random cycling evenly through [0,1). */
function gatherTrips(action: 'fish' | 'forage', season: Season, trips: number): number {
  setSeason(season);
  const id = insertGatherer();
  let i = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((i++ % trips) + 0.5) / trips);
  for (let t = 0; t < trips; t++) executeZoneAction(action, id);
  return foodRaw(id);
}

describe('gatherSeasonMultiplier', () => {
  it('never exceeds 1, so good seasons match the flat unit the meal economy is tuned to', () => {
    for (const season of ['spring', 'summer', 'autumn', 'winter']) {
      for (const action of ['fish', 'forage']) {
        expect(gatherSeasonMultiplier(action, season)).toBeLessThanOrEqual(1);
      }
    }
    expect(gatherSeasonMultiplier('forage', 'spring')).toBe(1);
    expect(gatherSeasonMultiplier('forage', 'summer')).toBe(1);
  });

  it('follows the farm table when it bites: foraging in winter is 0.4, autumn 0.8', () => {
    expect(gatherSeasonMultiplier('forage', 'winter')).toBeCloseTo(0.4);
    expect(gatherSeasonMultiplier('forage', 'autumn')).toBeCloseTo(0.8);
  });

  it('fishing is milder than foraging in the lean seasons but still seasonal', () => {
    expect(gatherSeasonMultiplier('fish', 'winter')).toBeCloseTo(0.7);
    expect(gatherSeasonMultiplier('fish', 'winter')).toBeGreaterThan(gatherSeasonMultiplier('forage', 'winter'));
    expect(gatherSeasonMultiplier('fish', 'winter')).toBeLessThan(gatherSeasonMultiplier('fish', 'spring'));
  });

  it('leaves other actions and unknown seasons alone', () => {
    expect(gatherSeasonMultiplier('garden', 'winter')).toBe(1);
    expect(gatherSeasonMultiplier('forage', undefined)).toBe(1);
  });
});

describe('executeZoneAction: seasonal gathering', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('a spring forager brings home a unit a trip, as before', () => {
    expect(gatherTrips('forage', 'spring', 10)).toBe(10);
  });

  it('a winter forager brings home about 0.4 of that', () => {
    expect(gatherTrips('forage', 'winter', 10)).toBe(4);
  });

  it('a winter angler brings home about 0.7', () => {
    expect(gatherTrips('fish', 'winter', 10)).toBe(7);
  });

  it('winter yields clearly less food than spring for the same number of trips', () => {
    const spring = gatherTrips('forage', 'spring', 20);
    const winter = gatherTrips('forage', 'winter', 20);
    expect(winter).toBeLessThan(spring * 0.6);
  });
});
