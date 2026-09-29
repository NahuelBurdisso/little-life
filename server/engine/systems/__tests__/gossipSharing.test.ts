import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { db } from '../../../db';
import { activityLog, agents, locations, shared_knowledge } from '../../../db/schema';
import { desc, eq } from 'drizzle-orm';
import { gossipTick } from '../gossipEngine';
import { getShareableFacts } from '../../../lib/gossip';
import type { PersonalityProfile } from '../../../lib/personality';

/**
 * Playtest: Marco "told" four people that Marco was secretly in love with
 * Carlos, and Diego told Lucia that Diego had a crush on Lucia. The subject of a
 * secret always knows it, so every gossip filter has to skip it explicitly.
 */

const GOSSIP: PersonalityProfile = {
  honesty: 5, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 90, loyalty: 5, morality: 5, sensuality: 50, neuroticism: 50,
};
// Below every curiosity gate, so this agent neither gossips nor snoops.
const QUIET: PersonalityProfile = { ...GOSSIP, curiosity: 10, honesty: 90 };

function insertLocation(name: string): number {
  return db.insert(locations).values({
    name,
    type: 'tavern',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 1, y: 4 },
    owner: null,
    capacity: 10,
    current_occupants: [],
    operating_hours: null,
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, at: number, personality: PersonalityProfile | null): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality,
    age: 30,
    gender: 'male',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 0, y: 0 },
    current_destination: null,
    current_location: at,
    current_action: { type: 'idle' },
    action_started: 0,
    action_duration: null,
    action_queue: [],
    current_path: null,
    schedule: {
      wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [],
    },
    home: at,
    workplace: null,
    created_at: Date.now(),
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function insertFact(subjectId: number, content: string, knownBy: number[]): number {
  return db.insert(shared_knowledge).values({
    type: 'crush',
    subject_id: subjectId,
    target_id: null,
    content,
    sensitivity: 3,
    known_by: knownBy,
    created_at: Date.now(),
    is_active: true,
    source: 'observed',
  }).returning({ id: shared_knowledge.id }).get().id;
}

function knownBy(factId: number): number[] {
  return db.select().from(shared_knowledge).where(eq(shared_knowledge.id, factId)).get()!.known_by as number[];
}

describe('agents never gossip their own secrets', () => {
  let marco: number;
  let lucia: number;
  let carlos: number;

  beforeAll(() => {
    const plaza = insertLocation('own-secret plaza');
    const faraway = insertLocation('own-secret faraway');
    marco = insertAgent('Own Marco', plaza, GOSSIP);
    lucia = insertAgent('Own Lucia', plaza, QUIET);
    carlos = insertAgent('Own Carlos', faraway, QUIET);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('active gossip shares what Marco knows about others, never his own secret', () => {
    const own = insertFact(marco, 'Own Marco is deeply in love with Own Carlos.', [marco]);
    const other = insertFact(carlos, 'Own Carlos owes money to the baker.', [carlos, marco]);
    // Every roll succeeds: the gossip gate, the target pick and the fact pick
    // all land on index 0, so only the filter decides what gets told.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    gossipTick(0);

    expect(knownBy(own)).not.toContain(lucia);
    expect(knownBy(other)).toContain(lucia);

    // The feed line splices the fact in once, with exactly one full stop.
    const told = db.select().from(activityLog)
      .where(eq(activityLog.type, 'drama')).orderBy(desc(activityLog.id)).all()
      .map((r) => (r.template_data as { description?: string }).description)
      .find((d) => d?.startsWith('Own Marco told'));
    expect(told).toBe('Own Marco told Own Lucia that Own Carlos owes money to the baker.');
  });

  it('getShareableFacts leaves out facts whose subject is the speaker', () => {
    const own = insertFact(marco, 'Own Marco has a crush on Own Lucia.', [marco]);
    const other = insertFact(carlos, 'Own Carlos hides a chronic illness.', [carlos, marco]);

    const ids = getShareableFacts(marco, lucia, GOSSIP).map((f) => f.id);

    expect(ids).not.toContain(own);
    expect(ids).toContain(other);
  });
});

/**
 * Playtest #2 (G7): "Diego Santos told Marco Rivera that Yuki Tanaka spotted
 * Diego Santos at a secret meeting". A sighting is the seen person's secret,
 * and a confirmed fact is never told to the person it is about.
 */
describe('sightings are never self-gossip', () => {
  let yuki: number;
  let diego: number;
  let marco: number;

  function insertSighting(subject: number, target: number, content: string, known: number[]): number {
    return db.insert(shared_knowledge).values({
      type: 'witness',
      subject_id: subject,
      target_id: target,
      content,
      sensitivity: 2,
      known_by: known,
      created_at: Date.now(),
      is_active: true,
      source: 'backstory',
    }).returning({ id: shared_knowledge.id }).get().id;
  }

  beforeAll(() => {
    const square = insertLocation('sighting square');
    yuki = insertAgent('Sight Yuki', square, GOSSIP);
    diego = insertAgent('Sight Diego', square, GOSSIP);
    marco = insertAgent('Sight Marco', square, GOSSIP);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the witness may tell it; the person seen never does, and is never told it', () => {
    const fact = insertSighting(diego, yuki, 'Sight Yuki spotted Sight Diego at a secret meeting.', [yuki, diego]);

    expect(getShareableFacts(diego, marco, GOSSIP).map((f) => f.id)).not.toContain(fact);
    expect(getShareableFacts(yuki, marco, GOSSIP).map((f) => f.id)).toContain(fact);

    const other = insertSighting(marco, yuki, 'Sight Yuki spotted Sight Marco at the docks.', [yuki]);
    // Yuki knows a sighting of Marco; Marco is the listener: not gossip for him.
    expect(getShareableFacts(yuki, marco, GOSSIP).map((f) => f.id)).not.toContain(other);
    expect(getShareableFacts(yuki, diego, GOSSIP).map((f) => f.id)).toContain(other);
  });

  it('the gossip tick never tells a confirmed fact to its subject, and phrases the teller as "she"', () => {
    // Fresh place with only the witness and the person seen.
    const lane = insertLocation('sighting lane');
    const witness = insertAgent('Lane Yuki', lane, GOSSIP);
    const seen = insertAgent('Lane Diego', lane, QUIET);
    db.update(agents).set({ gender: 'female' }).where(eq(agents.id, witness)).run();
    const fact = insertSighting(seen, witness, 'Lane Yuki spotted Lane Diego at a secret meeting.', [witness]);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    gossipTick(0);
    expect(knownBy(fact)).not.toContain(seen);

    // With a third person there, Yuki tells them — in her own words.
    const listener = insertAgent('Lane Marco', lane, QUIET);
    db.update(agents).set({ current_location: null }).where(eq(agents.id, seen)).run();
    gossipTick(0);
    expect(knownBy(fact)).toContain(listener);
    const told = db.select().from(activityLog)
      .where(eq(activityLog.type, 'drama')).orderBy(desc(activityLog.id)).all()
      .map((r) => (r.template_data as { description?: string }).description)
      .find((d) => d?.startsWith('Lane Yuki told'));
    expect(told).toBe('Lane Yuki told Lane Marco that she spotted Lane Diego at a secret meeting.');
  });
});
