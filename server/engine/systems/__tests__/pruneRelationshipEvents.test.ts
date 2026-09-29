import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, relationshipEvents } from '../../../db/schema';
import {
  EVENT_RETENTION_GAME_MINUTES,
  PIVOTAL_EVENTS_KEPT_PER_PAIR_TYPE,
  pruneRelationshipEvents,
} from '../relationships';

/**
 * Story history used to vanish: processed events were deleted after six REAL
 * hours, and the chronicle builds every arc from them. Retention is on game
 * days now, and story turning points survive it.
 */

const DAY = 1440;
const NOW = 40 * DAY; // day 40, midnight

let a = 0;
let b = 0;
let c = 0;

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

function insertEvent(
  from: number,
  to: number,
  eventType: string,
  sentiment: number,
  gameMinute: number | null,
  processed = true,
): number {
  return db.insert(relationshipEvents).values({
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
    processed,
    // Wall-clock stamp deliberately ancient: retention must not read it.
    timestamp: 1,
    game_minute: gameMinute,
  }).returning({ id: relationshipEvents.id }).get().id;
}

const exists = (id: number) =>
  db.select({ id: relationshipEvents.id }).from(relationshipEvents).where(eq(relationshipEvents.id, id)).get() != null;

describe('pruneRelationshipEvents', () => {
  beforeAll(() => {
    const locId = db.insert(locations).values({
      name: 'Prune Square',
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
  });

  beforeEach(() => {
    db.delete(relationshipEvents).run();
  });

  it('drops ordinary events older than the game-day retention and keeps recent ones', () => {
    const old = insertEvent(a, b, 'conversation', 0.1, NOW - EVENT_RETENTION_GAME_MINUTES - 1);
    const recent = insertEvent(a, b, 'conversation', 0.1, NOW - EVENT_RETENTION_GAME_MINUTES + 60);

    expect(pruneRelationshipEvents(NOW)).toBe(1);
    expect(exists(old)).toBe(false);
    expect(exists(recent)).toBe(true);
  });

  it('keeps a paused world intact: age is game time, not the wall clock', () => {
    // `timestamp` is 1 ms after the epoch — decades of real time — but only an
    // hour of game time has passed.
    const chat = insertEvent(a, b, 'conversation', 0.1, NOW - 60);
    pruneRelationshipEvents(NOW);
    expect(exists(chat)).toBe(true);
  });

  it('keeps pivotal events forever: clashes, romance, mends and strong feeling', () => {
    const ancient = NOW - 30 * DAY;
    const kept = [
      insertEvent(a, b, 'fight', -0.8, ancient),
      insertEvent(b, a, 'confrontation', -0.2, ancient),
      insertEvent(a, b, 'confession', 0.3, ancient),
      insertEvent(a, b, 'reconciliation', 0.1, ancient),
      insertEvent(a, c, 'conversation', -0.6, ancient), // bitter argument
      insertEvent(a, c, 'bonding', 0.5, ancient),
    ];
    const trivial = insertEvent(a, c, 'conversation', 0.2, ancient);

    pruneRelationshipEvents(NOW);
    for (const id of kept) expect(exists(id)).toBe(true);
    expect(exists(trivial)).toBe(false);
  });

  it('never deletes unprocessed events, however old', () => {
    const owed = insertEvent(a, b, 'conversation', 0.1, NOW - 30 * DAY, false);
    pruneRelationshipEvents(NOW);
    expect(exists(owed)).toBe(true);
  });

  it('bounds pivotal events to the newest few per pair and type, in either direction', () => {
    const gifts: number[] = [];
    // Alternate giver so the cap must treat a→b and b→a as one pair.
    for (let i = 0; i < PIVOTAL_EVENTS_KEPT_PER_PAIR_TYPE + 3; i++) {
      gifts.push(insertEvent(i % 2 ? a : b, i % 2 ? b : a, 'gift', 0.3, NOW - 20 * DAY + i * 60));
    }
    const fight = insertEvent(a, b, 'fight', -0.9, NOW - 25 * DAY); // other type: own cap
    const otherPairGift = insertEvent(a, c, 'gift', 0.3, NOW - 25 * DAY);

    expect(pruneRelationshipEvents(NOW)).toBe(3);
    // The three oldest gifts go; the newest `cap` stay.
    expect(gifts.slice(0, 3).map(exists)).toEqual([false, false, false]);
    expect(gifts.slice(3).every(exists)).toBe(true);
    expect(exists(fight)).toBe(true);
    expect(exists(otherPairGift)).toBe(true);
  });

  it('dates unstamped rows now instead of keeping them forever or dropping them at once', () => {
    const unstamped = insertEvent(a, b, 'conversation', 0.1, null);
    // The insert trigger stamps rows that arrive with NULL when a world exists;
    // clear it to simulate one written before the world row.
    db.update(relationshipEvents).set({ game_minute: null }).where(eq(relationshipEvents.id, unstamped)).run();

    pruneRelationshipEvents(NOW);
    const row = db.select().from(relationshipEvents).where(eq(relationshipEvents.id, unstamped)).get();
    expect(row?.game_minute).toBe(NOW);
  });
});
