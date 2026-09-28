import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// The LLM client is the thing under failure here; the activity log is mocked so
// the test can assert how often an outage reaches the player's feed.
vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn() }));
vi.mock('../../activityLogger', () => ({ logActivity: vi.fn(), pruneActivityLog: vi.fn() }));

import { db } from '../../../db';
import { agents, locations } from '../../../db/schema';
import { callOllamaChat } from '../../../ai/ollama';
import { logActivity } from '../../activityLogger';
import {
  PlanLLMGate,
  PLAN_RETRY_BACKOFF_MINUTES,
  PLAN_RETRY_FLOOR_SECONDS,
  PLAN_OUTAGE_THRESHOLD,
  PLAN_OUTAGE_PROBE_SECONDS,
  gameMinuteOf,
  type GameClock,
} from '../PlanLLMGate';
import { PlanGenerator } from '../PlanGenerator';
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

/** Our agents; `agentId` is the one most tests use. */
let ids: number[] = [];
let agentId: number;
let workplaceName: string;

beforeAll(() => {
  // The worker DB is shared with other files, so use unique names and only
  // ever refer to our own rows by id. Inactive so no other file's decisions
  // pass picks them up.
  const tag = `plangen-${Date.now()}`;
  const home = insertLocation(`${tag} Home`);
  workplaceName = `${tag} Bakery`;
  const work = insertLocation(workplaceName);
  ids = ['Rosa', 'Tom', 'Ada', 'Lin'].map((n) => db.insert(agents).values({
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
    is_active: false,
  }).returning({ id: agents.id }).get().id);
  agentId = ids[0];
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
/** Mutable wall clock (ms). */
let wall: number;
/** RNG fed to the jitter; 0.5 means "no jitter". */
let rand: number;

/** The gate of the most recent `setup()` (backoff, breaker, epoch). */
let gate: PlanLLMGate;

function setup() {
  const cache = makeCache();
  const queue = new PlanLLMQueue();
  gate = new PlanLLMGate(() => gameMinuteOf(clock), {
    wallNow: () => wall,
    random: () => rand,
  });
  const gen = new PlanGenerator(cache, queue, memory, gate);
  return { cache, queue, gen };
}

/** Advance both clocks well past any per-agent backoff and breaker window. */
function farLater() {
  const m = gameMinuteOf(clock) + 24 * 60 - 1;
  clock = { day: Math.floor(m / 1440) + 1, hour: Math.floor((m % 1440) / 60), minute: m % 60 };
  wall += 3600_000;
}

/** Wait for an agent's plan job to finish (the queue releases its key). */
async function settled(queue: PlanLLMQueue, id = agentId) {
  await vi.waitFor(() => expect(queue.isPending(id, 'generate')).toBe(false));
}

const feedErrors = () => vi.mocked(logActivity).mock.calls.filter(([p]) => p.type === 'error');
const fail = (msg = 'down') => vi.mocked(callOllamaChat).mockImplementationOnce(() => { throw new Error(msg); });
const succeed = () => vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: GOOD_PLAN }) as never);

const GOOD_PLAN = '07:00-09:00 | Have breakfast | Home\n09:00-17:00 | Bake bread | Bakery\n17:00-21:00 | Read | Home';

beforeEach(() => {
  // mockClear, not mockReset: see the Vitest 2 note in CLAUDE.md.
  vi.mocked(callOllamaChat).mockClear();
  vi.mocked(logActivity).mockClear();
  memory.record.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  clock = at(8);
  wall = 1_000_000;
  rand = 0.5;
});

