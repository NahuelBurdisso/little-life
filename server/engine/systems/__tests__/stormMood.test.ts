import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, needs, worldEvents, worldState } from '../../../db/schema';
import { needsTick } from '../needs';
import { CONFIG } from '../../../lib/constants';
import { WORLD_EVENTS } from '../../../data/worldEventCatalog';

/**
 * B18: a "Heavy Storm" event sets the weather to stormy for its whole run, so
 * an agent caught outside paid twice for the same storm — the event's
 * `mood_outdoor` (-15) and the stormy-weather penalty in needs (-5). The event
 * is the storm; its effect replaces the weather's, it doesn't add to it.
 */

const DAY = 4;
const time = { day: DAY, hour: 14, minute: 0, totalTicks: DAY * 1440 + 14 * 60, seasonDay: 1, season: 'spring' as const };
let otherEvents: number[] = [];
let stormId: number;
let walker: number;

function resetNeeds(): void {
  db.update(needs).set({
    hunger: 60, energy: 60, social: 60, comfort: 60, fun: 60, mood: 60, stress: 20,
    mood_modifiers: [], last_updated: DAY * 1440 + 14 * 60,
  }).where(eq(needs.agent_id, walker)).run();
}
function moodAfterTick(): number {
  resetNeeds();
  needsTick();
  return db.select().from(needs).where(eq(needs.agent_id, walker)).get()!.mood;
}

beforeAll(() => {
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, pending_transitions: [], tick_speed: 1, weather: 'stormy' })
      .where(eq(worldState.id, existing.id)).run();
  } else {
    db.insert(worldState).values({
      time, day_phase: 'afternoon', weather: 'stormy', weather_duration: 120, tick_speed: 1, is_paused: true,
      last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
      map_width: 40, map_height: 30, collision_grid: '',
    }).run();
  }
  // Another file's active storm in this worker's DB would make both runs "event weather".
  otherEvents = db.select({ id: worldEvents.id }).from(worldEvents).where(eq(worldEvents.is_active, true)).all().map((e) => e.id);
  if (otherEvents.length) db.update(worldEvents).set({ is_active: false }).where(inArray(worldEvents.id, otherEvents)).run();

  const home = db.insert(locations).values({
    name: 'Storm Walker Home', type: 'home', position: { x: 9000, y: 9000, width: 4, height: 4 },
    entry_point: { x: 9000, y: 9004 }, owner: null, capacity: 2, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  walker = db.insert(agents).values({
    name: 'Storm Walker', bio: 'test', traits: [], personality: null, age: 30, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 }, current_destination: null,
    current_location: null, current_action: { type: 'idle' }, action_started: 0, action_duration: null,
    action_queue: [], current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, workplace: null, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
  db.insert(needs).values({
    agent_id: walker, hunger: 60, energy: 60, social: 60, comfort: 60, fun: 60, mood: 60, stress: 20,
    decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES }, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
    mood_modifiers: [], last_updated: 0,
  }).run();

  const storm = WORLD_EVENTS.storm;
  stormId = db.insert(worldEvents).values({
    type: 'storm', name: storm.name, description: storm.description, started_at: DAY * 1440 + 13 * 60,
    duration: storm.durationHours, effects: storm.effects, location_id: null, triggered_by: 'test', is_active: false,
  }).returning({ id: worldEvents.id }).get().id;
});

afterAll(() => {
  db.update(agents).set({ is_active: false }).where(eq(agents.id, walker)).run();
  db.update(worldEvents).set({ is_active: false }).where(eq(worldEvents.id, stormId)).run();
  if (otherEvents.length) db.update(worldEvents).set({ is_active: true }).where(inArray(worldEvents.id, otherEvents)).run();
});

describe('a storm event outdoors', () => {
  it('costs its own mood effect, not that plus the stormy-weather penalty', () => {
    const plainStorm = moodAfterTick();
    db.update(worldEvents).set({ is_active: true }).where(eq(worldEvents.id, stormId)).run();
    const heavyStorm = moodAfterTick();
    db.update(worldEvents).set({ is_active: false }).where(eq(worldEvents.id, stormId)).run();
    // Plain stormy weather: -5. Heavy Storm event: -15 in its place.
    expect(heavyStorm - plainStorm).toBeCloseTo(WORLD_EVENTS.storm.effects.mood_outdoor! - -5, 5);
  });
});
