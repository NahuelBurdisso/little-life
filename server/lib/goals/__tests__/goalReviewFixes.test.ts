import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn() }));

import { db } from '../../../db';
import { agents, aspirations, goals, locations } from '../../../db/schema';
import { callOllamaChat } from '../../../ai/ollama';
import { setEffectivePersonality } from '../../states';
import { GoalReviewer } from '../GoalReviewer';
import { goalOverlap } from '../goalOverlap';
import { buildPivotPrompt } from '../goalPrompts';
import { parseGoalReview } from '../goalParser';
import { GoalMapper } from '../GoalMapper';
import { AMBITION_CATEGORIES } from '../goalPrompts';
import { ambitionText } from '../../../data/ambitions';

/**
 * Playtest #4: 94 goals, 10 completed, 52 abandoned. Goals about no one could
 * never progress, the pivot re-typed goals ("befriend: Gather more rumors about
 * the hooded figure"), and the same goal came back the day after it died.
 */

const NOW = 20_000;
const NAMES = ['Goalfix Marco', 'Goalfix Rosa', 'Goalfix Omar', 'Goalfix Priya'];
const ids: number[] = [];
let homeId = 0;

function reply(body: Record<string, unknown>): void {
  vi.mocked(callOllamaChat).mockResolvedValueOnce({ text: JSON.stringify({ ambition: 'keep', reviews: [], new_goals: [], ...body }) } as any);
}

function newGoal(description: string, category_hint = 'investigative', target_agent: string | null = null) {
  return { description, target_agent, category_hint, strategy: 'ask around at the tavern', priority: 0.6 };
}

function goalsOf(agentId: number) {
  return db.select().from(goals).where(eq(goals.agent_id, agentId)).all();
}

beforeAll(() => {
  homeId = db.insert(locations).values({
    name: 'Goalfix Cottage', type: 'home', position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
    capacity: 4, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  for (const name of NAMES) {
    const id = db.insert(agents).values({
      name, bio: 'test', traits: [], personality: null, age: 30, gender: 'male', sprite_sheet: 'x', portrait_sprite: 'x',
      position: { x: 0, y: 0 }, current_action: { type: 'idle' }, action_started: 0, action_queue: [],
      schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
      home: homeId, created_at: 0, is_active: true,
    }).returning({ id: agents.id }).get().id;
    ids.push(id);
    setEffectivePersonality(id, { curiosity: 70 } as any);
    db.insert(aspirations).values({
      agent_id: id, type: 'knowledge', intensity: 0.7, status: 'active', adopted_at: 0, trigger: 'test', description: 'understand people',
    }).run();
  }
});

afterAll(() => {
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  db.run(sql`DELETE FROM activity_log WHERE initiator_id IN (${idList})`);
  db.delete(goals).where(inArray(goals.agent_id, ids)).run();
  db.delete(aspirations).where(inArray(aspirations.agent_id, ids)).run();
  db.delete(agents).where(inArray(agents.id, ids)).run();
  db.delete(locations).where(eq(locations.id, homeId)).run();
});

beforeEach(() => {
  vi.mocked(callOllamaChat).mockClear();
  db.delete(goals).where(inArray(goals.agent_id, ids)).run();
});

describe('goal review fixes', () => {
  it('a goal about no one can be declared done', async () => {
    const [marco] = ids;
    const id = db.insert(goals).values({
      agent_id: marco, type: 'custom', target_id: null, motivation: 'x', priority: 0.5, created_at: NOW - 1440,
      description: 'Find my missing gloves.', source: 'llm',
    }).returning({ id: goals.id }).get().id;
    expect(parseGoalReview(JSON.stringify({ ambition: 'keep', reviews: [{ goal_id: id, action: 'done', reason: 'found them' }] }))
      ?.reviews[0].action).toBe('done');
    reply({ reviews: [{ goal_id: id, action: 'done', reason: 'They were in my coat.' }] });

    await new GoalReviewer().review(marco, NOW, 14);

    expect(goalsOf(marco).find((g) => g.id === id)?.status).toBe('completed');
  });

  it('a person-shaped type with no person becomes a custom goal', async () => {
    const [marco] = ids;
    reply({ new_goals: [newGoal('Study the old mill ledgers for clues.')] });

    await new GoalReviewer().review(marco, NOW, 14);

    expect(goalsOf(marco).map((g) => g.type)).toEqual(['custom']);
  });

  it('does not restart a goal the agent just gave up on', async () => {
    const [marco] = ids;
    db.insert(goals).values({
      agent_id: marco, type: 'custom', target_id: null, motivation: 'x', priority: 0.5, status: 'abandoned',
      created_at: NOW - 3000, completed_at: NOW - 200, description: 'Find out who the hooded stranger is.', source: 'llm',
    }).run();
    reply({ new_goals: [newGoal('Discover who the hooded stranger really is.')] });

    await new GoalReviewer().review(marco, NOW, 14);

    expect(goalsOf(marco).filter((g) => g.status === 'active')).toHaveLength(0);
  });

  it('lets at most two people in town chase the same subject', async () => {
    const [marco, rosa, omar, priya] = ids;
    for (const who of [rosa, omar]) {
      db.insert(goals).values({
        agent_id: who, type: 'custom', target_id: null, motivation: 'x', priority: 0.5, created_at: NOW - 100,
        description: 'Observe the hooded figure to understand their motives.', source: 'llm',
      }).run();
    }
    reply({ new_goals: [newGoal('Find out more about the hooded figure.')] });
    await new GoalReviewer().review(priya, NOW, 14);
    expect(goalsOf(priya)).toHaveLength(0);

    // A different subject is still fine.
    reply({ new_goals: [newGoal('Learn to bake honey cake.', 'personal')] });
    await new GoalReviewer().review(marco, NOW, 14);
    expect(goalsOf(marco).map((g) => g.description)).toEqual(['Learn to bake honey cake.']);
  });

  it('compares goals by their content words', () => {
    expect(goalOverlap('Find out who the hooded stranger is.', 'Keep an eye on the hooded strangers.')).toBeGreaterThanOrEqual(0.5);
    expect(goalOverlap('Find out who the hooded stranger is.', 'Impress Yuki with my wit.')).toBe(0);
  });

  it('a pivot asks for a new approach only, never a new category', () => {
    const prompt = buildPivotPrompt({
      name: 'Goalfix Marco', age: 30, personality: { curiosity: 70 } as any,
      goalDescription: 'Find my gloves.', strategy: 'look', progress: 0, daysActive: 2, recentMemories: [],
    } as any);
    expect(JSON.stringify(prompt.format)).not.toContain('category');
    expect(prompt.system).not.toContain('category');
  });

  it('files goals about oneself as custom, not befriend', () => {
    expect(new GoalMapper().mapCategory('personal').type).toBe('custom');
  });

  it('gives every ambition category words the review can weigh events against', () => {
    for (const c of AMBITION_CATEGORIES) expect(ambitionText(c), c).not.toBe(c);
  });
});
