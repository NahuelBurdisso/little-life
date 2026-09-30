import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// The LLM is down (and nothing here may reach a real Ollama): the decisions pass
// asks for day plans, and a refused connection is a fine answer.
vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn(), callOllamaEmbedding: vi.fn() }));

import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, needs, worldState } from '../../../db/schema';
import { callOllamaChat, callOllamaEmbedding } from '../../../ai/ollama';
import { checkEmergency, tick as decisionsTick, trystDecision } from '../../../engine/systems/decisions';
import { clearIntimacy, getStay, setStay, updatePairIntimacy } from '../state';
import { TRYST_SEEK_SCORE, STAY_MAX_MINUTES } from '../tryst';
import { setRuleOverrides } from '../../worldRules';
import { gameMinutes } from '../../gameClock';
import { planCache, planLLMGate, planLLMQueue } from '../../planning/instance';

/**
 * The tryst's tier in the decisions pass (score 6350), and the guest's bed
 * through every place a bed is chosen: the energy emergency, the schedule, and
 * the "can only sleep in tonight's bed" validation (the last two are reached by
 * running the real pass).
 */

const DAY_NUMBER = 40;
const time = (hour: number, minute = 0) => ({
  day: DAY_NUMBER, hour, minute, totalTicks: DAY_NUMBER * 1440 + hour * 60 + minute, seasonDay: 10, season: 'spring',
});
const world = (hour: number, minute = 0) => ({ time: time(hour, minute), tick_speed: 1 });
const nowAt = (hour: number, minute = 0) => gameMinutes(time(hour, minute));

function setClock(hour: number): void {
  const t = time(hour);
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time: t, weather: 'sunny', tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time: t, day_phase: 'night', weather: 'sunny', weather_duration: 120, tick_speed: 1,
    is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
    pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
  }).run();
}

let otherActive: number[] = [];
const madeAgents: number[] = [];
const madeLocations: number[] = [];

