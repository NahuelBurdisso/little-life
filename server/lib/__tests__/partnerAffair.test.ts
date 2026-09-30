import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agentStates, agents, locations, relationshipEvents, relationships, shared_knowledge } from '../../db/schema';
import { simEvents } from '../simEvents';
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
  db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, ids), inArray(relationshipEvents.agent_b, ids))).run();
  db.delete(activityLog).where(or(inArray(activityLog.initiator_id, ids), inArray(activityLog.target_id, ids))).run();
  db.delete(agentStates).where(inArray(agentStates.agent_id, ids)).run();
  db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, ids), inArray(shared_knowledge.target_id, ids))).run();
  db.delete(relationships).where(or(inArray(relationships.agent_a, ids), inArray(relationships.agent_b, ids))).run();
  db.delete(agents).where(inArray(agents.id, ids)).run();
  db.delete(locations).where(eq(locations.id, homeId)).run();
});

beforeEach(() => {
  // The pair's own discovery beats mark when it last reacted: a test's leftovers must not mute the next one.
  db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, ids), inArray(relationshipEvents.agent_b, ids))).run();
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

describe('what discovering an affair leaves behind', () => {
  const found = (personality: unknown) => {
    const memories: Array<{ agentId: number; description: string; importance: number; relatedAgentId?: number }> = [];
    const onMemory = (p: { agentId: number; description: string; importance: number; relatedAgentId?: number }) => memories.push(p);
    simEvents.on('life:milestone', onMemory);
    try {
      createFact('affair', partner, lover, 3, [discoverer], 'observed');
      reactToPartnerAffair(beat(discoverer, 'Delphine Ashby', personality), beat(partner, 'Percival Ashby'), 1000);
    } finally { simEvents.off('life:milestone', onMemory); }
    return memories;
  };
  const storyBeats = () => db.select().from(relationshipEvents)
    .where(inArray(relationshipEvents.event_type, ['affair_discovered'])).all()
    .filter((e) => [e.agent_a, e.agent_b].every((id) => [discoverer, partner].includes(id)));

  // Rage, forgiveness and a quiet parting all leave the discoverer with the memory and the pair with a beat:
  // the forgiving branch wrote nothing at all before, so a wife who chose to stay had no story.
  for (const [name, personality] of [['a rage', RAGE], ['forgiveness', { aggression: 10, loyalty: 90 }], ['a quiet parting', QUIET]] as const) {
    it(`${name}: the discoverer remembers it (weighs 9) and the pair has a pivotal chronicle beat`, () => {
      const before = storyBeats().length;
      const memories = found(personality);
      expect(memories).toEqual([expect.objectContaining({
        agentId: discoverer, importance: 9, relatedAgentId: partner,
        description: 'I found out that Percival Ashby has been unfaithful to me.',
      })]);
      const beats = storyBeats().slice(before);
      expect(beats).toHaveLength(1);
      expect(beats[0]).toMatchObject({ description: "Delphine Ashby found out about Percival Ashby's affair" });
      // Pure story: the branch's own writes (trust, status, states) already moved the numbers.
      expect(beats[0]).toMatchObject({ friendship_delta_ab: 0, friendship_delta_ba: 0, trust_delta_ab: 0, trust_delta_ba: 0, romance_delta_ab: 0, romance_delta_ba: 0 });
      expect(Math.abs(beats[0].sentiment)).toBeGreaterThanOrEqual(0.5);
    });
  }

  // A 30-day soak logged 96 `affair_discovered` beats for about 25 pairs (8 for one pair): a partner who forgave
  // (loyal, not aggressive) stayed partnered, so the same fact matched at EVERY later conversation with the
  // partner, each time a new memory, a pivotal beat and another -30 trust.
  it('a forgiven affair is reacted to once: the same fact does not hurt again at the next talk', () => {
    const forgiving = { aggression: 10, loyalty: 90 };
    const fact = createFact('affair', partner, lover, 3, [discoverer], 'observed');
    db.update(shared_knowledge).set({ created_at: 1 }).where(eq(shared_knowledge.id, fact!)).run();
    const before = storyBeats().length;
    const trust = () => pairRelationship(discoverer, partner)!.trust_ab;

    expect(reactToPartnerAffair(beat(discoverer, 'Delphine Ashby', forgiving), beat(partner, 'Percival Ashby'), 1000)).toBe(true);
    expect(trust()).toBe(20);
    expect(reactToPartnerAffair(beat(discoverer, 'Delphine Ashby', forgiving), beat(partner, 'Percival Ashby'), 1100)).toBe(false);
    expect(reactToPartnerAffair(beat(discoverer, 'Delphine Ashby', forgiving), beat(partner, 'Percival Ashby'), 1200)).toBe(false);
    expect(storyBeats().length - before).toBe(1);
    expect(trust()).toBe(20);
  });

  it('... but a NEW affair after the forgiveness is a new betrayal', () => {
    const forgiving = { aggression: 10, loyalty: 90 };
    const first = createFact('affair', partner, lover, 3, [discoverer], 'observed');
    db.update(shared_knowledge).set({ created_at: 1 }).where(eq(shared_knowledge.id, first!)).run();
    const before = storyBeats().length;
    const go = () => reactToPartnerAffair(beat(discoverer, 'Delphine Ashby', forgiving), beat(partner, 'Percival Ashby'), 1000);
    expect(go()).toBe(true);
    expect(go()).toBe(false);
    const second = createFact('affair', partner, other, 3, [discoverer], 'observed');
    db.update(shared_knowledge).set({ created_at: Date.now() + 60_000 }).where(eq(shared_knowledge.id, second!)).run();
    expect(go()).toBe(true);
    expect(storyBeats().length - before).toBe(2);
  });

  it('the other partner discovering their own side is not muted by the first discovery', () => {
    const forgiving = { aggression: 10, loyalty: 90 };
    const theirs = createFact('affair', discoverer, other, 3, [partner], 'observed');
    db.update(shared_knowledge).set({ created_at: 1 }).where(eq(shared_knowledge.id, theirs!)).run();
    const mine = createFact('affair', partner, lover, 3, [discoverer], 'observed');
    db.update(shared_knowledge).set({ created_at: 1 }).where(eq(shared_knowledge.id, mine!)).run();
    expect(reactToPartnerAffair(beat(discoverer, 'Delphine Ashby', forgiving), beat(partner, 'Percival Ashby'), 1000)).toBe(true);
    expect(reactToPartnerAffair(beat(partner, 'Percival Ashby', forgiving), beat(discoverer, 'Delphine Ashby'), 1000)).toBe(true);
  });

  it('nothing at all without a personality to react with', () => {
    createFact('affair', partner, lover, 3, [discoverer], 'observed');
    const before = storyBeats().length;
    expect(reactToPartnerAffair(beat(discoverer, 'Delphine Ashby', null), beat(partner, 'Percival Ashby'), 1000)).toBe(false);
    expect(storyBeats()).toHaveLength(before);
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
