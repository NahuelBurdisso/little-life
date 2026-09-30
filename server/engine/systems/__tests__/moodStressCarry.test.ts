import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, agentStates, locations, needs, worldEvents, worldState } from '../../../db/schema';
import { needsTick } from '../needs';
import { CONFIG } from '../../../lib/constants';
import { addMoodModifier } from '../../../lib/dailyLife';
import { STRESS_RECOVERY_PER_MIN, carriedStress, stateMoodEffect } from '../../../lib/stateMood';
import { startingMoodModifiers } from '../../../lib/startingNeeds';

/**
 * The needs phase rebuilds mood and stress from scratch every tick, so every
 * direct write to `needs.mood` / `needs.stress` (a snap breakdown, an exposed
 * secret, a cascade's moodDelta, a witnessed crime...) was gone a tick later.
 * Mood hits now go through modifiers, states weigh on mood in the rebuild, and
 * stress carries over and fades instead of resetting.
 */

describe('stateMoodEffect', () => {
  it('counts the worst negative and the best positive, not the sum', () => {
    expect(stateMoodEffect([])).toBe(0);
    expect(stateMoodEffect(['grieving'])).toBe(-18);
    // Stacked miseries do not add up into a mood of zero.
    expect(stateMoodEffect(['grieving', 'heartbroken', 'jealous', 'in_debt'])).toBe(-18);
    expect(stateMoodEffect(['angry', 'euphoric'])).toBe(-6 + 8);
    expect(stateMoodEffect(['stressed', 'sick', 'drunk'])).toBe(0);
  });
});

describe('carriedStress', () => {
  it('keeps what is left of a shock, floored by the needs', () => {
    expect(carriedStress(30, 80, 60)).toBeCloseTo(75); // ~5 per game hour
    expect(carriedStress(30, 32, 60)).toBe(30); // the needs are the floor
    expect(carriedStress(50, 20, 1)).toBe(50); // needs worse than before: straight up
  });
});

describe('startingMoodModifiers', () => {
  it('carries a troubled scenario start for the first game day, capped', () => {
    expect(startingMoodModifiers(45, 1000)).toEqual([{ source: 'troubled_start', value: -15, expiresAt: 2440 }]);
    expect(startingMoodModifiers(30, 0)[0].value).toBe(-20);
  });

  it('leaves ordinary starts (and no scenario) to the needs', () => {
    expect(startingMoodModifiers(50, 0)).toEqual([]);
    expect(startingMoodModifiers(70, 0)).toEqual([]);
    expect(startingMoodModifiers(undefined, 0)).toEqual([]);
  });
});

// ─── Through the needs phase ─────────────────────────────────────────────────

const DAY = 5;
const NOW = DAY * 1440 + 14 * 60;
const time = { day: DAY, hour: 14, minute: 0, totalTicks: NOW, seasonDay: 1, season: 'spring' as const };
let otherEvents: number[] = [];
let resident: number;

function resetNeeds(extra: Partial<typeof needs.$inferInsert> = {}): void {
  db.update(needs).set({
    hunger: 60, energy: 60, social: 60, comfort: 60, fun: 60, mood: 60, stress: 20,
    mood_modifiers: [], last_updated: NOW, ...extra,
  }).where(eq(needs.agent_id, resident)).run();
}
function tickAndRead() {
  needsTick();
  return db.select().from(needs).where(eq(needs.agent_id, resident)).get()!;
}
function addState(type: string): void {
  db.insert(agentStates).values({
    agent_id: resident, type, severity: 0.8, started_at: NOW - 10, duration: 5000,
    target_agent_id: null, source: 'test', metadata: null,
  }).run();
}

beforeAll(() => {
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, pending_transitions: [], tick_speed: 1, weather: 'cloudy' })
      .where(eq(worldState.id, existing.id)).run();
  } else {
    db.insert(worldState).values({
      time, day_phase: 'afternoon', weather: 'cloudy', weather_duration: 120, tick_speed: 1, is_paused: true,
      last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
      map_width: 40, map_height: 30, collision_grid: '',
    }).run();
  }
  otherEvents = db.select({ id: worldEvents.id }).from(worldEvents).where(eq(worldEvents.is_active, true)).all().map((e) => e.id);
  if (otherEvents.length) db.update(worldEvents).set({ is_active: false }).where(inArray(worldEvents.id, otherEvents)).run();

  const home = db.insert(locations).values({
    name: 'Carry Home', type: 'home', position: { x: 9100, y: 9100, width: 4, height: 4 },
    entry_point: { x: 9100, y: 9104 }, owner: null, capacity: 2, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  resident = db.insert(agents).values({
    name: 'Carry Resident', bio: 'test', traits: [], personality: null, age: 30, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 }, current_destination: null,
    current_location: null, current_action: { type: 'idle' }, action_started: 0, action_duration: null,
    action_queue: [], current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, workplace: null, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
  db.insert(needs).values({
    agent_id: resident, hunger: 60, energy: 60, social: 60, comfort: 60, fun: 60, mood: 60, stress: 20,
    decay_rates: { ...CONFIG.NEEDS.DEFAULT_DECAY_RATES }, thresholds: { ...CONFIG.NEEDS.THRESHOLDS },
    mood_modifiers: [], last_updated: 0,
  }).run();
});

afterEach(() => {
  db.delete(agentStates).where(and(eq(agentStates.agent_id, resident), eq(agentStates.source, 'test'))).run();
});

afterAll(() => {
  db.update(agents).set({ is_active: false }).where(eq(agents.id, resident)).run();
  if (otherEvents.length) db.update(worldEvents).set({ is_active: true }).where(inArray(worldEvents.id, otherEvents)).run();
});

describe('the needs phase keeps what happened to a resident', () => {
  it('a stress shock outlives the recompute and fades a little per minute', () => {
    resetNeeds({ stress: 0 });
    const fromNeeds = tickAndRead().stress;

    resetNeeds({ stress: 90 });
    const shocked = tickAndRead().stress;
    expect(fromNeeds).toBeLessThan(60);
    expect(shocked).toBeCloseTo(90 - STRESS_RECOVERY_PER_MIN, 5);
  });

  it('a mood modifier (how snaps, exposures and cascades now hit) survives the rebuild', () => {
    resetNeeds();
    const plain = tickAndRead().mood;

    resetNeeds();
    addMoodModifier(resident, -20, 'snap:breakdown', 720, NOW);
    const hit = tickAndRead().mood;
    expect(hit - plain).toBeCloseTo(-20, 5);
  });

  it('grief weighs on the mood while it lasts, and stacked states count once', () => {
    resetNeeds();
    const plain = tickAndRead().mood;

    addState('grieving');
    resetNeeds();
    const grieving = tickAndRead().mood;
    expect(grieving - plain).toBeCloseTo(-18, 5);

    addState('jealous');
    resetNeeds();
    const both = tickAndRead().mood;
    expect(both).toBeCloseTo(grieving, 5);
  });
});
