import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// The LLM client is the thing under failure here; the activity log is mocked so
// the test can assert how often an outage reaches the player's feed.
vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn() }));
vi.mock('../../activityLogger', () => ({ logActivity: vi.fn(), pruneActivityLog: vi.fn() }));

import { db } from '../../../db';
import { agents, locations } from '../../../db/schema';
import { callOllamaChat } from '../../../ai/ollama';
import { logActivity } from '../../activityLogger';
import { PlanGenerator, PLAN_RETRY_BACKOFF_MINUTES, gameMinuteOf, type GameClock } from '../PlanGenerator';
import { PlanLLMQueue } from '../PlanLLMQueue';
import { PlanExecutor } from '../PlanExecutor';
import type { DailyPlan, PlanExecutionState } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCHEDULE = {
  wakeTime: 7,
  sleepTime: 22,
  workStart: 9,
  workEnd: 17,
  lunchTime: 12,
  freeTimePreferences: ['park'],
};

function insertLocation(name: string): number {
  return db.insert(locations).values({
    name,
    type: 'house',
    position: { x: 0, y: 0, width: 32, height: 32 },
    entry_point: { x: 0, y: 0 },
    capacity: 4,
    current_occupants: [],
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
}

let agentId: number;
let workplaceName: string;

beforeAll(() => {
  // The worker DB is shared with other files, so use unique names and only
  // ever refer to our own rows by id.
  const tag = `plangen-${Date.now()}`;
  const home = insertLocation(`${tag} Home`);
  workplaceName = `${tag} Bakery`;
  const work = insertLocation(workplaceName);
  agentId = db.insert(agents).values({
    name: `${tag} Rosa`,
    bio: 'baker',
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
    action_duration: null,
    action_queue: [],
    current_path: null,
    schedule: SCHEDULE,
    home,
    workplace: work,
    created_at: 0,
    is_active: true,
  }).returning({ id: agents.id }).get().id;
});

function makeCache() {
  const plans = new Map<number, DailyPlan>();
  const exec = new Map<number, PlanExecutionState>();
  return {
    get: (id: number) => plans.get(id) ?? null,
    set: vi.fn((id: number, plan: DailyPlan) => { plans.set(id, plan); }),
    getExecState: (id: number) => exec.get(id) ?? null,
    setExecState: (id: number, s: PlanExecutionState) => { exec.set(id, s); },
  };
}

const memory = {
  retrieve: vi.fn(async () => []),
  retrieveByType: vi.fn(async () => []),
  record: vi.fn(),
};

/** Mutable game clock shared by the generator's `now` and the queue calls. */
let clock: GameClock;
const at = (hour: number, minute = 0): GameClock => ({ day: 1, hour, minute });

function setup() {
  const cache = makeCache();
  const queue = new PlanLLMQueue();
  const gen = new PlanGenerator(cache, queue, memory, () => gameMinuteOf(clock));
  return { cache, queue, gen };
}

/** Wait for the agent's plan job to finish (the queue releases its key). */
async function settled(queue: PlanLLMQueue) {
  await vi.waitFor(() => expect(queue.isPending(agentId, 'generate')).toBe(false));
}

const GOOD_PLAN = '07:00-09:00 | Have breakfast | Home\n09:00-17:00 | Bake bread | Bakery\n17:00-21:00 | Read | Home';

beforeEach(() => {
  // mockClear, not mockReset: see the Vitest 2 note in CLAUDE.md.
  vi.mocked(callOllamaChat).mockClear();
  vi.mocked(logActivity).mockClear();
  memory.record.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  clock = at(8);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlanGenerator when the LLM fails (B6)', () => {
  it('queues a single request no matter how often decisions ask', async () => {
    const { queue, gen } = setup();
    let release!: () => void;
    vi.mocked(callOllamaChat).mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ text: GOOD_PLAN } as never); }),
    );

    expect(gen.queueGeneration(agentId, clock)).toBe(true);
    for (let i = 0; i < 20; i++) expect(gen.queueGeneration(agentId, clock)).toBe(false);

    await vi.waitFor(() => expect(callOllamaChat).toHaveBeenCalledTimes(1));
    release();
    await settled(queue);
    expect(callOllamaChat).toHaveBeenCalledTimes(1);
  });

  it('caches a schedule fallback plan on a thrown error and does not retry immediately', async () => {
    const { cache, queue, gen } = setup();
    vi.mocked(callOllamaChat).mockImplementationOnce(() => { throw new Error('connect ECONNREFUSED'); });

    gen.queueGeneration(agentId, clock);
    await settled(queue);

    const plan = cache.get(agentId)!;
    expect(plan).toMatchObject({ day: 1, source: 'fallback' });
    expect(plan.blocks.length).toBeGreaterThan(0);
    // Built from the agent's own schedule and workplace, not from the LLM.
    expect(plan.blocks).toContainEqual(expect.objectContaining({ broad_action: 'work', location_hint: workplaceName, start_hour: SCHEDULE.workStart }));
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    // No 'plan' memory for a plan the agent never actually came up with.
    expect(memory.record).not.toHaveBeenCalled();

    // Decisions keep asking every pass; none of it reaches the LLM.
    for (let m = 1; m < PLAN_RETRY_BACKOFF_MINUTES[0]; m += 5) {
      expect(gen.queueGeneration(agentId, at(8, m))).toBe(false);
    }
    expect(callOllamaChat).toHaveBeenCalledTimes(1);
    expect(gen.getRetryAt(agentId)).toBe(gameMinuteOf(at(8)) + PLAN_RETRY_BACKOFF_MINUTES[0]);
  });

  it('treats unparseable output as a failure too', async () => {
    const { cache, queue, gen } = setup();
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: 'I would rather not say.' }) as never);

    gen.queueGeneration(agentId, clock);
    await settled(queue);

    expect(cache.get(agentId)?.source).toBe('fallback');
    expect(gen.queueGeneration(agentId, at(8, 10))).toBe(false);
  });

  it('retries after the backoff and upgrades the fallback to an LLM plan', async () => {
    const { cache, queue, gen } = setup();
    vi.mocked(callOllamaChat).mockImplementationOnce(() => { throw new Error('timed out'); });
    gen.queueGeneration(agentId, clock);
    await settled(queue);
    expect(cache.get(agentId)?.source).toBe('fallback');

    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: GOOD_PLAN }) as never);
    clock = at(8, PLAN_RETRY_BACKOFF_MINUTES[0]);
    expect(gen.queueGeneration(agentId, clock)).toBe(true);
    await settled(queue);

    expect(callOllamaChat).toHaveBeenCalledTimes(2);
    const plan = cache.get(agentId)!;
    expect(plan.source).toBe('llm');
    expect(plan.blocks.map((b) => b.broad_action)).toContain('Bake bread');
    expect(gen.getRetryAt(agentId)).toBeNull();
    // A real plan for today is final: later asks run no LLM call.
    gen.queueGeneration(agentId, at(10));
    await settled(queue);
    expect(callOllamaChat).toHaveBeenCalledTimes(2);
  });

  it('grows the backoff on consecutive failures and logs one feed error per streak', async () => {
    const { queue, gen } = setup();
    const start = gameMinuteOf(clock);
    let elapsed = 0;
    for (let i = 0; i < PLAN_RETRY_BACKOFF_MINUTES.length + 1; i++) {
      vi.mocked(callOllamaChat).mockImplementationOnce(() => { throw new Error('down'); });
      clock = at(8 + Math.floor(elapsed / 60), elapsed % 60);
      expect(gen.queueGeneration(agentId, clock)).toBe(true);
      await settled(queue);
      const wait = PLAN_RETRY_BACKOFF_MINUTES[Math.min(i, PLAN_RETRY_BACKOFF_MINUTES.length - 1)];
      expect(gen.getRetryAt(agentId)).toBe(start + elapsed + wait);
      elapsed += wait;
    }
    const feedErrors = vi.mocked(logActivity).mock.calls.filter(([p]) => p.type === 'error');
    expect(feedErrors).toHaveLength(1);
  });

  it('measures the backoff from when the failure lands, not from when it was queued', async () => {
    const { queue, gen } = setup();
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => {
      clock = at(9); // a slow timeout: an hour of game time passes at high tick speed
      throw new Error('timed out');
    });
    gen.queueGeneration(agentId, at(8));
    await settled(queue);
    expect(gen.getRetryAt(agentId)).toBe(gameMinuteOf(at(9)) + PLAN_RETRY_BACKOFF_MINUTES[0]);
  });

  it('forgets backoffs on clear() (world replace)', async () => {
    const { queue, gen } = setup();
    vi.mocked(callOllamaChat).mockImplementationOnce(() => { throw new Error('down'); });
    gen.queueGeneration(agentId, clock);
    await settled(queue);
    expect(gen.queueGeneration(agentId, clock)).toBe(false);

    gen.clear();
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: GOOD_PLAN }) as never);
    expect(gen.queueGeneration(agentId, clock)).toBe(true);
    await settled(queue);
  });

  it('drops a result that lands after a world replace', async () => {
    const { cache, queue, gen } = setup();
    let release!: () => void;
    vi.mocked(callOllamaChat).mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ text: GOOD_PLAN } as never); }),
    );
    gen.queueGeneration(agentId, clock);
    await vi.waitFor(() => expect(callOllamaChat).toHaveBeenCalledTimes(1));
    gen.clear();
    release();
    await settled(queue);
    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('PlanExecutor with a fallback plan', () => {
  it('defers to the utility layer instead of queueing LLM decomposition', () => {
    const cache = makeCache();
    const decomposer = { queueDecomposition: vi.fn() };
    const executor = new PlanExecutor(cache, decomposer as never);
    cache.set(agentId, {
      day: 1,
      generated_at: 0,
      needs_snapshot: { hunger: 50, energy: 50, social: 50 },
      source: 'fallback',
      blocks: [{ id: 'fallback_0', start_hour: 9, end_hour: 17, broad_action: 'work', location_hint: 'Bakery', status: 'pending' }],
    });

    expect(executor.getPlannedAction(agentId, 10, 600, 1)).toBeNull();
    expect(decomposer.queueDecomposition).not.toHaveBeenCalled();
  });
});
