import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// The LLM is down: chat throws, and the embedding batcher (which calls fetch
// directly) gets a refused connection — so nothing here can reach a real
// Ollama the developer happens to have running.
vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn(), callOllamaEmbedding: vi.fn() }));

import { eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations } from '../../../db/schema';
import { callOllamaChat, callOllamaEmbedding } from '../../../ai/ollama';
import { tick as decisionsTick } from '../decisions';
import { planCache, planGenerator, planLLMQueue } from '../../../lib/planning/instance';

const tag = `storm-${Date.now()}`;
let agentId: number;
let otherActive: number[] = [];

function world(minute: number) {
  return {
    time: { day: 1, hour: 10, minute, totalTicks: 600 + minute, seasonDay: 1, season: 'spring' },
    tick_speed: 1,
  };
}

/** Plan-generation LLM calls for our agent (the prompt names them). */
function planCallsForAgent(): number {
  return vi.mocked(callOllamaChat).mock.calls.filter(([req]) =>
    JSON.stringify(req).includes(`${tag} Rosa`),
  ).length;
}

async function settled() {
  await vi.waitFor(() => expect(planLLMQueue.isPending(agentId, 'generate')).toBe(false));
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
  vi.mocked(callOllamaChat).mockImplementation(() => { throw new Error('connect ECONNREFUSED'); });
  vi.mocked(callOllamaEmbedding).mockImplementation(() => { throw new Error('connect ECONNREFUSED'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});

  // The worker DB carries other files' rows. Park their active agents so the
  // decisions pass only sees ours; restored in afterAll.
  otherActive = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all().map((r) => r.id);
  if (otherActive.length) db.update(agents).set({ is_active: false }).where(inArray(agents.id, otherActive)).run();

  const home = db.insert(locations).values({
    name: `${tag} Home`,
    type: 'house',
    position: { x: 0, y: 0, width: 32, height: 32 },
    entry_point: { x: 0, y: 0 },
    capacity: 4,
    current_occupants: [],
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;

  // No needs row on purpose: the decisions loop requests the plan and then
  // skips the agent, so the action stays "complete" and every pass reaches the
  // plan-request code — the worst case for a retry storm.
  agentId = db.insert(agents).values({
    name: `${tag} Rosa`,
    bio: 'test',
    traits: ['kind'],
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
    action_duration: 1,
    action_queue: [],
    current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home,
    workplace: null,
    created_at: 0,
    is_active: true,
  }).returning({ id: agents.id }).get().id;

  planCache.clear();
  planLLMQueue.clear();
  planGenerator.clear();
});

afterAll(() => {
  db.update(agents).set({ is_active: false }).where(eq(agents.id, agentId)).run();
  if (otherActive.length) db.update(agents).set({ is_active: true }).where(inArray(agents.id, otherActive)).run();
  vi.unstubAllGlobals();
});

describe('decisions.tick with the LLM down (B6)', () => {
  it('asks the LLM for a plan once across consecutive passes and caches a fallback', async () => {
    decisionsTick(world(0));
    // A second pass while the first request is still in flight: deduped.
    decisionsTick(world(1));
    await settled();
    expect(planCallsForAgent()).toBe(1);

    const row = db.select({ plan: agents.daily_plan }).from(agents).where(eq(agents.id, agentId)).get();
    expect(row?.plan).toMatchObject({ day: 1, source: 'fallback' });

    // Later passes see the fallback plan and re-ask, but the backoff holds.
    decisionsTick(world(2));
    decisionsTick(world(5));
    await settled();
    expect(planCallsForAgent()).toBe(1);
  });
});
