import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, needs, worldEvents, worldState } from '../../../db/schema';
import { needsTick } from '../needs';
import { gameMinutes } from '../../../lib/gameClock';

/**
 * needsTick writes each agent's row through one cached prepared statement
 * instead of a drizzle update (a fresh SQLite compile per agent per tick). The
 * stored row must come out the way drizzle would have written it: numbers in
 * the number columns, the mood modifiers as a JSON array that reads back
 * through the schema's json mode, and `last_updated` on the game-minute clock.
 */

const DAY = 6;
const time = { day: DAY, hour: 10, minute: 0, totalTicks: DAY * 1440 + 10 * 60, seasonDay: 1, season: 'spring' as const };
let otherEvents: number[] = [];
let walker: number;

beforeAll(() => {
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, pending_transitions: [], tick_speed: 1, weather: 'sunny' })
      .where(eq(worldState.id, existing.id)).run();
  } else {
    db.insert(worldState).values({
      time, day_phase: 'morning', weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true,
      last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
      map_width: 40, map_height: 30, collision_grid: '',
    }).run();
  }
  otherEvents = db.select({ id: worldEvents.id }).from(worldEvents).where(eq(worldEvents.is_active, true)).all().map((e) => e.id);
  if (otherEvents.length) db.update(worldEvents).set({ is_active: false }).where(inArray(worldEvents.id, otherEvents)).run();

  const home = db.insert(locations).values({
    name: 'Needs Write Home', type: 'home', position: { x: 9100, y: 9100, width: 4, height: 4 },
    entry_point: { x: 9100, y: 9104 }, owner: null, capacity: 2, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  walker = db.insert(agents).values({
    name: 'Needs Writer', bio: 'test', traits: [], personality: null, age: 30, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 }, current_destination: null,
    current_location: home, current_action: { type: 'idle' }, action_started: 0, action_duration: null,
    action_queue: [], current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, workplace: null, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
  db.insert(needs).values({
    agent_id: walker, hunger: 60, energy: 60, social: 60, comfort: 60, fun: 60, mood: 60, stress: 20,
    decay_rates: { hunger: 0.1, energy: 0.1, social: 0.1, comfort: 0.1, fun: 0.1 },
    thresholds: { critical: 15, low: 35, satisfied: 70 },
    mood_modifiers: [
      { source: 'still_fresh', value: 4, expiresAt: gameMinutes(time) + 600 },
      { source: 'long_gone', value: 9, expiresAt: gameMinutes(time) - 1 },
    ],
    last_updated: 0,
  }).run();
});

afterAll(() => {
  if (otherEvents.length) db.update(worldEvents).set({ is_active: true }).where(inArray(worldEvents.id, otherEvents)).run();
});

describe('needsTick row write', () => {
  it('stores numbers, live mood modifiers as JSON and the game-minute stamp', () => {
    needsTick();
    needsTick();

    const row = db.select().from(needs).where(eq(needs.agent_id, walker)).get()!;
    for (const k of ['hunger', 'energy', 'social', 'comfort', 'fun', 'mood', 'stress'] as const) {
      expect(typeof row[k]).toBe('number');
      expect(Number.isFinite(row[k])).toBe(true);
    }
    // Expired modifiers are dropped, live ones survive the round trip as objects.
    expect(row.mood_modifiers.map((m) => m.source)).toContain('still_fresh');
    expect(row.mood_modifiers.map((m) => m.source)).not.toContain('long_gone');
    expect(row.mood_modifiers.find((m) => m.source === 'still_fresh')).toMatchObject({ value: 4 });
    expect(row.last_updated).toBe(gameMinutes(time));
    // The decay was applied (two ticks of a 0.1 decay on a full-ish need).
    expect(row.hunger).toBeLessThan(60);
  });
});
