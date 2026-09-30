import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, relationshipEvents, relationships } from '../../../db/schema';
import { tick as relationshipsTick } from '../relationships';
import { gameMinutes } from '../../../lib/gameClock';
import { CONFIG } from '../../../lib/constants';

/**
 * Review follow-up: decay measured its gap as `Date.now() - last_interaction`
 * converted at the current speed, so every minute the server was off or paused
 * counted as game time — after a night's break every pair decayed at full
 * strength on the first hourly pass. It now reads `last_interaction_minute`.
 */

const TIME = { day: 20, hour: 10, minute: 0 };
const NOW_MINUTES = gameMinutes(TIME);
const WORLD = {
  time: TIME,
  tick_speed: 4,
  pending_transitions: [{ type: 'hour_changed' }],
};
const GRACE_MINUTES = CONFIG.RELATIONSHIPS.DECAY_GRACE_PERIOD_DAYS * 1440;

let homeId: number;
let ids: number[] = [];

function insertAgent(name: string): number {
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
    current_action: { type: 'idle' },
    action_started: 0,
    action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId,
    created_at: 0,
    // Inactive: keeps the proximity pass (section 1) away from these rows.
    is_active: false,
  }).returning({ id: agents.id }).get().id;
}

function insertPair(a: number, b: number, lastInteractionMinute: number | null): number {
  return db.insert(relationships).values({
    agent_a: Math.min(a, b),
    agent_b: Math.max(a, b),
    friendship_ab: 60,
    friendship_ba: 60,
    romance_ab: 0,
    romance_ba: 0,
    trust_ab: 50,
    trust_ba: 50,
    familiarity: 60,
    interaction_count: 10,
    // A wall-clock stamp from 1970: under the old rule this pair was decades
    // stale and decayed at full strength no matter what the game clock said.
    last_interaction: 0,
    last_interaction_minute: lastInteractionMinute,
    average_interaction_sentiment: 0.3,
    tags: [],
    status: 'friends',
    created_at: 0,
    last_updated: 0,
  }).returning({ id: relationships.id }).get().id;
}

const row = (id: number) => db.select().from(relationships).where(eq(relationships.id, id)).get()!;

describe('relationship decay runs on game time', () => {
  beforeAll(() => {
    homeId = db.insert(locations).values({
      name: 'Decay Cottage',
      type: 'home',
      position: { x: 0, y: 0, width: 4, height: 4 },
      entry_point: { x: 0, y: 0 },
      capacity: 4,
      current_occupants: [],
      services: [],
      description: 'test',
    }).returning({ id: locations.id }).get().id;
    ids = ['Ottoline Brackenbury', 'Leopold Fairweather', 'Wilhelmina Ashdown', 'Cornelius Pembrook']
      .map(insertAgent);
  });

  afterAll(() => {
    db.delete(relationshipEvents).where(inArray(relationshipEvents.agent_a, ids)).run();
    db.delete(relationships).where(inArray(relationships.agent_a, ids)).run();
    db.delete(agents).where(inArray(agents.id, ids)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
  });

  it('does not decay a pair whose last interaction is recent in game time, however old in wall clock', () => {
    const id = insertPair(ids[0], ids[1], NOW_MINUTES - 60);
    relationshipsTick(WORLD);
    expect(row(id).friendship_ab).toBe(60);
    expect(row(id).friendship_ba).toBe(60);
  });

  it('still decays a pair whose game-time gap is past the grace period', () => {
    const id = insertPair(ids[0], ids[2], NOW_MINUTES - GRACE_MINUTES - 5 * 1440);
    relationshipsTick(WORLD);
    expect(row(id).friendship_ab).toBeLessThan(60);
  });

  // I3: lovers whose romance "fell fast" were blamed on this decay. It is not the cause: it moves romance by at
  // most 0.45 a day (DECAY_DAILY_RATE 0.3 x ROMANCE_DECAY_MULTIPLIER 1.5 at full strength, 30 days after the last
  // interaction), and any relationship event, a kiss or a night together included, restarts the grace clock.
  // What zeroed those pairs was an affair coming out (conversationBeats.applyAffairFallout).
  it('a kiss or a night together restarts the grace clock: lovers who see each other do not decay', () => {
    const stale = NOW_MINUTES - GRACE_MINUTES - 10 * 1440;
    const lovers = insertPair(ids[1], ids[2], stale);
    const strangers = insertPair(ids[2], ids[3], stale);
    for (const id of [lovers, strangers]) db.update(relationships).set({ romance_ab: 80, romance_ba: 80 }).where(eq(relationships.id, id)).run();
    db.insert(relationshipEvents).values({
      agent_a: Math.min(ids[1], ids[2]), agent_b: Math.max(ids[1], ids[2]), event_type: 'tryst',
      description: 'spent the evening together', friendship_delta_ab: 1, friendship_delta_ba: 1,
      romance_delta_ab: 2, romance_delta_ba: 2, trust_delta_ab: 1, trust_delta_ba: 1,
      sentiment: 0.4, processed: false, timestamp: Date.now(),
    }).run();
    relationshipsTick(WORLD);
    expect(row(lovers).last_interaction_minute).toBe(NOW_MINUTES);
    expect(row(lovers).romance_ab).toBeGreaterThanOrEqual(80);
    // The same pair with nothing since does decay, but slowly: well under half a point on this pass.
    expect(row(strangers).romance_ab).toBeLessThan(80);
    expect(80 - row(strangers).romance_ab).toBeLessThan(0.5);
  });

  it('starts the clock of a pair with no game-minute stamp instead of decaying it', () => {
    const id = insertPair(ids[0], ids[3], null);
    relationshipsTick(WORLD);
    expect(row(id).friendship_ab).toBe(60);
    expect(row(id).last_interaction_minute).toBe(NOW_MINUTES);
  });
});
