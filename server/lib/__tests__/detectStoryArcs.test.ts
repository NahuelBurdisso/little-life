import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, locations, relationshipEvents, relationships, worldState } from '../../db/schema';
import { detectStoryArcs, resetChronicleCache } from '../chronicle';

/**
 * End to end against the test DB: the insert trigger stamps game minutes, the
 * per-pair query feeds the detector, and nothing reads the wall clock.
 */

const DAY = 1440;
let a = 0;
let b = 0;
let c = 0;
let d = 0;

function insertAgent(name: string, locId: number): number {
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
    current_location: locId,
    current_action: { type: 'idle' },
    action_started: 0,
    action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: locId,
    created_at: 0,
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function setClock(totalMinutes: number): void {
  const time = {
    day: Math.floor(totalMinutes / DAY),
    hour: Math.floor((totalMinutes % DAY) / 60),
    minute: totalMinutes % 60,
    totalTicks: totalMinutes,
    seasonDay: 1,
    season: 'spring',
  };
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, is_paused: true }).where(eq(worldState.id, existing.id)).run();
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

/** Written the way the engine writes them: no game_minute, the trigger fills it. */
function logEvent(from: number, to: number, eventType: string, sentiment: number): void {
  db.insert(relationshipEvents).values({
    agent_a: from,
    agent_b: to,
    event_type: eventType,
    description: `${eventType} ${from}->${to}`,
    friendship_delta_ab: 0,
    friendship_delta_ba: 0,
    romance_delta_ab: 0,
    romance_delta_ba: 0,
    trust_delta_ab: 0,
    trust_delta_ba: 0,
    sentiment,
    processed: true,
    timestamp: Date.now(),
  }).run();
}

function relate(x: number, y: number, status: string): void {
  db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y),
    friendship_ab: 0, friendship_ba: 0, romance_ab: 0, romance_ba: 0, trust_ab: 0, trust_ba: 0,
    familiarity: 40, interaction_count: 5, last_interaction: 0,
    average_interaction_sentiment: 0, tags: [], status,
    created_at: 0, last_updated: 0,
  }).run();
}

const rivalryId = () => `rivalry:${Math.min(a, b)}-${Math.max(a, b)}`;

describe('detectStoryArcs', () => {
  beforeAll(() => {
    const locId = db.insert(locations).values({
      name: 'Chronicle Square',
      type: 'town_square',
      position: { x: 0, y: 0, width: 10, height: 10 },
      entry_point: { x: 0, y: 0 },
      capacity: 10,
      current_occupants: [],
      services: [],
      description: 'test',
    }).returning({ id: locations.id }).get().id;
    a = insertAgent('Mara', locId);
    b = insertAgent('Jonas', locId);
    c = insertAgent('Edda', locId);
    d = insertAgent('Piet', locId);
  });

  beforeEach(() => {
    db.delete(relationshipEvents).run();
    db.delete(relationships).run();
    relate(a, b, 'rivals');
    relate(c, d, 'friends');
    resetChronicleCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetChronicleCache();
  });

  it('stamps beats with the game minute they happened at', () => {
    setClock(5 * DAY + 600);
    logEvent(a, b, 'fight', -0.8);
    setClock(5 * DAY + 720);
    logEvent(b, a, 'confrontation', -0.6);

    const arc = detectStoryArcs().find((x) => x.id === rivalryId());
    expect(arc?.beats.map((beat) => beat.gameMinute)).toEqual([5 * DAY + 600, 5 * DAY + 720]);
    expect(arc?.lastActivity).toBe(5 * DAY + 720);
  });

  it('keeps an old rivalry through a long gap full of other people’s small talk', () => {
    setClock(2 * DAY);
    logEvent(a, b, 'fight', -0.8);
    logEvent(b, a, 'confrontation', -0.6);
    // Ten game days and 700 exchanges later elsewhere in town — more than the
    // old town-wide window of 600 newest rows held.
    setClock(12 * DAY);
    for (let i = 0; i < 700; i++) logEvent(c, d, 'conversation', 0.2);

    const arc = detectStoryArcs().find((x) => x.id === rivalryId());
    expect(arc).toBeDefined();
    expect(arc!.beats.map((beat) => beat.eventType).sort()).toEqual(['confrontation', 'fight']);
  });

  it('does not cool a paused game: heat ignores the wall clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T20:00:00Z'));
    setClock(3 * DAY);
    logEvent(a, b, 'fight', -0.4);
    logEvent(b, a, 'confrontation', -0.3);
    const before = detectStoryArcs().find((x) => x.id === rivalryId())!.heat;

    // Paused overnight: the world clock stands still while real time runs on.
    vi.setSystemTime(new Date('2026-09-30T08:00:00Z'));
    resetChronicleCache();
    const after = detectStoryArcs().find((x) => x.id === rivalryId())!.heat;
    expect(after).toBe(before);

    // Game time moving on is what cools it.
    setClock(4 * DAY);
    resetChronicleCache();
    const nextDay = detectStoryArcs().find((x) => x.id === rivalryId())!.heat;
    expect(nextDay).toBeCloseTo(before / 2, 5);
  });
});