function insertHome(name: string, x: number): number {
  const id = db.insert(locations).values({
    name, type: 'home', position: { x, y: 0, width: 96, height: 96 }, entry_point: { x: x + 48, y: 96 },
    capacity: 4, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  madeLocations.push(id);
  return id;
}

/** Personality is null on purpose: no impulsive schedule skips, no sleep-hour shifts. */
function insertAgent(name: string, home: number, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight', personality: null,
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_duration: null, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 23, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, current_location: home, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  madeAgents.push(id);
  db.insert(needs).values({
    agent_id: id, hunger: 80, energy: 80, social: 80, comfort: 80, fun: 80, mood: 80, stress: 10,
    decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
    thresholds: { critical: 10, low: 30, satisfied: 70 }, mood_modifiers: [], last_updated: 0,
  }).run();
  return id;
}

const load = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;

/** A woman with a house of her own and a man with one of his, in the evening. */
function lovers() {
  const aHome = insertHome(`Hers ${madeLocations.length}`, 200);
  const bHome = insertHome(`His ${madeLocations.length}`, 400);
  const a = insertAgent(`Host ${madeAgents.length}`, aHome, { gender: 'female' });
  const b = insertAgent(`Guest ${madeAgents.length}`, bHome, { gender: 'male' });
  return { a, b, aHome, bHome };
}

beforeAll(() => {
  setClock(20); // the rules live on the world row
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
  vi.mocked(callOllamaChat).mockImplementation(() => { throw new Error('connect ECONNREFUSED'); });
  vi.mocked(callOllamaEmbedding).mockImplementation(() => { throw new Error('connect ECONNREFUSED'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // The worker DB carries other files' rows: park their active agents so the pass only sees ours.
  otherActive = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all().map((r) => r.id);
  if (otherActive.length) db.update(agents).set({ is_active: false }).where(inArray(agents.id, otherActive)).run();
  planCache.clear();
  planLLMQueue.clear();
  planLLMGate.clear();
});

beforeEach(() => {
  clearIntimacy();
  setRuleOverrides({ adultContent: true });
  if (madeAgents.length) db.update(agents).set({ is_active: false }).where(inArray(agents.id, madeAgents)).run();
});

afterAll(() => {
  setRuleOverrides({ adultContent: false });
  clearIntimacy();
  if (madeAgents.length) {
    db.delete(needs).where(inArray(needs.agent_id, madeAgents)).run();
    db.delete(agents).where(inArray(agents.id, madeAgents)).run();
  }
  if (madeLocations.length) db.delete(locations).where(inArray(locations.id, madeLocations)).run();
  if (otherActive.length) db.update(agents).set({ is_active: true }).where(inArray(agents.id, otherActive)).run();
  vi.unstubAllGlobals();
});

const guestStays = (l: ReturnType<typeof lovers>, hour: number) =>
  setStay(l.b, { locationId: l.aHome, hostId: l.a, until: nowAt(hour) + STAY_MAX_MINUTES });

describe('the guest sleeps where their night is', () => {
  it('the energy emergency (9999) goes to the house they are staying at, not their own', () => {
    setClock(0);
    const l = lovers();
    guestStays(l, 0);
    const exhausted = { hunger: 80, energy: 3, social: 80, comfort: 80, fun: 80, mood: 80, stress: 10, thresholds: { critical: 10, low: 30, satisfied: 70 } };
    const guest = checkEmergency(load(l.b), exhausted as never, [], [], []);
    expect(guest).toMatchObject({ action: 'sleeping', score: 9999, targetLocationId: l.aHome });
    // Anyone else, and the host, sleep at home as ever.
    expect(checkEmergency(load(l.a), exhausted as never, [], [], [])).toMatchObject({ targetLocationId: l.aHome });
    const other = lovers();
    expect(checkEmergency(load(other.b), exhausted as never, [], [], [])).toMatchObject({ targetLocationId: other.bHome });
  });

  it('the schedule and the bed validation: at bedtime the guest walks to the house they are staying at and goes to bed there', () => {
    setClock(2);
    const l = lovers();
    guestStays(l, 2);
    decisionsTick(world(2));
    const row = load(l.b);
    expect(row.current_action).toMatchObject({ type: 'walking' });
    expect(row.current_destination).toMatchObject({ locationId: l.aHome });
    expect(row.action_queue[0]).toMatchObject({ type: 'sleeping' });
  });

  it('without a stay the same guest goes to their own bed (the validation still sends everyone home)', () => {
    setClock(2);
    const l = lovers();
    decisionsTick(world(2));
    const row = load(l.b);
    expect(row.current_destination).toMatchObject({ locationId: l.bHome });
    expect(row.action_queue[0]).toMatchObject({ type: 'sleeping' });
  });

  it('a tired guest with the stay lapsed is sent to their own bed', () => {
    setClock(2);
    const l = lovers();
    setStay(l.b, { locationId: l.aHome, hostId: l.a, until: nowAt(2) - 1 });
    db.update(needs).set({ energy: 3 }).where(eq(needs.agent_id, l.b)).run();
    decisionsTick(world(2));
    expect(load(l.b).current_destination).toMatchObject({ locationId: l.bHome });
  });

  it('a tired guest (energy emergency) is validated onto the house they are staying at', () => {
    setClock(15);
    const l = lovers();
    guestStays(l, 15);
    db.update(needs).set({ energy: 3 }).where(eq(needs.agent_id, l.b)).run();
    decisionsTick(world(15));
    const row = load(l.b);
    expect(row.current_destination).toMatchObject({ locationId: l.aHome });
    expect(row.action_queue[0]).toMatchObject({ type: 'sleeping' });
  });
});

describe('the tryst tier (6350)', () => {
  const agreed = (l: ReturnType<typeof lovers>, venueId: number) =>
    updatePairIntimacy(l.a, l.b, (p) => {
      p.pendingRendezvous = { initiatorId: l.a, since: nowAt(20) - 10, agreed: true, agreedAt: nowAt(20) - 10, venueId };
    });

  it('sits between the rendezvous seek (6300) and a proposal (6400)', () => {
    expect(TRYST_SEEK_SCORE).toBe(6350);
  });

  it('an agreed pair with a venue walks there', () => {
    setClock(20);
    const l = lovers();
    agreed(l, l.aHome);
    decisionsTick(world(20));
    // The guest sets off for her house...
    expect(load(l.b).current_action).toMatchObject({ type: 'walking' });
    expect(load(l.b).current_destination).toMatchObject({ locationId: l.aHome });
    // ...and she waits at home (a step to the living room, then an idle: not the start, the pass starts the evening).
    expect(load(l.a).current_destination).toMatchObject({ locationId: l.aHome });
    expect(load(l.a).action_queue[0]).toMatchObject({ type: 'idle' });
    expect(load(l.a).action_queue[0]).not.toHaveProperty('zoneActivity', 'tryst');
  });

  it('is nothing at all with the rule off', () => {
    setClock(20);
    setRuleOverrides({ adultContent: false });
    const l = lovers();
    agreed(l, l.aHome);
    const guest = load(l.b);
    expect(trystDecision(guest, 20, nowAt(20), [])).toBeNull();
    decisionsTick(world(20));
    expect(load(l.b).current_destination?.locationId).not.toBe(l.aHome);
  });

  it('is nothing for a pair who may not be intimate (a minor, built directly)', () => {
    setClock(20);
    const l = lovers();
    db.update(agents).set({ age: 16 }).where(eq(agents.id, l.b)).run();
    agreed(l, l.aHome);
    expect(trystDecision(load(l.b), 20, nowAt(20), [])).toBeNull();
    expect(trystDecision(load(l.a), 20, nowAt(20), [])).toBeNull();
    decisionsTick(world(20));
    expect(load(l.b).current_destination?.locationId).not.toBe(l.aHome);
  });

  it('someone on shift or in no state for it does not go', () => {
    setClock(20);
    const l = lovers();
    agreed(l, l.aHome);
    expect(trystDecision(load(l.b), 20, nowAt(20), ['sick'])).toBeNull();
    const onShift = { ...load(l.b), workplace: l.bHome };
    expect(trystDecision(onShift, 12, nowAt(12), [])).toBeNull();
    expect(trystDecision(load(l.b), 20, nowAt(20), [])).toMatchObject({ action: 'idle', score: 6350, targetLocationId: l.aHome });
  });

  it('dawn: the guest wakes at the house and their first decision is the walk home, `sneak_home`, and the stay is over', () => {
    setClock(8);
    const l = lovers();
    guestStays(l, 8);
    db.update(agents).set({ current_location: l.aHome, current_action: { type: 'sleeping' }, action_started: 0, action_duration: 1 })
      .where(eq(agents.id, l.b)).run();
    decisionsTick(world(8));

    const row = load(l.b);
    expect(row.current_action).toMatchObject({ type: 'walking' });
    expect(row.current_destination).toMatchObject({ locationId: l.bHome });
    expect(row.action_queue[0]).toMatchObject({ type: 'idle', zoneActivity: 'sneak_home' });
    expect(getStay(l.b)!.leftAt).toBe(nowAt(8));
  });

  it('still inside their sleep window at the house, the guest sleeps on there (no early walk of shame)', () => {
    setClock(4);
    const l = lovers();
    guestStays(l, 4);
    db.update(agents).set({ current_location: l.aHome, current_action: { type: 'sleeping' }, action_started: 0, action_duration: 1 })
      .where(eq(agents.id, l.b)).run();
    decisionsTick(world(4));
    const row = load(l.b);
    expect(row.action_queue[0] ?? row.current_action).toMatchObject({ type: 'sleeping' });
    expect(getStay(l.b)!.leftAt).toBeUndefined();
  });

  it('after the evening at the host\'s house, at bedtime, the host goes to bed at home', () => {
    setClock(23);
    const l = lovers();
    db.update(agents).set({ current_action: { type: 'idle', zoneActivity: 'tryst', partnerId: l.b }, action_started: 0, action_duration: 60 })
      .where(eq(agents.id, l.a)).run();
    decisionsTick(world(23));
    expect(load(l.a).current_destination).toMatchObject({ locationId: l.aHome });
    expect(load(l.a).action_queue[0]).toMatchObject({ type: 'sleeping' });
  });
});
