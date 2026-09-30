import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, relationshipEvents, relationships } from '../../../db/schema';
import { tick as relationshipsTick } from '../relationships';
import { seductionTargets } from '../states';
import { gameMinutes } from '../../../lib/gameClock';
import type { PersonalityProfile } from '../../../lib/personality';

/**
 * The relationship tick is the one place every queued romance delta lands
 * (conversations, seduction, gifts, ripple rules, ...). It must drop a POSITIVE
 * romance delta whenever a party is a minor or the feeler is not drawn to the
 * target, whoever wrote the event, and let negative ones through.
 */

const TIME = { day: 30, hour: 10, minute: 0 };
const NOW_MINUTES = gameMinutes(TIME);
const WORLD = { time: TIME, tick_speed: 1, pending_transitions: [] };

let homeId: number;
const ids: number[] = [];

function insertAgent(name: string, age: number, gender: string, orientation: string | null): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], personality: null, age, gender, orientation,
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, created_at: 0,
    // Inactive: keeps the proximity pass away from these rows.
    is_active: false,
  }).returning({ id: agents.id }).get().id;
  ids.push(id);
  return id;
}

function insertPair(a: number, b: number): number {
  return db.insert(relationships).values({
    agent_a: Math.min(a, b), agent_b: Math.max(a, b),
    friendship_ab: 20, friendship_ba: 20, romance_ab: 10, romance_ba: 10,
    trust_ab: 0, trust_ba: 0, familiarity: 30, interaction_count: 1,
    last_interaction: 0, last_interaction_minute: NOW_MINUTES,
    average_interaction_sentiment: 0.2, tags: [], status: 'acquaintances',
    status_since_minute: NOW_MINUTES, created_at: 0, last_updated: 0,
  }).returning({ id: relationships.id }).get().id;
}

/** An event written with `a` < `b` as the tick expects, same delta both ways. */
function queue(a: number, b: number, romance: number, friendship = 3): void {
  db.insert(relationshipEvents).values({
    agent_a: Math.min(a, b), agent_b: Math.max(a, b), event_type: 'seduction', description: 'test',
    friendship_delta_ab: friendship, friendship_delta_ba: friendship,
    romance_delta_ab: romance, romance_delta_ba: romance,
    trust_delta_ab: 0, trust_delta_ba: 0, sentiment: 0.3, processed: false, timestamp: Date.now(),
  }).run();
}

const row = (id: number) => db.select().from(relationships).where(eq(relationships.id, id)).get()!;

describe('the relationship tick as the romance choke point', () => {
  beforeAll(() => {
    homeId = db.insert(locations).values({
      name: 'Choke Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 },
      entry_point: { x: 0, y: 0 }, capacity: 4, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
  });

  afterAll(() => {
    db.delete(relationshipEvents).where(inArray(relationshipEvents.agent_a, ids)).run();
    db.delete(relationships).where(inArray(relationships.agent_a, ids)).run();
    db.delete(agents).where(inArray(agents.id, ids)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
  });

  it('a positive romance event for a minor pair lands as 0, friendship still lands', () => {
    const teenMan = insertAgent('Tobias Underhill', 16, 'male', 'straight');
    const teenWoman = insertAgent('Tilda Underhill', 16, 'female', 'straight');
    const pair = insertPair(teenMan, teenWoman);
    queue(teenMan, teenWoman, 6);
    relationshipsTick(WORLD);
    expect(row(pair).romance_ab).toBe(10);
    expect(row(pair).romance_ba).toBe(10);
    expect(row(pair).friendship_ab).toBeGreaterThan(20);
  });

  it('a minor with an adult is blocked in both directions, even for a bi adult', () => {
    const teen = insertAgent('Wilhelmina Fairweather', 17, 'female', 'bi');
    const adult = insertAgent('Augustin Fairweather', 34, 'male', 'bi');
    const pair = insertPair(teen, adult);
    queue(teen, adult, 8);
    relationshipsTick(WORLD);
    expect(row(pair).romance_ab).toBe(10);
    expect(row(pair).romance_ba).toBe(10);
  });

  it('a same-gender straight pair gains no romance from a positive event', () => {
    const one = insertAgent('Ambrose Thorncastle', 30, 'male', 'straight');
    const two = insertAgent('Bertram Thorncastle', 32, 'male', 'straight');
    const pair = insertPair(one, two);
    queue(one, two, 5);
    relationshipsTick(WORLD);
    expect(row(pair).romance_ab).toBe(10);
    expect(row(pair).romance_ba).toBe(10);
    expect(row(pair).friendship_ab).toBeGreaterThan(20);
  });

  it('the gate is per direction: a gay man may gain on a straight man, not the reverse', () => {
    const gay = insertAgent('Cornelius Ashdown', 30, 'male', 'gay');
    const straight = insertAgent('Dorian Ashdown', 31, 'male', 'straight');
    const pair = insertPair(gay, straight);
    queue(gay, straight, 5);
    relationshipsTick(WORLD);
    const r = row(pair);
    const gayIsA = Math.min(gay, straight) === gay;
    expect(gayIsA ? r.romance_ab : r.romance_ba).toBeGreaterThan(10);
    expect(gayIsA ? r.romance_ba : r.romance_ab).toBe(10);
  });

  it('negative romance still applies to a blocked pair', () => {
    const one = insertAgent('Ezekiel Hollowell', 30, 'male', 'straight');
    const two = insertAgent('Fenwick Hollowell', 30, 'male', 'straight');
    const pair = insertPair(one, two);
    queue(one, two, -4);
    relationshipsTick(WORLD);
    expect(row(pair).romance_ab).toBeLessThan(10);
    expect(row(pair).romance_ba).toBeLessThan(10);
  });

  it('an eligible adult pair still gains', () => {
    const man = insertAgent('Gideon Marchbanks', 30, 'male', 'straight');
    const woman = insertAgent('Hortense Marchbanks', 28, 'female', 'straight');
    const pair = insertPair(man, woman);
    queue(man, woman, 5);
    relationshipsTick(WORLD);
    expect(row(pair).romance_ab).toBeGreaterThan(10);
    expect(row(pair).romance_ba).toBeGreaterThan(10);
  });
});

describe('seductionTargets', () => {
  const sensual: PersonalityProfile = {
    honesty: 50, aggression: 30, warmth: 50, impulsiveness: 50, vanity: 50,
    curiosity: 50, loyalty: 60, morality: 50, sensuality: 90, neuroticism: 40,
  };
  const mk = (id: number, age: number, gender: string, orientation: string | null = 'straight') => ({
    id, age, gender, orientation, personality: sensual, current_location: 5, is_active: true,
  }) as unknown as typeof agents.$inferSelect;

  it('never targets a minor, and a minor seducer never has a target', () => {
    const seducer = mk(1, 35, 'male');
    const minor = mk(2, 17, 'female');
    const adult = mk(3, 26, 'female');
    expect(seductionTargets(seducer, [seducer, minor]).map((t) => t.id)).toEqual([]);
    expect(seductionTargets(seducer, [seducer, minor, adult]).map((t) => t.id)).toEqual([3]);
    expect(seductionTargets(minor, [seducer, minor, adult])).toEqual([]);
  });

  it('skips people the pair could not be drawn to, and other rooms', () => {
    const seducer = mk(1, 35, 'male');
    const otherMan = mk(2, 30, 'male');
    const elsewhere = { ...mk(3, 30, 'female'), current_location: 9 } as typeof agents.$inferSelect;
    expect(seductionTargets(seducer, [seducer, otherMan, elsewhere])).toEqual([]);
  });
});
