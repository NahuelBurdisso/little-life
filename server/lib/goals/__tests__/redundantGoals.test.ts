import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';

vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn() }));

import { db } from '../../../db';
import { agents, aspirations, goals, locations, relationships } from '../../../db/schema';
import { callOllamaChat } from '../../../ai/ollama';
import { setEffectivePersonality } from '../../states';
import { GoalReviewer, isRedundantGoal } from '../GoalReviewer';

/**
 * Playtest regression: "befriend" churn. The morning review re-proposed
 * "befriend <close friend>" every day; the goal auto-completes at
 * friendship > 50, so it was created and completed one tick apart, daily.
 */

const TICK = 5000;
const NAMES = ['Zephyrine Quillfeather', 'Bartholomew Oakenshaw'];

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
    current_action: { type: 'idle' },
    action_started: 0,
    action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home,
    created_at: 0,
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function setFriendship(a: number, b: number, friendship: number): void {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  db.delete(relationships).where(and(eq(relationships.agent_a, lo), eq(relationships.agent_b, hi))).run();
  db.insert(relationships).values({
    agent_a: lo,
    agent_b: hi,
    friendship_ab: friendship,
    friendship_ba: friendship,
    romance_ab: 0,
    romance_ba: 0,
    trust_ab: 50,
    trust_ba: 50,
    familiarity: 60,
    interaction_count: 10,
    last_interaction: 0,
    average_interaction_sentiment: 0.3,
    tags: [],
    status: 'friend',
    created_at: 0,
    last_updated: 0,
  }).run();
}

function llmProposesBefriend(target: string): void {
  vi.mocked(callOllamaChat).mockResolvedValueOnce({
    text: JSON.stringify({
      ambition: 'keep',
      reviews: [],
      new_goals: [{
        description: `Spend more time with ${target}`,
        target_agent: target,
        category_hint: 'social',
        strategy: 'invite them for a drink',
        priority: 0.6,
      }],
    }),
  } as any);
}

function befriendGoals(agentId: number, targetId: number) {
  return db.select().from(goals)
    .where(and(eq(goals.agent_id, agentId), eq(goals.type, 'befriend'), eq(goals.target_id, targetId)))
    .all();
}

describe('GoalReviewer — goals that are already settled', () => {
  let me = 0;
  let friend = 0;
  let homeId = 0;

  beforeAll(() => {
    homeId = db.insert(locations).values({
      name: 'Goal Cottage',
      type: 'home',
      position: { x: 0, y: 0, width: 4, height: 4 },
      entry_point: { x: 0, y: 0 },
      capacity: 2,
      current_occupants: [],
      services: [],
      description: 'test',
    }).returning({ id: locations.id }).get().id;
    me = insertAgent(NAMES[0], homeId);
    friend = insertAgent(NAMES[1], homeId);
    setEffectivePersonality(me, { warmth: 70 } as any);
    // An active ambition, so review() doesn't spend the mocked LLM reply on one.
    db.insert(aspirations).values({
      agent_id: me,
      type: 'social',
      intensity: 0.7,
      status: 'active',
      adopted_at: 0,
      trigger: 'test',
      description: 'be loved',
    }).run();
  });

  afterAll(() => {
    const ids = [me, friend];
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    db.run(sql`DELETE FROM activity_log WHERE initiator_id IN (${idList})`);
    db.delete(goals).where(inArray(goals.agent_id, ids)).run();
    db.delete(aspirations).where(inArray(aspirations.agent_id, ids)).run();
    db.delete(relationships).where(inArray(relationships.agent_a, ids)).run();
    db.delete(agents).where(inArray(agents.id, ids)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
  });

  beforeEach(() => {
    vi.mocked(callOllamaChat).mockClear();
    db.delete(goals).where(eq(goals.agent_id, me)).run();
  });

  it('does not adopt "befriend" toward someone already a close friend', async () => {
    setFriendship(me, friend, 70);
    llmProposesBefriend(NAMES[1]);

    await new GoalReviewer().review(me, TICK, 1);

    expect(callOllamaChat).toHaveBeenCalledTimes(1);
    expect(befriendGoals(me, friend)).toHaveLength(0);
  });

  it('does not re-adopt a "befriend" goal just completed for the same target', async () => {
    setFriendship(me, friend, 20);
    db.insert(goals).values({
      agent_id: me, type: 'befriend', target_id: friend, motivation: 'test', priority: 0.5,
      progress: 1, status: 'completed', created_at: TICK - 400, completed_at: TICK - 399, source: 'llm',
    }).run();
    llmProposesBefriend(NAMES[1]);

    await new GoalReviewer().review(me, TICK, 1);

    expect(befriendGoals(me, friend).filter((g) => g.status === 'active')).toHaveLength(0);
  });

  it('still adopts "befriend" toward someone who is not a friend yet', async () => {
    setFriendship(me, friend, 20);
    llmProposesBefriend(NAMES[1]);

    await new GoalReviewer().review(me, TICK, 1);

    const created = befriendGoals(me, friend);
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe('active');
  });

  it('applies to any auto relationship rule, not just befriend', () => {
    // revenge auto-abandons at friendship > 20.
    setFriendship(me, friend, 40);
    expect(isRedundantGoal(me, 'revenge', friend, TICK)).toBe(true);
    setFriendship(me, friend, 0);
    expect(isRedundantGoal(me, 'revenge', friend, TICK)).toBe(false);
  });
});
