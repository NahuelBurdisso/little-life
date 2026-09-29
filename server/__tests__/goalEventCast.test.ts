import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../db';
import { agents, goals, locations, relationships } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { goalEventCast } from '../engine/systems/goals';
import { RippleEngine } from '../lib/cascade/RippleEngine';
import { rippleRules } from '../lib/cascade/rippleRules';
import { simEvents } from '../lib/simEvents';
import { initFavorTracking, getNetFavorBalance } from '../lib/favorEngine';
import type { PersonalityProfile } from '../lib/personality';

/**
 * goal:completed used to send the goal's target as `perpetratorId` and the
 * achiever as `victimId`. These drive the corrected cast through the real
 * listeners — the cascade engine and favorEngine — by emitting the event.
 */

// Aggressive enough for every personality gate on the rules under test; the
// probability rolls are pinned below so the gates only scale, never block.
const PERSONALITY: PersonalityProfile = {
  honesty: 50, aggression: 80, warmth: 50, impulsiveness: 80, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 80,
};

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
    personality: PERSONALITY,
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

const RULES = [
  'revenge_breeds_revenge',
  'undermine_victim_retaliation',
  'protect_gratitude',
  'goal_failure_drinking',
  'drunk_fight',
].map((id) => rippleRules.find((r) => r.id === id)!);

describe('goalEventCast', () => {
  it('puts the goal target in the other-party slot and never names it perpetrator', () => {
    expect(goalEventCast({ target_id: 7 })).toEqual({ victimId: 7 });
    expect(goalEventCast({ target_id: null })).toEqual({});
  });
});

describe('goal events through their listeners', () => {
  let home: number;

  beforeAll(() => {
    home = insertHome();
    // Listens on simEvents like the real one (initCascade), limited to the
    // rules under test so unrelated rules can't muddy the assertions.
    new RippleEngine({ rules: RULES });
    initFavorTracking();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  const goalRow = (agentId: number, ruleId: string) => db.select().from(goals)
    .where(and(eq(goals.agent_id, agentId), eq(goals.motivation, `cascade:${ruleId}`)))
    .get();

  it('revenge_breeds_revenge: the revenge target retaliates against the achiever', () => {
    const avenger = insertAgent('Cast Avenger', home);
    const wronged = insertAgent('Cast Wronged', home);

    simEvents.emit('goal:completed', { agentId: avenger, goalType: 'revenge', ...goalEventCast({ target_id: wronged }) });

    expect(goalRow(wronged, 'revenge_breeds_revenge')?.target_id).toBe(avenger);
    expect(goalRow(avenger, 'revenge_breeds_revenge')).toBeUndefined();
  });

  it('undermine_victim_retaliation: the undermined target investigates the achiever', () => {
    const schemer = insertAgent('Cast Schemer', home);
    const mark = insertAgent('Cast Mark', home);

    simEvents.emit('goal:completed', { agentId: schemer, goalType: 'undermine', ...goalEventCast({ target_id: mark }) });

    expect(goalRow(mark, 'undermine_victim_retaliation')?.target_id).toBe(schemer);
  });

  it('protect: the bond grows toward the protected person and the favor is owed by them', () => {
    const guardian = insertAgent('Cast Guardian', home);
    const ward = insertAgent('Cast Ward', home);
    insertRelationship(guardian, ward);

    simEvents.emit('goal:completed', { agentId: guardian, goalType: 'protect', ...goalEventCast({ target_id: ward }) });

    const [a, b] = guardian < ward ? [guardian, ward] : [ward, guardian];
    const rel = db.select().from(relationships)
      .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b))).get()!;
    expect(guardian === a ? rel.friendship_ab : rel.friendship_ba).toBe(25);
    // favorEngine: guardian gave, ward received — not a favor to themself.
    expect(getNetFavorBalance(guardian, ward)).toBe(2);
    expect(getNetFavorBalance(ward, guardian)).toBe(-2);
    expect(getNetFavorBalance(guardian, guardian)).toBe(0);
  });

  it('drunk_fight after a failed goal still finds its opponent', () => {
    const loser = insertAgent('Cast Loser', home);
    const rival = insertAgent('Cast Rival', home);
    const fights: Array<{ agentId: number; victimId?: number; action?: string }> = [];
    const onInteraction = (p: any) => { if (p?.action === 'confrontation') fights.push(p); };
    simEvents.on('interaction:completed', onInteraction);

    simEvents.emit('goal:abandoned', { agentId: loser, goalType: 'befriend', ...goalEventCast({ target_id: rival }) });

    simEvents.off('interaction:completed', onInteraction);
    expect(fights).toEqual([expect.objectContaining({ agentId: loser, victimId: rival })]);
  });
});
