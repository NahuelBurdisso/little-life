import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn() }));
vi.mock('../../activityLogger', () => ({ logActivity: vi.fn(), pruneActivityLog: vi.fn() }));

import { db } from '../../../db';
import { agents, locations } from '../../../db/schema';
import { callOllamaChat } from '../../../ai/ollama';
import {
  PlanLLMGate,
  PLAN_OUTAGE_THRESHOLD,
  PLAN_RETRY_BACKOFF_MINUTES,
  PLAN_RETRY_FLOOR_SECONDS,
  gameMinuteOf,
} from '../PlanLLMGate';
import { PlanLLMQueue } from '../PlanLLMQueue';
import { PlanDecomposer } from '../PlanDecomposer';
import { PlanExecutor } from '../PlanExecutor';
import type { DailyPlan, PlanExecutionState } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let agentId: number;
let otherIds: number[] = [];
let bakery: string;

beforeAll(() => {
  const tag = `decomp-${Date.now()}`;
  bakery = `${tag} Bakery`;
  const loc = db.insert(locations).values({
    name: bakery,
    type: 'bakery',
    position: { x: 0, y: 0, width: 32, height: 32 },
    entry_point: { x: 0, y: 0 },
    capacity: 4,
    current_occupants: [],
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
  const [first, ...rest] = ['Rosa', 'Tom', 'Ada'].map((n) => db.insert(agents).values({
    name: `${tag} ${n}`,
    bio: 'baker',
    traits: ['kind'],
    personality: null,
    age: 30,
    gender: 'female',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 0, y: 0 },
    current_destination: null,
    current_location: loc,
    current_action: { type: 'idle' },
    action_started: 0,
    action_duration: null,
    action_queue: [],
    current_path: null,
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: loc,
    workplace: loc,
    created_at: 0,
    is_active: false,
  }).returning({ id: agents.id }).get().id);
  agentId = first;
  otherIds = rest;
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

/** A one-block LLM plan covering 9–17. */
function workPlan(): DailyPlan {
  return {
    day: 1,
    generated_at: 0,
    needs_snapshot: { hunger: 50, energy: 50, social: 50 },
    source: 'llm',
    blocks: [{ id: 'block_0', start_hour: 9, end_hour: 17, broad_action: 'Bake bread', location_hint: 'Bakery', status: 'pending' }],
  };
}

let hour: number;
let minute: number;
let wall: number;

function setup() {
  const cache = makeCache();
  const queue = new PlanLLMQueue();
  const gate = new PlanLLMGate(() => gameMinuteOf({ day: 1, hour, minute }), {
    wallNow: () => wall,
    random: () => 0.5,
  });
  const decomposer = new PlanDecomposer(cache, queue, gate);
  const executor = new PlanExecutor(cache, decomposer);
  cache.set(agentId, workPlan());
  const act = () => executor.getPlannedAction(agentId, hour, 0, 1, minute);
  return { cache, queue, gate, decomposer, executor, act };
}

async function settled(queue: PlanLLMQueue, id = agentId) {
  await vi.waitFor(() => expect(queue.isPending(id, 'decompose:block_0')).toBe(false));
}

const GOOD_ACTIONS = `Knead dough | ${'BAKERY'} | 60 minutes\nBake loaves | ${'BAKERY'} | 90 minutes`;
const goodActions = () => GOOD_ACTIONS.split('BAKERY').join(bakery);
const fail = (msg = 'ECONNREFUSED') => vi.mocked(callOllamaChat).mockImplementationOnce(() => { throw new Error(msg); });

beforeEach(() => {
  vi.mocked(callOllamaChat).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  hour = 10;
  minute = 0;
  wall = 1_000_000;
});

// ---------------------------------------------------------------------------
// Executor + decomposer under LLM failure
// ---------------------------------------------------------------------------

describe('plan execution when block decomposition fails', () => {
  it('idles only while decomposition is actually in flight', async () => {
    const { queue, act } = setup();
    let release!: () => void;
    vi.mocked(callOllamaChat).mockImplementationOnce(
      () => new Promise((_res, rej) => { release = () => rej(new Error('timed out')); }),
    );

    // Block activates, decomposition goes out: hold the agent briefly.
    expect(act()).toMatchObject({ action: 'idle', score: 6000 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await settled(queue);

    // It failed: the agent is handed back to needs/schedule scoring rather
    // than idling at 6000 until 17:00.
    expect(act()).toBeNull();
  });

  it('does not re-ask the LLM on every pass during the backoff, then retries and executes', async () => {
    const { cache, queue, gate, act } = setup();
    fail();
    act();
    await settled(queue);
    expect(callOllamaChat).toHaveBeenCalledTimes(1);

    for (let m = 1; m < PLAN_RETRY_BACKOFF_MINUTES[0]; m += 3) {
      minute = m;
      expect(act()).toBeNull();
    }
    expect(callOllamaChat).toHaveBeenCalledTimes(1);
    expect(gate.getRetryAt(agentId)).not.toBeNull();

    // Backoff over (both clocks): the next pass asks again, and once the
    // actions arrive the plan drives the agent.
    minute = PLAN_RETRY_BACKOFF_MINUTES[0];
    wall += PLAN_RETRY_FLOOR_SECONDS[0] * 1000;
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: goodActions() }) as never);
    expect(act()).toMatchObject({ action: 'idle' }); // in flight again
    await settled(queue);

    expect(callOllamaChat).toHaveBeenCalledTimes(2);
    expect(cache.get(agentId)!.blocks[0].decomposed_actions).toHaveLength(2);
    expect(gate.getRetryAt(agentId)).toBeNull();
    const planned = act();
    expect(planned).not.toBeNull();
    expect(planned!.source).toBe('plan:decomposed');
  });

  it('treats unusable decomposition output as a failure and writes nothing', async () => {
    const { cache, queue, gate, act } = setup();
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: '' }) as never);
    act();
    await settled(queue);
    expect(cache.get(agentId)!.blocks[0].decomposed_actions).toBeUndefined();
    expect(gate.getRetryAt(agentId)).not.toBeNull();
    expect(act()).toBeNull();
  });

  it('yields without calling the LLM while the outage breaker is open', async () => {
    const { gate, act } = setup();
    // Other agents' failures trip the breaker.
    for (let i = 0; i < PLAN_OUTAGE_THRESHOLD; i++) gate.recordFailure(otherIds[i % otherIds.length], 'down');
    expect(gate.isOutage()).toBe(true);

    expect(act()).toBeNull();
    expect(callOllamaChat).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stale results
// ---------------------------------------------------------------------------

describe('decomposition results that land late', () => {
  async function inFlight() {
    const s = setup();
    let release!: () => void;
    vi.mocked(callOllamaChat).mockImplementationOnce(
      () => new Promise((res) => { release = () => res({ text: goodActions() } as never); }),
    );
    s.act();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    s.cache.set.mockClear();
    return { ...s, release };
  }

  it('are dropped after a world replace (epoch changed)', async () => {
    const { cache, queue, gate, release } = await inFlight();
    gate.clear();
    release();
    await settled(queue);
    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.get(agentId)!.blocks[0].decomposed_actions).toBeUndefined();
  });

  it('are dropped when the plan was replaced meanwhile', async () => {
    const { cache, queue, release } = await inFlight();
    const newer = workPlan();
    newer.blocks[0].broad_action = 'Visit the market';
    cache.set(agentId, newer);
    cache.set.mockClear();
    release();
    await settled(queue);
    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.get(agentId)).toBe(newer);
    expect(newer.blocks[0].decomposed_actions).toBeUndefined();
  });
});