// ---------------------------------------------------------------------------
// Per-agent behaviour
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
    fail('connect ECONNREFUSED');

    gen.queueGeneration(agentId, clock);
    await settled(queue);

    const plan = cache.get(agentId)!;
    expect(plan).toMatchObject({ day: 1, source: 'fallback' });
    expect(plan.blocks.length).toBeGreaterThan(0);
    // Built from the agent's own schedule and workplace, not from the LLM.
    expect(plan.blocks).toContainEqual(expect.objectContaining({ broad_action: 'work', location_hint: workplaceName, start_hour: SCHEDULE.workStart }));
    // One agent's single failure is not an outage: console only, no feed entry.
    expect(feedErrors()).toHaveLength(0);
    // No 'plan' memory for a plan the agent never actually came up with.
    expect(memory.record).not.toHaveBeenCalled();

    // Decisions keep asking every pass; none of it reaches the LLM.
    for (let m = 1; m < PLAN_RETRY_BACKOFF_MINUTES[0]; m += 5) {
      expect(gen.queueGeneration(agentId, at(8, m))).toBe(false);
    }
    expect(callOllamaChat).toHaveBeenCalledTimes(1);
    expect(gate.getRetryAt(agentId)).toBe(gameMinuteOf(at(8)) + PLAN_RETRY_BACKOFF_MINUTES[0]);
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
    fail('timed out');
    gen.queueGeneration(agentId, clock);
    await settled(queue);
    expect(cache.get(agentId)?.source).toBe('fallback');

    succeed();
    clock = at(8, PLAN_RETRY_BACKOFF_MINUTES[0]);
    wall += PLAN_RETRY_FLOOR_SECONDS[0] * 1000;
    expect(gen.queueGeneration(agentId, clock)).toBe(true);
    await settled(queue);

    expect(callOllamaChat).toHaveBeenCalledTimes(2);
    const plan = cache.get(agentId)!;
    expect(plan.source).toBe('llm');
    expect(plan.blocks.map((b) => b.broad_action)).toContain('Bake bread');
    expect(gate.getRetryAt(agentId)).toBeNull();
    // A real plan for today is final: later asks run no LLM call.
    gen.queueGeneration(agentId, at(10));
    await settled(queue);
    expect(callOllamaChat).toHaveBeenCalledTimes(2);
  });

  it('holds retries to a real-time floor even when game time races ahead', async () => {
    // tick_speed 4: 30 game minutes are 7.5 real seconds, far shorter than the
    // LLM timeout. A hung Ollama must not get a fresh request every 7.5 s.
    const { queue, gen } = setup();
    fail('timed out');
    gen.queueGeneration(agentId, clock);
    await settled(queue);

    clock = at(8, PLAN_RETRY_BACKOFF_MINUTES[0]);
    wall += 7_500;
    expect(gen.queueGeneration(agentId, clock)).toBe(false);

    wall += PLAN_RETRY_FLOOR_SECONDS[0] * 1000;
    fail();
    expect(gen.queueGeneration(agentId, clock)).toBe(true);
    await settled(queue);
  });

  it('grows the backoff on consecutive failures', async () => {
    const { queue, gen } = setup();
    let expected = 0;
    for (let i = 0; i < PLAN_RETRY_BACKOFF_MINUTES.length + 1; i++) {
      fail();
      // Past the per-agent floor and the breaker window, so only the
      // backoff length itself is under test.
      wall += 3600_000;
      clock = at(8 + i * 4); // 4 h apart: longer than the longest backoff
      expect(gen.queueGeneration(agentId, clock)).toBe(true);
      await settled(queue);
      expected = PLAN_RETRY_BACKOFF_MINUTES[Math.min(i, PLAN_RETRY_BACKOFF_MINUTES.length - 1)];
      expect(gate.getRetryAt(agentId)).toBe(gameMinuteOf(clock) + expected);
    }
  });

  it('jitters the backoff by up to ±20%', async () => {
    const waits: number[] = [];
    for (const r of [0, 1]) {
      const { queue, gen } = setup();
      rand = r;
      fail();
      gen.queueGeneration(agentId, clock);
      await settled(queue);
      waits.push(gate.getRetryAt(agentId)! - gameMinuteOf(clock));
    }
    expect(waits).toEqual([PLAN_RETRY_BACKOFF_MINUTES[0] * 0.8, PLAN_RETRY_BACKOFF_MINUTES[0] * 1.2]);
  });

  it('measures the backoff from when the failure lands, not from when it was queued', async () => {
    const { queue, gen } = setup();
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => {
      clock = at(9); // a slow timeout: an hour of game time passes at high tick speed
      throw new Error('timed out');
    });
    gen.queueGeneration(agentId, at(8));
    await settled(queue);
    expect(gate.getRetryAt(agentId)).toBe(gameMinuteOf(at(9)) + PLAN_RETRY_BACKOFF_MINUTES[0]);
  });

  it('forgets backoffs on clear() (world replace)', async () => {
    const { queue, gen } = setup();
    fail();
    gen.queueGeneration(agentId, clock);
    await settled(queue);
    expect(gen.queueGeneration(agentId, clock)).toBe(false);

    gate.clear();
    succeed();
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
    gate.clear();
    release();
    await settled(queue);
    expect(cache.set).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Global circuit breaker
// ---------------------------------------------------------------------------

describe('PlanGenerator outage breaker', () => {
  /** Fail one plan for each of agents [from, to). */
  async function failAgents(gen: PlanGenerator, queue: PlanLLMQueue, to: number, from = 0) {
    for (const id of ids.slice(from, to)) {
      fail('ECONNREFUSED');
      expect(gen.queueGeneration(id, clock)).toBe(true);
      await settled(queue, id);
    }
  }

  it('trips after consecutive failures across agents and reports it to the feed once', async () => {
    const { queue, gen } = setup();
    await failAgents(gen, queue, PLAN_OUTAGE_THRESHOLD - 1);
    expect(gate.isOutage()).toBe(false);
    expect(feedErrors()).toHaveLength(0);

    await failAgents(gen, queue, PLAN_OUTAGE_THRESHOLD, PLAN_OUTAGE_THRESHOLD - 1);
    expect(gate.isOutage()).toBe(true);
    expect(feedErrors()).toHaveLength(1);

    // An agent with no backoff of its own is still refused while the breaker is open.
    expect(gen.queueGeneration(ids[3], clock)).toBe(false);
    expect(callOllamaChat).toHaveBeenCalledTimes(PLAN_OUTAGE_THRESHOLD);
  });

  it('lets one probe through per window; its failure re-opens, its success closes', async () => {
    const { queue, gen } = setup();
    await failAgents(gen, queue, PLAN_OUTAGE_THRESHOLD);

    // Window elapsed: exactly one probe gets through.
    wall += PLAN_OUTAGE_PROBE_SECONDS * 1000;
    let release!: () => void;
    vi.mocked(callOllamaChat).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { release = () => reject(new Error('still down')); }),
    );
    expect(gen.queueGeneration(ids[3], clock)).toBe(true);
    // Agent 0's own floor has passed too, but a probe is already out.
    expect(gen.queueGeneration(ids[0], at(10))).toBe(false);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await settled(queue, ids[3]);

    // Probe failed: closed again for another window, and still one feed entry.
    expect(gen.queueGeneration(ids[0], at(10))).toBe(false);
    expect(feedErrors()).toHaveLength(1);

    // Next window: the probe succeeds and everyone may ask again.
    farLater();
    succeed();
    expect(gen.queueGeneration(ids[0], clock)).toBe(true);
    await settled(queue, ids[0]);
    expect(gate.isOutage()).toBe(false);
    succeed();
    expect(gen.queueGeneration(ids[1], clock)).toBe(true);
    await settled(queue, ids[1]);

    // A later outage is a new outage and gets its own feed entry.
    farLater();
    await failAgents(gen, queue, PLAN_OUTAGE_THRESHOLD);
    expect(feedErrors()).toHaveLength(2);
  });

  it('releases the probe slot when the probe ends without reaching the LLM', async () => {
    const { cache, queue, gen } = setup();
    await failAgents(gen, queue, PLAN_OUTAGE_THRESHOLD);
    // ids[3] already has a real plan for today, so its probe returns early.
    cache.set(ids[3], { day: 1, generated_at: 0, blocks: [], needs_snapshot: { hunger: 50, energy: 50, social: 50 }, source: 'llm' });

    wall += PLAN_OUTAGE_PROBE_SECONDS * 1000;
    expect(gen.queueGeneration(ids[3], clock)).toBe(true);
    await settled(queue, ids[3]);

    farLater();
    fail();
    expect(gen.queueGeneration(ids[0], clock)).toBe(true);
    await settled(queue, ids[0]);
  });
});

