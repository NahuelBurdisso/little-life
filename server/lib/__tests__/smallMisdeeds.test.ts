import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, locations, shared_knowledge } from '../../db/schema';
import type { PersonalityProfile } from '../personality';
import { createFact } from '../gossip';
import {
  misdeedChancePerMinute, pickMisdeed, smallMisdeedsHourly, type MisdeedContext,
} from '../smallMisdeeds';

/**
 * A calm town stopped producing secrets after ~day 14 of a soak: facts only came from drama,
 * and createFact kept one per type and subject forever. Small misdeeds keep material coming,
 * and a duplicate that has gone public no longer blocks something new.
 */

const p = (over: Partial<PersonalityProfile> = {}): PersonalityProfile => ({
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50, ...over,
});

const ctx = (over: Partial<MisdeedContext> = {}): MisdeedContext => ({
  hour: 14, placeType: 'shop', atWork: false, money: 50, states: [], personality: p(),
  present: [], crushHere: null, creditorHere: null, friendHere: null, ...over,
});

describe('small misdeeds (pure)', () => {
  it('fit the situation', () => {
    expect(pickMisdeed(ctx())).toBeNull(); // alone, solvent, not at work
    expect(pickMisdeed(ctx({ money: 5 }), () => 0)?.type).toBe('debt');
    expect(pickMisdeed(ctx({ crushHere: 9, present: [9], personality: p({ honesty: 90 }) }), () => 0)?.type).toBe('crush');
    expect(pickMisdeed(ctx({ placeType: 'tavern', hour: 21, states: ['drunk'] }), () => 0)?.type).toBe('drunk_incident');
    // An honest soul doesn't lie at work.
    expect(pickMisdeed(ctx({ atWork: true, present: [3], personality: p({ honesty: 90 }) }))).toBeNull();
  });

  it('come more often to the impulsive and unprincipled', () => {
    expect(misdeedChancePerMinute(p({ impulsiveness: 90, honesty: 20, morality: 20 })))
      .toBeGreaterThan(misdeedChancePerMinute(p({ impulsiveness: 10, honesty: 90, morality: 90 })));
  });
});

describe('smallMisdeedsHourly + createFact', () => {
  const made: number[] = [];
  let liar: number;
  let witness: number;

  beforeAll(() => {
    const shop = db.insert(locations).values({
      name: 'Misdeed Shop', type: 'shop', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
      capacity: 10, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    const insert = (name: string, personality: PersonalityProfile) => {
      const id = db.insert(agents).values({
        name, bio: 'test', traits: [], age: 30, gender: 'male', personality,
        sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
        current_action: { type: 'idle' }, action_started: 0, action_queue: [],
        schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
        home: shop, workplace: shop, current_location: shop, created_at: 0, is_active: true,
      }).returning({ id: agents.id }).get().id;
      made.push(id);
      return id;
    };
    // Everyone else in this worker's DB is asleep for the roll.
    db.update(agents).set({ current_action: { type: 'sleeping' } }).where(eq(agents.is_active, true)).run();
    liar = insert('Lex Fibber', p({ honesty: 10, impulsiveness: 90, morality: 10 }));
    witness = insert('Wren Watcher', p({ honesty: 95, impulsiveness: 5, morality: 95, curiosity: 100 }));
  });

  afterAll(() => {
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  it('a noticed misdeed becomes a fact the witness knows, with a misdeed feed row', () => {
    // rng 0: every roll hits, every pick takes the first option, every witness notices.
    // Neither has an economy row (money 0), so Lex runs up a debt; Wren may roll one too.
    const n = smallMisdeedsHourly(14, () => 0);
    expect(n).toBeGreaterThan(0);
    const fact = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.subject_id, liar), eq(shared_knowledge.is_active, true))).all()[0];
    expect(fact).toBeDefined();
    expect(fact.known_by).toEqual(expect.arrayContaining([liar, witness]));
    const row = db.select().from(activityLog).where(and(eq(activityLog.type, 'drama'), eq(activityLog.target_id, liar))).get();
    expect((row?.metadata as { beat?: string } | null)?.beat).toBe('misdeed');
  });

  it('a public duplicate no longer blocks a new fact of the same kind that says something new', () => {
    const first = createFact('white_lie', liar, witness, 2, [liar], 'self', { detail: 'liking a gift' })
      ?? db.select().from(shared_knowledge).where(and(eq(shared_knowledge.type, 'white_lie'), eq(shared_knowledge.subject_id, liar))).get()!.id;
    // Still a secret: a second one about the same pair is blocked.
    expect(createFact('white_lie', liar, witness, 2, [liar], 'self', { detail: 'why they were late' })).toBeNull();
    db.update(shared_knowledge).set({ is_public: true }).where(eq(shared_knowledge.id, first)).run();
    expect(createFact('white_lie', liar, witness, 2, [liar], 'self', { detail: 'why they were late' })).not.toBeNull();
    // ...but never the same sentence twice.
    const same = db.select().from(shared_knowledge).where(eq(shared_knowledge.id, first)).get()!;
    db.update(shared_knowledge).set({ is_public: true }).where(and(eq(shared_knowledge.type, 'white_lie'), eq(shared_knowledge.subject_id, liar))).run();
    expect(createFact('white_lie', liar, witness, 2, [liar], 'self', { detail: same.content.split('about ')[1] })).toBeNull();
  });
});
