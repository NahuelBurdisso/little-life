import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations, shared_knowledge } from '../../../db/schema';
import { getShareableFacts, isAdultsOnlyFact, createFact } from '../../gossip';
import { gossipTick } from '../../../engine/systems/gossipEngine';
import { onlookersNear, witnessesOf } from '../witnesses';
import type { PersonalityProfile } from '../../personality';

/**
 * Nobody under 18 is ever a witness to, a teller of, or a listener to anything
 * about romance or a night together: the witness lists are adults only, and the
 * gossip paths refuse the romantic fact types at either end when one is a minor.
 */

let homeId: number;
const made: number[] = [];
const everMade: number[] = [];

function insertAgent(name: string, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 20, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 90, loyalty: 20, morality: 20, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  everMade.push(id);
  return id;
}

const talker: PersonalityProfile = {
  honesty: 20, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
  curiosity: 50, loyalty: 20, morality: 20, sensuality: 50, neuroticism: 40,
};

const ROMANTIC = ['kiss_seen', 'tryst_seen', 'illegitimate_pregnancy', 'affair', 'seduction'];

describe('minors never witness, hear or tell romance', () => {
  beforeAll(() => {
    homeId = db.insert(locations).values({
      name: 'Minor Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 20, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
  });
  beforeEach(() => {
    // Only the current test's cast counts: retire the previous one.
    if (made.length > 0) db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
    made.length = 0;
  });
  afterAll(() => {
    vi.restoreAllMocks();
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, everMade), inArray(shared_knowledge.target_id, everMade))).run();
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, everMade)).run();
  });

  describe('witnesses', () => {
    it('a child in the room is not a witness; an adult is (indoors)', () => {
      const a = insertAgent('Wit A');
      const b = insertAgent('Wit B', { gender: 'male' });
      const adult = insertAgent('Wit Adult');
      const child = insertAgent('Wit Child', { age: 12 });
      const teen = insertAgent('Wit Teen', { age: 17 });
      const ids = witnessesOf(
        { id: a, current_location: homeId, position: { x: 0, y: 0 } },
        { id: b, current_location: homeId, position: { x: 0, y: 0 } },
      );
      expect(ids).toContain(adult);
      expect(ids).not.toContain(child);
      expect(ids).not.toContain(teen);
    });

    it('nor outdoors within range', () => {
      const child = insertAgent('Wit Street Child', { age: 10, current_location: null, position: { x: 10, y: 10 } });
      const adult = insertAgent('Wit Street Adult', { current_location: null, position: { x: 12, y: 10 } });
      const ids = onlookersNear({ current_location: null, position: { x: 10, y: 10 } }, []);
      expect(ids).toContain(adult);
      expect(ids).not.toContain(child);
    });
  });

  describe('getShareableFacts', () => {
    const put = (type: string, subject: number, target: number, sensitivity: number, knownBy: number[]) => {
      createFact(type, subject, target, sensitivity, knownBy, 'observed');
    };

    it('never offers a romantic fact to a minor listener, or from a minor teller', () => {
      const s1 = insertAgent('Subj One');
      const s2 = insertAgent('Subj Two', { gender: 'male' });
      const teller = insertAgent('Teller');
      const adultListener = insertAgent('Adult Ear');
      const minorListener = insertAgent('Minor Ear', { age: 14 });
      const minorTeller = insertAgent('Minor Teller', { age: 15 });
      for (const type of ROMANTIC) put(type, s1, s2, 2, [s1, s2, teller, minorTeller]);

      // The adult control: romantic facts do reach an adult (the sensitivity gates cap it at three).
      const toAdult = getShareableFacts(teller, adultListener, talker).map((f) => f.type);
      expect(toAdult.length).toBeGreaterThan(0);
      expect(getShareableFacts(teller, minorListener, talker).filter((f) => ROMANTIC.includes(f.type))).toEqual([]);
      expect(getShareableFacts(minorTeller, adultListener, talker).filter((f) => ROMANTIC.includes(f.type))).toEqual([]);
    });

    it('an unwed pregnancy (sensitivity 3) is romantic; a married one (2) is family news', () => {
      const mother = insertAgent('Mother One');
      const father = insertAgent('Father One', { gender: 'male' });
      const wife = insertAgent('Wife Two');
      const husband = insertAgent('Husband Two', { gender: 'male' });
      const teller = insertAgent('Teller Two');
      const kid = insertAgent('Kid Ear', { age: 13 });
      put('pregnancy', mother, father, 3, [mother, teller]);
      put('pregnancy', wife, husband, 2, [wife, teller]);
      const heard = getShareableFacts(teller, kid, talker);
      expect(heard.map((f) => f.subject_id)).toEqual([wife]);
      expect(isAdultsOnlyFact({ type: 'pregnancy', sensitivity: 3 })).toBe(true);
      expect(isAdultsOnlyFact({ type: 'pregnancy', sensitivity: 2 })).toBe(false);
      expect(isAdultsOnlyFact({ type: 'theft', sensitivity: 3 })).toBe(false);
    });

    it('fails closed on an unknown listener', () => {
      const s1 = insertAgent('Subj Three');
      const s2 = insertAgent('Subj Four', { gender: 'male' });
      const teller = insertAgent('Teller Three');
      put('kiss_seen', s1, s2, 2, [teller]);
      expect(getShareableFacts(teller, 9_999_999, talker)).toEqual([]);
    });
  });

  describe('the gossip tick', () => {
    it('a minor at the same place does not discover a romantic secret; an adult does', () => {
      const s1 = insertAgent('Disc One');
      const s2 = insertAgent('Disc Two', { gender: 'male' });
      const nosy = insertAgent('Nosy Adult');
      const kid = insertAgent('Nosy Kid', { age: 11 });
      createFact('tryst_seen', s1, s2, 3, [s1, s2], 'observed');
      const roll = vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        gossipTick(0, 1);
      } finally { roll.mockRestore(); }
      const fact = db.select().from(shared_knowledge).where(eq(shared_knowledge.subject_id, s1)).get()!;
      const known = fact.known_by as number[];
      expect(known).not.toContain(kid);
      expect(known).toContain(nosy);
    });
  });
});