describe('PlanGenerator replan under failure', () => {
  const event = { agentId: 0, type: 'conversation' as const, description: 'had a fight', sentiment: -0.9, isDramatic: true };
  // parsePlanBlocks wants at least 3 blocks.
  const REPLAN_OUTPUT = '10:00-13:00 | Sulk at home | Home\n13:00-17:00 | Walk it off | Home\n17:00-21:00 | Read | Home';

  function withActivePlan(cache: ReturnType<typeof makeCache>): DailyPlan {
    const plan: DailyPlan = {
      day: 1,
      generated_at: 0,
      needs_snapshot: { hunger: 50, energy: 50, social: 50 },
      source: 'llm',
      blocks: [
        { id: 'block_0', start_hour: 7, end_hour: 9, broad_action: 'Breakfast', location_hint: 'Home', status: 'completed' },
        { id: 'block_1', start_hour: 9, end_hour: 17, broad_action: 'Bake bread', location_hint: 'Bakery', status: 'active' },
      ],
    };
    cache.set(agentId, plan);
    cache.set.mockClear();
    return plan;
  }

  async function replanSettled(queue: PlanLLMQueue) {
    await vi.waitFor(() => expect(queue.isPending(agentId, 'replan')).toBe(false));
  }

  it('keeps the running block intact and backs off when the LLM fails', async () => {
    const { cache, queue, gen } = setup();
    const plan = withActivePlan(cache);
    fail('timed out');
    gen.queueReplan(agentId, event, 10, gameMinuteOf(at(10)), 22);
    await replanSettled(queue);

    expect(plan.blocks[1].status).toBe('active');
    expect(cache.set).not.toHaveBeenCalled();
    expect(gate.getRetryAt(agentId)).not.toBeNull();

    // Inside the backoff, further replans don't reach the LLM.
    gen.queueReplan(agentId, event, 10, gameMinuteOf(at(10, 5)), 22);
    await replanSettled(queue);
    expect(callOllamaChat).toHaveBeenCalledTimes(1);
  });

  it('drops a replan that lands after a world replace', async () => {
    const { cache, queue, gen } = setup();
    withActivePlan(cache);
    let release!: () => void;
    vi.mocked(callOllamaChat).mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ text: REPLAN_OUTPUT } as never); }),
    );
    gen.queueReplan(agentId, event, 10, gameMinuteOf(at(10)), 22);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    gate.clear();
    release();
    await replanSettled(queue);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('still applies a replan in the normal case', async () => {
    const { cache, queue, gen } = setup();
    withActivePlan(cache);
    vi.mocked(callOllamaChat).mockImplementationOnce(async () => ({ text: REPLAN_OUTPUT }) as never);
    gen.queueReplan(agentId, event, 10, gameMinuteOf(at(10)), 22);
    await replanSettled(queue);
    expect(cache.get(agentId)!.blocks.map((b) => b.broad_action)).toEqual(['Breakfast', 'Sulk at home', 'Walk it off', 'Read']);
    expect(gate.getRetryAt(agentId)).toBeNull();
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
