import { describe, it, expect } from 'vitest';
import { db } from '../db';
import { agents, locations, relationships } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { RippleEngine } from '../lib/cascade/RippleEngine';
import type { RippleRule } from '../lib/cascade/cascadeTypes';
import type { PersonalityProfile } from '../lib/personality';

/**
 * A ripple rule's `relationshipDelta` on `romance` wrote the column directly,
 * skipping the romance choke point the relationship tick applies. The
 * adults-only rule has to hold for every source, so a positive romance delta is
 * dropped unless `mayRomanceGrow(agent, target)`; a negative one still lands.
 */

const PERSONALITY: PersonalityProfile = {
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50,
};

const home = db.insert(locations).values({
  name: 'ripple romance home', type: 'home',
  position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 1, y: 4 },
  owner: null, capacity: 4, current_occupants: [], operating_hours: null, services: [], description: 'test',
}).returning({ id: locations.id }).get().id;

function insertAgent(name: string, age: number | null, gender = 'female'): number {
  return db.insert(agents).values({
    name, bio: 'test', traits: [], personality: PERSONALITY, age: age as number, gender,
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_destination: null, current_location: home, current_action: { type: 'idle' },
    action_started: 0, action_duration: null, action_queue: [], current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, workplace: null, created_at: Date.now(), is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function insertRelationship(x: number, y: number, romance: number): void {
  const [a, b] = x < y ? [x, y] : [y, x];
  db.insert(relationships).values({
    agent_a: a, agent_b: b, friendship_ab: 10, friendship_ba: 10,
    romance_ab: romance, romance_ba: romance, trust_ab: 10, trust_ba: 10,
    familiarity: 0, interaction_count: 0, last_interaction: 0,
    average_interaction_sentiment: 0, tags: [], status: 'acquaintances', created_at: 0, last_updated: 0,
  }).run();
}

function romanceOf(x: number, y: number): { ab: number; ba: number } {
  const [a, b] = x < y ? [x, y] : [y, x];
  const r = db.select().from(relationships)
    .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b))).get()!;
  return { ab: r.romance_ab, ba: r.romance_ba };
}

function rule(value: number): RippleRule {
  return {
    id: 'test_romance_delta', source: 'test:event', target: 'self', probability: 1,
    cooldownMinutes: 0, effects: { relationshipDelta: { field: 'romance', value } },
  } as RippleRule;
}

/** Apply a rule's effects as `agent` toward `other` (the private step, no listeners). */
function apply(engine: RippleEngine, r: RippleRule, agent: number, other: number): void {
  (engine as unknown as {
    executeEffects: (r: RippleRule, id: number, m: object, p: object) => void;
  }).executeEffects(r, agent, { chainId: 'c', chainDepth: 0, perpetratorId: other }, {});
}

describe('ripple romance delta and the adults-only rule', () => {
  const engine = new RippleEngine({ dryRun: true });

  it('does not raise romance toward a minor, nor from one', () => {
    const adult = insertAgent('Ripple Adult', 30, 'female');
    const minor = insertAgent('Ripple Minor', 16, 'male');
    insertRelationship(adult, minor, 5);

    apply(engine, rule(8), adult, minor);
    apply(engine, rule(8), minor, adult);

    expect(romanceOf(adult, minor)).toEqual({ ab: 5, ba: 5 });
  });

  it('still lowers a minor pair\'s romance (negative passes)', () => {
    const adult = insertAgent('Ripple Adult 2', 30, 'female');
    const minor = insertAgent('Ripple Minor 2', 17, 'male');
    insertRelationship(adult, minor, 5);

    apply(engine, rule(-8), adult, minor);
    apply(engine, rule(-8), minor, adult);

    expect(romanceOf(adult, minor)).toEqual({ ab: -3, ba: -3 });
  });

  it('does not raise romance between adults the feeler is not drawn to', () => {
    const a = insertAgent('Ripple Adult 3', 30, 'female');
    const b = insertAgent('Ripple Adult 3b', 31, 'female');
    insertRelationship(a, b, 0);
    apply(engine, rule(8), a, b);
    expect(romanceOf(a, b)).toEqual({ ab: 0, ba: 0 });
  });

  it('fails closed when an agent row is missing', () => {
    const adult = insertAgent('Ripple Adult 6', 30, 'female');
    const gate = (engine as unknown as { mayRomanceGrowBetween: (a: number, b: number) => boolean })
      .mayRomanceGrowBetween.bind(engine);
    expect(gate(adult, 987654)).toBe(false);
    expect(gate(987654, adult)).toBe(false);
  });

  it('still raises romance between two adults the agent is drawn to', () => {
    const a = insertAgent('Ripple Adult 4', 30, 'female');
    const b = insertAgent('Ripple Adult 5', 32, 'male');
    insertRelationship(a, b, 0);
    apply(engine, rule(8), a, b);
    const r = romanceOf(a, b);
    expect(a < b ? r.ab : r.ba).toBe(8);
  });
});
