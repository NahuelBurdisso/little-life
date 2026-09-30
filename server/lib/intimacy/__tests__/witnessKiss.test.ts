import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import { activityLog, agents, locations, relationshipEvents, relationships, shared_knowledge } from '../../../db/schema';
import { isOpenCouple, kissSeenSensitivity, onKissConversationEnded, registerKissListener, witnessKiss } from '../kiss';
import { clearIntimacy } from '../state';
import { getShareableFacts, isOwnSecret, mayBeToldTo, renderFact } from '../../gossip';
import { simEvents } from '../../simEvents';
import { ENGAGED_TAG, MARRIED_TAG } from '../../marriage';
import type { PersonalityProfile } from '../../personality';

/**
 * A stolen kiss can be seen. Whoever is there learns "X was seen kissing Y" as a
 * secret whose weight depends on who is spoken for; the two never gossip about
 * it; and a couple that is openly together kissing is not news.
 */

let homeId: number;
const made: number[] = [];

function insertAgent(name: string, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  return id;
}

function relate(x: number, y: number, over: Partial<typeof relationships.$inferInsert> = {}): void {
  db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y),
    friendship_ab: 60, friendship_ba: 60, romance_ab: 60, romance_ba: 60, trust_ab: 50, trust_ba: 50,
    familiarity: 50, interaction_count: 5, last_interaction: 0, average_interaction_sentiment: 0,
    tags: [], status: 'romantic_interest', created_at: 0, last_updated: 0, ...over,
  }).run();
}

/** A woman and a man, plus one bystander. */
function scene() {
  const a = insertAgent(`Lover ${made.length}`, { gender: 'female' });
  const b = insertAgent(`Beloved ${made.length}`, { gender: 'male' });
  const witness = insertAgent(`Bystander ${made.length}`, { gender: 'female' });
  return { a, b, witness };
}

const seenFacts = (id: number) => db.select().from(shared_knowledge).where(eq(shared_knowledge.type, 'kiss_seen')).all()
  .filter((f) => f.subject_id === id || f.target_id === id);
const payload = (a: number, b: number, witnessIds: number[]) => ({ a, b, first: true, witnessIds });

const talker: PersonalityProfile = {
  honesty: 20, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
  curiosity: 50, loyalty: 20, morality: 20, sensuality: 50, neuroticism: 40,
};

