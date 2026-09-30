import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { agents, agentStates, locations } from '../db/schema';
import { RippleEngine } from '../lib/cascade/RippleEngine';
import type { RippleRule } from '../lib/cascade/cascadeTypes';
import { simEvents } from '../lib/simEvents';
import { rollStateDuration } from '../lib/stateDurations';
import type { PersonalityProfile } from '../lib/personality';

/**
 * Every state a ripple rule created lasted a flat 120 game minutes, so a
 * cascade heartbreak was over in two hours (a native one lasts days) and a
 * cascade `angry` never reached the 480-minute grudge conversion. Cascade
 * states now get the native length for their type.
 */

describe('rollStateDuration', () => {
  it('rolls within the native range for each fixed-length type', () => {
    expect(rollStateDuration('heartbroken', () => 0)).toBe(2880);
    expect(rollStateDuration('heartbroken', () => 0.999)).toBeLessThan(7200);
    expect(rollStateDuration('angry', () => 0)).toBe(180);
    expect(rollStateDuration('angry', () => 0.999)).toBeGreaterThan(480); // can become a grudge
    expect(rollStateDuration('hungover', () => 0)).toBe(180);
    expect(rollStateDuration('sick', () => 0)).toBe(360);
  });

  it('gives a cascade jealousy (no triangle in its metadata) a real length', () => {
    expect(rollStateDuration('jealous', () => 0)).toBe(1440);
  });

  it('keeps depression open-ended and has no opinion on conditional or unknown types', () => {
    expect(rollStateDuration('depressed')).toBe(999999);
    expect(rollStateDuration('stressed')).toBeNull();
    expect(rollStateDuration('lonely')).toBeNull();
    expect(rollStateDuration('not_a_state')).toBeNull();
  });
});

const PERSONALITY: PersonalityProfile = {
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50,
};

function rule(id: string, state: string): RippleRule {
  return {
    id,
    source: `test:${id}`,
    target: 'self',
    probability: 1,
    personalityGates: [],
    cooldownMinutes: 0,
    effects: { createState: state as never },
  };
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
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home,
    workplace: null,
    created_at: Date.now(),
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

describe('cascade-created states last their native length', () => {
  let home: number;

  beforeAll(() => {
    home = db.insert(locations).values({
      name: 'duration home',
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
    new RippleEngine({
      rules: [rule('dur_heartbreak', 'heartbroken'), rule('dur_stress', 'stressed')],
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterAll(() => vi.restoreAllMocks());

  const stateOf = (agentId: number, type: string) =>
    db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, type))).get();

  it('a cascade heartbreak lasts days, not two hours', () => {
    const ines = insertAgent('Ines Duration', home);
    simEvents.emit('test:dur_heartbreak', { agentId: ines });
    expect(stateOf(ines, 'heartbroken')?.duration).toBe(2880);
  });

  it('a type without a native length keeps the 120-minute fallback', () => {
    const tomas = insertAgent('Tomas Duration', home);
    simEvents.emit('test:dur_stress', { agentId: tomas });
    expect(stateOf(tomas, 'stressed')?.duration).toBe(120);
  });
});
