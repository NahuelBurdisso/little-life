import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db';
import { agents, goals, locations, relationships } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { goalEventCast } from '../engine/systems/goals';
import { RippleEngine } from '../lib/cascade/RippleEngine';
import { rippleRules } from '../lib/cascade/rippleRules';

/**
 * goal:completed used to send the goal's target as `perpetratorId` and the
 * achiever as `victimId`. These pin the corrected cast through the cascade
 * rules that consume it.
 */

function insertHome(): number {
  return db.insert(locations).values({
    name: 'goal cast home',
    type: 'home',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 1, y: 4 },
    owner: null,
    capacity: 4,
    current_occupants: [],
    operating_hours: null,
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, home: number): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality: null,
    age: 30,
    gender: 'female',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 0, y: 0 },
    current_destination: null,
    current_location: home,
    current_action: { type: 'idle' },
    action_started: 0,
    action_duration: null,
    action_queue: [],
    current_path: null,
    schedule: {
      wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [],
    },
    home,
    workplace: null,
    created_at: Date.now(),
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function insertRelationship(x: number, y: number): void {
  const [a, b] = x < y ? [x, y] : [y, x];
  db.insert(relationships).values({
    agent_a: a, agent_b: b,
    friendship_ab: 10, friendship_ba: 10,
    romance_ab: 0, romance_ba: 0,
    trust_ab: 10, trust_ba: 10,
    familiarity: 0, interaction_count: 0, last_interaction: 0,
    average_interaction_sentiment: 0, tags: [], status: 'acquaintance',
    created_at: 0, last_updated: 0,
  }).run();
}

const rule = (id: string) => rippleRules.find((r) => r.id === id)!;

/** The metadata evaluateAndFire derives from a payload. */
function metadataFor(payload: { agentId: number; perpetratorId?: number; victimId?: number }) {
  return {
    chainId: 'test',
    chainDepth: 1,
    perpetratorId: payload.perpetratorId ?? payload.agentId,
    victimId: payload.victimId,
  };
}

describe('goalEventCast', () => {
  it('puts the goal target in the other-party slot and never names it perpetrator', () => {
    expect(goalEventCast({ target_id: 7 })).toEqual({ victimId: 7 });
    expect(goalEventCast({ target_id: null })).toEqual({});
  });
});

describe('cascade rules consuming goal:completed', () => {
  let home: number;
  const engine = new RippleEngine();

  beforeAll(() => {
    home = insertHome();
  });

  it('revenge_breeds_revenge: the revenge target retaliates against the achiever', () => {
    const avenger = insertAgent('Cast Avenger', home);
    const wronged = insertAgent('Cast Wronged', home);
    const payload = { agentId: avenger, goalType: 'revenge', ...goalEventCast({ target_id: wronged }) };
    const r = rule('revenge_breeds_revenge');

    const retaliator = (engine as any).resolveTargetAgent(r, payload);
    expect(retaliator).toBe(wronged);

    (engine as any).executeEffects(r, retaliator, metadataFor(payload), payload);
    const goal = db.select().from(goals)
      .where(and(eq(goals.agent_id, wronged), eq(goals.motivation, 'cascade:revenge_breeds_revenge')))
      .get();
    expect(goal?.type).toBe('revenge');
    expect(goal?.target_id).toBe(avenger);
  });

  it('undermine_victim_retaliation: the undermined target investigates the achiever', () => {
    const schemer = insertAgent('Cast Schemer', home);
    const mark = insertAgent('Cast Mark', home);
    const payload = { agentId: schemer, goalType: 'undermine', ...goalEventCast({ target_id: mark }) };
    const r = rule('undermine_victim_retaliation');

    const target = (engine as any).resolveTargetAgent(r, payload);
    expect(target).toBe(mark);

    (engine as any).executeEffects(r, target, metadataFor(payload), payload);
    const goal = db.select().from(goals)
      .where(and(eq(goals.agent_id, mark), eq(goals.motivation, 'cascade:undermine_victim_retaliation')))
      .get();
    expect(goal?.target_id).toBe(schemer);
  });

  it('protect_gratitude: the bond grows toward the protected person', () => {
    const guardian = insertAgent('Cast Guardian', home);
    const ward = insertAgent('Cast Ward', home);
    insertRelationship(guardian, ward);
    const payload = { agentId: guardian, goalType: 'protect', ...goalEventCast({ target_id: ward }) };

    (engine as any).executeEffects(rule('protect_gratitude'), guardian, metadataFor(payload), payload);

    const [a, b] = guardian < ward ? [guardian, ward] : [ward, guardian];
    const rel = db.select().from(relationships)
      .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b))).get()!;
    const fromGuardian = guardian === a ? rel.friendship_ab : rel.friendship_ba;
    expect(fromGuardian).toBe(25);
  });
});