describe('a kiss seen', () => {
  beforeAll(() => {
    registerKissListener();
    homeId = db.insert(locations).values({
      name: 'Witness Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 20, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
  });

  beforeEach(() => {
    clearIntimacy();
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  afterAll(() => {
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, made), inArray(shared_knowledge.target_id, made))).run();
    db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, made), inArray(relationshipEvents.agent_b, made))).run();
    db.delete(activityLog).where(inArray(activityLog.type, ['first_kiss', 'kiss', 'kiss_rebuffed'])).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
    db.delete(agents).where(inArray(agents.id, made)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
    clearIntimacy();
  });

  it('the witness learns a kiss_seen secret; the two are not told and do not spread it', () => {
    const { a, b, witness } = scene();
    relate(a, b);
    witnessKiss(payload(a, b, [witness]));

    const facts = seenFacts(a);
    expect(facts).toHaveLength(1);
    const f = facts[0];
    expect(f).toMatchObject({ type: 'kiss_seen', subject_id: a, target_id: b, sensitivity: 2, source: 'observed' });
    expect(f.content).toMatch(/was seen kissing/);
    expect(f.known_by).toEqual([witness]);

    // Neither of them gossips about it, and it is not offered to them as news either.
    expect(isOwnSecret(f, a)).toBe(true);
    expect(isOwnSecret(f, b)).toBe(true);
    expect(mayBeToldTo(f, a)).toBe(false);
    expect(mayBeToldTo(f, b)).toBe(false);
    expect(isOwnSecret(f, witness)).toBe(false);
    // The witness, on the other hand, has it to tell (to a third party who does not know it).
    const stranger = insertAgent('Somebody Else', { gender: 'male' });
    relate(witness, stranger, { friendship_ab: 10, friendship_ba: 10 });
    expect(getShareableFacts(witness, stranger, talker).map((x) => x.id)).toContain(f.id);
    // ... and even a forced-in participant would not be allowed to.
    db.update(shared_knowledge).set({ known_by: [witness, a] }).where(eq(shared_knowledge.id, f.id)).run();
    expect(getShareableFacts(a, stranger, talker).map((x) => x.id)).not.toContain(f.id);
  });

  it('is the same fact whichever of the two led, and a second witness is added to it', () => {
    const { a, b, witness } = scene();
    const second = insertAgent('Second Bystander', { gender: 'male' });
    relate(a, b);
    witnessKiss(payload(a, b, [witness]));
    witnessKiss(payload(b, a, [second]));
    const facts = seenFacts(a);
    expect(facts).toHaveLength(1);
    expect((facts[0].known_by as number[]).sort()).toEqual([witness, second].sort());
  });

  it('nobody watching, nothing learned', () => {
    const { a, b } = scene();
    relate(a, b);
    witnessKiss(payload(a, b, []));
    expect(seenFacts(a)).toHaveLength(0);
  });

  it('sensitivity is 3 when one is engaged or married to somebody else, 4 when a marriage is betrayed', () => {
    const free = scene();
    relate(free.a, free.b);
    expect(kissSeenSensitivity(free.a, free.b)).toBe(2);

    const engaged = scene();
    const fiance = insertAgent('Fiance', { gender: 'male' });
    relate(engaged.a, engaged.b);
    relate(engaged.a, fiance, { tags: [ENGAGED_TAG], status: 'partners' });
    expect(kissSeenSensitivity(engaged.a, engaged.b)).toBe(3);
    // Either side being the one spoken for counts.
    expect(kissSeenSensitivity(engaged.b, engaged.a)).toBe(3);

    const married = scene();
    const husband = insertAgent('Husband', { gender: 'male' });
    relate(married.a, married.b);
    relate(married.a, husband, { tags: [MARRIED_TAG], status: 'partners' });
    expect(kissSeenSensitivity(married.a, married.b)).toBe(4);

    witnessKiss(payload(married.a, married.b, [married.witness]));
    expect(seenFacts(married.a)[0]).toMatchObject({ sensitivity: 4 });
    witnessKiss(payload(engaged.a, engaged.b, [engaged.witness]));
    expect(seenFacts(engaged.a)[0]).toMatchObject({ sensitivity: 3 });
  });

  it('partners, an engaged couple and a married one kissing are not news', () => {
    for (const rel of [
      { tags: ['partner'], status: 'partners' },
      { tags: [ENGAGED_TAG], status: 'partners' },
      { tags: [MARRIED_TAG], status: 'partners' },
    ]) {
      const { a, b, witness } = scene();
      relate(a, b, rel);
      expect(isOpenCouple(a, b)).toBe(true);
      witnessKiss(payload(a, b, [witness]));
      expect(seenFacts(a), JSON.stringify(rel)).toHaveLength(0);
    }
  });

  it('"partners" with somebody else\'s husband is not an open couple', () => {
    const { a, b, witness } = scene();
    const husband = insertAgent('Somebody Else Husband', { gender: 'male' });
    relate(a, b, { tags: ['partner'], status: 'partners' });
    relate(a, husband, { tags: [MARRIED_TAG], status: 'partners' });
    expect(isOpenCouple(a, b)).toBe(false);
    witnessKiss(payload(a, b, [witness]));
    expect(seenFacts(a)).toHaveLength(1);
    expect(seenFacts(a)[0].sensitivity).toBe(4);
  });

  it('a pair with no relationship row yet is not an open couple', () => {
    const { a, b } = scene();
    expect(isOpenCouple(a, b)).toBe(false);
  });

  it('the whole path: a warm talk in a room with a neighbour ends in a kiss they saw', () => {
    const { a, b, witness } = scene();
    relate(a, b, { romance_ab: 80, romance_ba: 70, status: 'romantic_interest', tags: ['partner'] });
    onKissConversationEnded({ agentId: a, perpetratorId: b, conversationId: 5, sentiment: 0.8 }, () => 0);
    const facts = seenFacts(a);
    expect(facts).toHaveLength(1);
    expect(facts[0].known_by).toEqual([witness]);
  });

  it('the listener registers once, so one kiss makes one event and one fact', () => {
    registerKissListener();
    registerKissListener();
    const { a, b, witness } = scene();
    relate(a, b);
    simEvents.emit('intimacy:kiss', payload(a, b, [witness]));
    expect(seenFacts(a)).toHaveLength(1);
  });

  it('reads discreetly', () => {
    expect(renderFact('kiss_seen', 'Ada', 'Bruno')).toBe('Ada was seen kissing Bruno');
    expect(renderFact('tryst_seen', 'Ada', 'Bruno')).toBe("Ada was seen leaving Bruno's house at dawn");
  });
});
