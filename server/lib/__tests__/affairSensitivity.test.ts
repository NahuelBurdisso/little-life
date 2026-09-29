import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import { agents, locations, relationships, shared_knowledge } from '../../db/schema';
import { createFact } from '../gossip';
import { affairInvolvesMarriage, affairSensitivity, MARRIED_AFFAIR_SENSITIVITY, spouseOf } from '../marriage';

/**
 * An affair that betrays a marriage is the town's worst secret: createFact
 * raises it past the ordinary sensitivity-3 ceiling.
 */

let homeId: number;
let ids: number[] = [];
let [husband, wife, lover, single, other, widow, late] = [0, 0, 0, 0, 0, 0, 0];

function insertAgent(name: string, active = true): number {
  return db.insert(agents).values({
    name, bio: 'test', traits: [], personality: null, age: 30, gender: 'female',
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, created_at: 0, is_active: active,
  }).returning({ id: agents.id }).get().id;
}

function marry(a: number, b: number): void {
  db.insert(relationships).values({
    agent_a: Math.min(a, b), agent_b: Math.max(a, b),
    friendship_ab: 60, friendship_ba: 60, romance_ab: 80, romance_ba: 80,
    trust_ab: 50, trust_ba: 50, familiarity: 60, interaction_count: 10,
    last_interaction: 0, last_interaction_minute: 0, average_interaction_sentiment: 0.3,
    tags: ['partner', 'married'], status: 'partners', created_at: 0, last_updated: 0,
  }).run();
}

function sensitivityOf(factId: number | null): number {
  return db.select({ s: shared_knowledge.sensitivity }).from(shared_knowledge)
    .where(eq(shared_knowledge.id, factId!)).get()!.s;
}

describe('affair secrets and marriage', () => {
  beforeAll(() => {
    homeId = db.insert(locations).values({
      name: 'Affair Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 },
      entry_point: { x: 0, y: 0 }, capacity: 4, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    husband = insertAgent('Horatio Wexley');
    wife = insertAgent('Winifred Wexley');
    lover = insertAgent('Lysander Crane');
    single = insertAgent('Sybil Marchbanks');
    other = insertAgent('Octavia Pell');
    widow = insertAgent('Wilhelmina Grey');
    late = insertAgent('Lucius Grey', false);
    ids = [husband, wife, lover, single, other, widow, late];
    marry(husband, wife);
    marry(widow, late);
  });

  afterAll(() => {
    db.delete(shared_knowledge).where(inArray(shared_knowledge.subject_id, ids)).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, ids), inArray(relationships.agent_b, ids))).run();
    db.delete(agents).where(inArray(agents.id, ids)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
  });

  it('finds the living spouse only', () => {
    expect(spouseOf(husband)).toBe(wife);
    expect(spouseOf(wife)).toBe(husband);
    expect(spouseOf(single)).toBeNull();
    expect(spouseOf(widow)).toBeNull();
  });

  it('an affair involving a married resident is more sensitive than any other secret', () => {
    expect(affairInvolvesMarriage(lover, husband)).toBe(true);
    expect(affairInvolvesMarriage(wife, lover)).toBe(true);
    expect(sensitivityOf(createFact('affair', husband, lover, 3, [single], 'observed'))).toBe(MARRIED_AFFAIR_SENSITIVITY);
    expect(sensitivityOf(createFact('affair', lover, wife, 3, [single], 'observed'))).toBe(MARRIED_AFFAIR_SENSITIVITY);
  });

  it('leaves affairs between unmarried people, spouses themselves, and widows at their base', () => {
    expect(sensitivityOf(createFact('affair', single, other, 3, [lover], 'observed'))).toBe(3);
    expect(affairInvolvesMarriage(husband, wife)).toBe(false);
    expect(affairInvolvesMarriage(widow, lover)).toBe(false);
    // Other fact types never change.
    expect(sensitivityOf(createFact('crush', husband, single, 2, [husband], 'witnessed'))).toBe(2);
  });

  it('never lowers a sensitivity', () => {
    expect(affairSensitivity(5, true)).toBe(5);
    expect(affairSensitivity(3, false)).toBe(3);
    expect(affairSensitivity(3, true)).toBe(MARRIED_AFFAIR_SENSITIVITY);
  });
});
