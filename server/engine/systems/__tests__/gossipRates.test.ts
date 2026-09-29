import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '../../../db';
import { agents, locations, shared_knowledge } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { gossipTick } from '../gossipEngine';
import type { PersonalityProfile } from '../../../lib/personality';

/**
 * The gossip rolls (2% active sharing per game minute) used to be rolled once
 * per tick, so at 4x the town gossiped a quarter as much per game hour and a
 * 30-minute night-skip tick barely rolled at all. They go through chancePerTick
 * now: the same roll value that fails at 1x succeeds when the tick covers
 * several game minutes.
 */

const GOSSIP: PersonalityProfile = {
  honesty: 5, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 90, loyalty: 5, morality: 5, sensuality: 50, neuroticism: 50,
};
const QUIET: PersonalityProfile = { ...GOSSIP, curiosity: 10, honesty: 90 };

function insertLocation(name: string): number {
  return db.insert(locations).values({
    name, type: 'tavern',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 1, y: 4 },
    owner: null, capacity: 10, current_occupants: [], operating_hours: null,
    services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, at: number, personality: PersonalityProfile): number {
  return db.insert(agents).values({
    name, bio: 'test', traits: [], personality, age: 30, gender: 'male',
    sprite_sheet: 'x', portrait_sprite: 'x',
    position: { x: 0, y: 0 }, current_destination: null, current_location: at,
    current_action: { type: 'idle' }, action_started: 0, action_duration: null,
    action_queue: [], current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: at, workplace: null, created_at: Date.now(), is_active: true,
  }).returning({ id: agents.id }).get().id;
}

let lastFactId = 0;
function insertFact(subjectId: number, knownBy: number[]): number {
  lastFactId = db.insert(shared_knowledge).values({
    type: 'crush', subject_id: subjectId, target_id: null,
    content: 'Rate Carlos owes money to the baker.', sensitivity: 3,
    known_by: knownBy, created_at: Date.now(), is_active: true, source: 'observed',
  }).returning({ id: shared_knowledge.id }).get().id;
  return lastFactId;
}

const knownBy = (id: number) =>
  db.select().from(shared_knowledge).where(eq(shared_knowledge.id, id)).get()!.known_by as number[];

describe('gossip chances are per game minute, not per tick', () => {
  let teller: number;
  let listener: number;
  let carlos: number;

  beforeAll(() => {
    const plaza = insertLocation('rate plaza');
    const faraway = insertLocation('rate faraway');
    teller = insertAgent('Rate Teller', plaza, GOSSIP);
    listener = insertAgent('Rate Listener', plaza, QUIET);
    carlos = insertAgent('Rate Carlos', faraway, QUIET);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // One live fact per test, so the fact pick never lands on a leftover.
    db.update(shared_knowledge).set({ is_active: false }).where(eq(shared_knowledge.id, lastFactId)).run();
  });

  it('a 5% roll misses the 2%/minute share at 1x', () => {
    const fact = insertFact(carlos, [carlos, teller]);
    vi.spyOn(Math, 'random').mockReturnValue(0.05);
    gossipTick(0, 1);
    expect(knownBy(fact)).not.toContain(listener);
  });

  it('the same roll lands at 4x (1 - 0.98^4 = 7.8% per tick)', () => {
    const fact = insertFact(carlos, [carlos, teller]);
    vi.spyOn(Math, 'random').mockReturnValue(0.05);
    gossipTick(0, 4);
    expect(knownBy(fact)).toContain(listener);
  });

  it('a 30-minute night-skip tick is a proper roll, not an overflow', () => {
    const fact = insertFact(carlos, [carlos, teller]);
    // 1 - 0.98^30 = 45%: a 0.9 roll still misses, a 0.3 roll lands.
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    gossipTick(0, 30);
    expect(knownBy(fact)).not.toContain(listener);
    vi.spyOn(Math, 'random').mockReturnValue(0.3);
    gossipTick(0, 30);
    expect(knownBy(fact)).toContain(listener);
  });

  it('defaults to one game minute per tick', () => {
    const fact = insertFact(carlos, [carlos, teller]);
    vi.spyOn(Math, 'random').mockReturnValue(0.05);
    gossipTick(0);
    expect(knownBy(fact)).not.toContain(listener);
  });
});
