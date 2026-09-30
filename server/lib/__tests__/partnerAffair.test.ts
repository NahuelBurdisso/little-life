import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agentStates, agents, locations, relationships, shared_knowledge } from '../../db/schema';
import { reactToPartnerAffair, pairRelationship, type BeatAgent } from '../conversationBeats';
import { addKnowers, createFact, learnFact } from '../gossip';

/**
 * A partner who learns of an affair reacts in conversation (conversationBeats.reactToPartnerAffair),
 * and the secrets that make it happen are minted with learnFact (create or add knowers).
 */

let homeId: number;
let ids: number[] = [];
let [discoverer, partner, lover, witness, other] = [0, 0, 0, 0, 0];

const QUIET = { aggression: 10, loyalty: 10 };
const RAGE = { aggression: 90, loyalty: 10 };

function insertAgent(name: string): number {
  return db.insert(agents).values({
    name, bio: 'test', traits: [], personality: null, age: 30, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, created_at: 0, is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function beat(id: number, name: string, personality: unknown = QUIET): BeatAgent {
  return { id, name, personality };
}

function partnerUp(a: number, b: number, tags: string[] = ['partner']): void {
  db.insert(relationships).values({
    agent_a: Math.min(a, b), agent_b: Math.max(a, b),
    friendship_ab: 60, friendship_ba: 60, romance_ab: 80, romance_ba: 80,
    trust_ab: 50, trust_ba: 50, familiarity: 60, interaction_count: 10,
    last_interaction: 0, last_interaction_minute: 0, average_interaction_sentiment: 0.3,
    tags, status: 'partners', created_at: 0, last_updated: 0,
  }).run();
}

function knownBy(factId: number | null): number[] {
  return db.select({ k: shared_knowledge.known_by }).from(shared_knowledge)
    .where(eq(shared_knowledge.id, factId!)).get()!.k as number[];
}

beforeAll(() => {
  homeId = db.insert(locations).values({
    name: 'Partner Affair Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 0, y: 0 }, capacity: 4, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  discoverer = insertAgent('Delphine Ashby');
  partner = insertAgent('Percival Ashby');
  lover = insertAgent('Lavinia Crowe');
  witness = insertAgent('Wendell Marsh');
  other = insertAgent('Odette Vane');
  ids = [discoverer, partner, lover, witness, other];
});

afterAll(() => {
  db.delete(activityLog).where(or(inArray(activityLog.initiator_id, ids), inArray(activityLog.target_id, ids))).run();
  db.delete(agentStates).where(inArray(agentStates.agent_id, ids)).run();
  db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, ids), inArray(shared_knowledge.target_id, ids))).run();
  db.delete(relationships).where(or(inArray(relationships.agent_a, ids), inArray(relationships.agent_b, ids))).run();
  db.delete(agents).where(inArray(agents.id, ids)).run();
  db.delete(locations).where(eq(locations.id, homeId)).run();
});

beforeEach(() => {
  db.delete(agentStates).where(inArray(agentStates.agent_id, ids)).run();
  db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, ids), inArray(shared_knowledge.target_id, ids))).run();
  db.delete(relationships).where(or(inArray(relationships.agent_a, ids), inArray(relationships.agent_b, ids))).run();
  partnerUp(discoverer, partner);
});

describe('reactToPartnerAffair', () => {
  const react = (personality: unknown = QUIET) =>
    reactToPartnerAffair(beat(discoverer, 'Delphine Ashby', personality), beat(partner, 'Percival Ashby'), 1000);

  it('notices an affair whose subject is the partner', () => {
    createFact('affair', partner, lover, 3, [discoverer], 'observed');
    expect(react()).toBe(true);
  });

  it('notices an affair whose TARGET is the partner (the fact is stored either way round)', () => {
    createFact('affair', lover, partner, 3, [discoverer], 'observed');
    expect(react()).toBe(true);
  });

  it('ignores an affair the discoverer does not know of', () => {
    createFact('affair', partner, lover, 3, [witness], 'observed');
    expect(react()).toBe(false);
  });

  it('ignores an affair between other people', () => {
    createFact('affair', lover, other, 3, [discoverer], 'observed');
    expect(react()).toBe(false);
  });

  it('does not count a fact about the discoverer themselves as their partner betraying them', () => {
    // "Delphine and Percival are getting suspiciously close" is their own relationship, not an
    // affair behind Delphine's back: the discoverer is the target here, and the subject below.
    createFact('affair', partner, discoverer, 3, [discoverer], 'observed');
    expect(react()).toBe(false);
    db.delete(shared_knowledge).where(inArray(shared_knowledge.subject_id, ids)).run();
    createFact('affair', discoverer, partner, 3, [discoverer], 'observed');
    expect(react()).toBe(false);
  });

  it('still reacts when the partner has an affair with someone else alongside such a fact', () => {
    createFact('affair', partner, discoverer, 3, [discoverer], 'observed');
    createFact('affair', partner, lover, 3, [discoverer], 'observed');
    expect(react()).toBe(true);
  });

  it('a quiet breakup drops the partner tag in the same write', () => {
    // updateTags only runs later; until then the pair would read as partnered.
    db.delete(relationships).where(or(inArray(relationships.agent_a, ids), inArray(relationships.agent_b, ids))).run();
    partnerUp(discoverer, partner, ['partner', 'married', 'trusted']);
    createFact('affair', partner, lover, 3, [discoverer], 'observed');
    expect(react(QUIET)).toBe(true);
    const rel = pairRelationship(discoverer, partner)!;
    expect(rel.status).toBe('acquaintances');
    expect(rel.tags).not.toContain('partner');
    expect(rel.tags).not.toContain('married');
    expect(rel.tags).toContain('trusted');
  });

  it('a rage breakup drops it too', () => {
    createFact('affair', partner, lover, 3, [discoverer], 'observed');
    expect(react(RAGE)).toBe(true);
    const rel = pairRelationship(discoverer, partner)!;
    expect(rel.status).toBe('rivals');
    expect(rel.tags).not.toContain('partner');
    expect(rel.tags).toContain('grudge');
  });
});

describe('learnFact (create or add knowers)', () => {
  it('creates the fact with its knowers', () => {
    const id = learnFact('affair', partner, lover, 3, [witness], 'observed');
    expect(id).not.toBeNull();
    expect(knownBy(id)).toEqual([witness]);
  });

  it('a second call adds the new knowers without duplicating the row or the ids', () => {
    const first = learnFact('affair', partner, lover, 3, [witness], 'observed');
    const second = learnFact('affair', partner, lover, 3, [witness, other, other], 'observed');
    expect(second).toBe(first);
    expect(knownBy(first).sort()).toEqual([witness, other].sort());
    const rows = db.select().from(shared_knowledge).where(eq(shared_knowledge.subject_id, partner)).all()
      .filter((f) => f.type === 'affair' && f.target_id === lover);
    expect(rows).toHaveLength(1);
  });

  it('leaves a public fact alone but still returns its id', () => {
    const id = learnFact('affair', partner, lover, 3, [witness], 'observed');
    db.update(shared_knowledge).set({ is_public: true }).where(eq(shared_knowledge.id, id!)).run();
    // A public fact of the same wording dedupes in createFact, so it is "the" fact.
    const again = learnFact('affair', partner, lover, 3, [other], 'observed');
    expect(again).toBe(id);
    expect(knownBy(id)).toEqual([witness]);
  });

  it('addKnowers ignores a missing row', () => {
    expect(() => addKnowers(-1, [witness])).not.toThrow();
  });
});
