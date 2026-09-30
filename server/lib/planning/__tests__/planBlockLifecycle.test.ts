import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn() }));
vi.mock('../../activityLogger', () => ({ logActivity: vi.fn(), pruneActivityLog: vi.fn() }));

import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { agents, locations } from '../../../db/schema';
import { callOllamaChat } from '../../../ai/ollama';
import { gameMinutes } from '../../gameClock';
import { PlanLLMGate, PLAN_OUTAGE_THRESHOLD } from '../PlanLLMGate';
import { PlanLLMQueue } from '../PlanLLMQueue';
import { PlanDecomposer } from '../PlanDecomposer';
import { PlanExecutor } from '../PlanExecutor';
import { planCache } from '../PlanCache';
import type { DailyPlan, PlanBlock } from '../types';

/**
 * Two things share these fixtures because both are observed through the same
 * real PlanCache + `agents.daily_plan` row:
 *  - blocks that need no LLM (sleep, own-workplace shift, meal at home) are
 *    decomposed on the spot, around the queue, the gate and the model (L2);
 *  - every status a block passes through is in the saved plan, not only in
 *    the in-memory cache (G8).
 */

let agentId: number;
let otherId: number;
let homeName: string;
let shopName: string;
let marketName: string;
let homeId: number;
let shopId: number;

function makeLocation(name: string, type: string): number {
  return db.insert(locations).values({
    name,
    type,
    position: { x: 0, y: 0, width: 32, height: 32 },
    entry_point: { x: 0, y: 0 },
    capacity: 4,
    current_occupants: [],
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function makeAgent(name: string, home: number, workplace: number | null): number {
  return db.insert(agents).values({
    name,
    bio: 'x',
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
    schedule: { wakeTime: 7, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home,
    workplace,
    created_at: 0,
    is_active: false,
  }).returning({ id: agents.id }).get().id;
}

beforeAll(() => {
  const tag = `lifecycle-${Date.now()}`;
  homeName = `${tag} Cottage`;
  shopName = `${tag} Store`;
  marketName = `${tag} Market`;
  homeId = makeLocation(homeName, 'house');
  shopId = makeLocation(shopName, 'shop');
  makeLocation(marketName, 'market');
  agentId = makeAgent(`${tag} Rosa`, homeId, shopId);
  otherId = makeAgent(`${tag} Tom`, homeId, null);
});

let hour = 10;
let minute = 0;
let wall = 1_000_000;

function setup(blocks: Array<Partial<PlanBlock> & Pick<PlanBlock, 'start_hour' | 'end_hour' | 'broad_action' | 'location_hint'>>) {
  const queue = new PlanLLMQueue();
  const gate = new PlanLLMGate(() => gameMinutes({ day: 1, hour, minute }), { wallNow: () => wall, random: () => 0.5 });
  const decomposer = new PlanDecomposer(planCache, queue, gate);
  const executor = new PlanExecutor(planCache, decomposer);
  const plan: DailyPlan = {
    day: 1,
    generated_at: 0,
    needs_snapshot: { hunger: 50, energy: 50, social: 50 },
    source: 'llm',
    blocks: blocks.map((b, i) => ({ id: `block_${i}`, status: 'pending' as const, ...b })),
  };
  planCache.invalidate(agentId);
  planCache.set(agentId, plan);
  const act = () => executor.getPlannedAction(agentId, hour, 0, 1, minute);
  const settled = () => vi.waitFor(() => {
    expect(queue.isPending(agentId, 'decompose:block_0')).toBe(false);
    expect(queue.isPending(agentId, 'decompose:block_1')).toBe(false);
  });
  return { queue, gate, plan, act, settled };
}

/** What a fresh reader (the UI, or the server after a restart) sees of the plan. */
function saved(): DailyPlan {
  const row = db.select({ p: agents.daily_plan }).from(agents).where(eq(agents.id, agentId)).get();
  return JSON.parse(JSON.stringify(row!.p)) as DailyPlan;
}
const savedStatuses = () => saved().blocks.map((b) => b.status);

beforeEach(() => {
  vi.mocked(callOllamaChat).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  hour = 10;
  minute = 0;
  wall = 1_000_000;
});

const llmAnswers = (minutes = 60) =>
  vi.mocked(callOllamaChat).mockImplementation(async () =>
    ({ text: JSON.stringify({ actions: [{ action: 'Haggle with the market traders', location: marketName, minutes }] }) }) as never);

// ---------------------------------------------------------------------------
// L2: blocks decomposed without the LLM
// ---------------------------------------------------------------------------

describe('blocks that need no LLM', () => {
  it('sleep at home runs on the same pass, without a model call', () => {
    hour = 22;
    const { act, plan } = setup([{ start_hour: 22, end_hour: 24, broad_action: 'Go to bed and sleep', location_hint: homeName }]);
    expect(act()).toMatchObject({ action: 'sleeping', targetLocationId: homeId, source: 'plan:decomposed' });
    expect(callOllamaChat).not.toHaveBeenCalled();
    expect(plan.blocks[0].decomposed_actions).toEqual([
      { description: 'Go to bed and sleep', action_type: 'sleeping', target_location: homeName, resolved_location_id: homeId, duration_minutes: 120 },
    ]);
    // ...and it was saved with the plan.
    expect(saved().blocks[0].decomposed_actions).toHaveLength(1);
  });

  it('a shift at the own workplace is working there', () => {
    hour = 9;
    const { act } = setup([{ start_hour: 9, end_hour: 12, broad_action: 'Open the shop and restock shelves', location_hint: shopName }]);
    expect(act()).toMatchObject({ action: 'working', targetLocationId: shopId });
    expect(callOllamaChat).not.toHaveBeenCalled();
  });

  it('a plain meal at home is eating there', () => {
    hour = 12;
    const { act } = setup([{ start_hour: 12, end_hour: 13, broad_action: 'Lunch at home', location_hint: homeName }]);
    expect(act()).toMatchObject({ action: 'eating', targetLocationId: homeId });
    expect(callOllamaChat).not.toHaveBeenCalled();
  });

  it('prefetches the next block deterministically too', async () => {
    hour = 8; // last hour of the first block
    const { act, plan, settled } = setup([
      { start_hour: 7, end_hour: 9, broad_action: 'Haggle with the market traders', location_hint: marketName },
      { start_hour: 9, end_hour: 12, broad_action: 'Serve customers', location_hint: shopName },
    ]);
    llmAnswers();
    act(); // activates block_0, whose decomposition goes to the LLM
    await settled();
    // Its actions are in and it is in its last hour: block_1 is prefetched.
    act();
    expect(plan.blocks[1].decomposed_actions).toHaveLength(1);
    expect(plan.blocks[1].decomposed_actions![0].action_type).toBe('working');
    expect(vi.mocked(callOllamaChat)).toHaveBeenCalledTimes(1); // block_0 only
  });

  it('still asks the LLM for blocks that are not routine', async () => {
    const { act, settled, plan } = setup([{ start_hour: 10, end_hour: 11, broad_action: 'Haggle with the market traders', location_hint: marketName }]);
    llmAnswers();
    expect(act()).toMatchObject({ action: 'idle', score: 6000 }); // held while the call is out
    await settled();
    expect(callOllamaChat).toHaveBeenCalledTimes(1);
    expect(plan.blocks[0].decomposed_actions).toHaveLength(1);
  });

  it('asks the LLM when a routine word comes with company', async () => {
    hour = 12;
    const { act, settled } = setup([{ start_hour: 12, end_hour: 13, broad_action: 'Lunch with neighbours', location_hint: homeName }]);
    llmAnswers();
    act();
    await settled();
    expect(callOllamaChat).toHaveBeenCalledTimes(1);
  });

  it('asks the LLM when the named person is someone in town', async () => {
    hour = 12;
    const { name } = db.select({ name: agents.name }).from(agents).where(eq(agents.id, otherId)).get()!;
    // No company word in the text, only the neighbour's name.
    const { act, settled } = setup([{ start_hour: 12, end_hour: 13, broad_action: `Eat at home, ${name} stops by`, location_hint: homeName }]);
    llmAnswers();
    act();
    await settled();
    expect(callOllamaChat).toHaveBeenCalledTimes(1);
  });

  it('keeps running through an LLM outage and an agent backoff', () => {
    hour = 22;
    const { act, gate } = setup([{ start_hour: 22, end_hour: 24, broad_action: 'Sleep', location_hint: homeName }]);
    for (let i = 0; i < PLAN_OUTAGE_THRESHOLD; i++) gate.recordFailure(otherId, 'down');
    gate.backOff(agentId);
    expect(act()).toMatchObject({ action: 'sleeping' });
    expect(callOllamaChat).not.toHaveBeenCalled();
  });

  it('does not re-read the DB on every pass for a block that needs the LLM', async () => {
    const { act, settled } = setup([{ start_hour: 10, end_hour: 11, broad_action: 'Haggle with the market traders', location_hint: marketName }]);
    vi.mocked(callOllamaChat).mockImplementation(() => { throw new Error('down'); });
    const select = vi.spyOn(db, 'select');
    act();
    await settled();
    const first = select.mock.calls.length;
    for (let m = 1; m < 10; m++) { minute = m; act(); }
    // Backing off after the failure: passes are a gate check and a set lookup.
    expect(select.mock.calls.length).toBe(first);
    select.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// G8: block status is saved, not just cached
// ---------------------------------------------------------------------------

describe('block status persistence', () => {
  it('saves pending -> active -> completed as they happen', async () => {
    const { act, settled } = setup([{ start_hour: 10, end_hour: 11, broad_action: 'Haggle with the market traders', location_hint: marketName }]);
    llmAnswers(30);
    expect(savedStatuses()).toEqual(['pending']);

    act();
    expect(savedStatuses()).toEqual(['active']);
    await settled();

    act(); // first pass with actions: the action starts
    minute = 30;
    expect(act()).toBeNull(); // 30 min elapsed, last action done: block completed
    expect(savedStatuses()).toEqual(['completed']);
  });

  it('a block whose hours pass without it starting is saved as skipped', () => {
    hour = 12;
    const { act } = setup([
      { start_hour: 8, end_hour: 9, broad_action: 'Haggle with the market traders', location_hint: marketName },
      { start_hour: 9, end_hour: 12, broad_action: 'Serve customers', location_hint: shopName },
      { start_hour: 12, end_hour: 13, broad_action: 'Lunch at home', location_hint: homeName },
    ]);
    act();
    expect(savedStatuses()).toEqual(['skipped', 'skipped', 'active']);
  });

  it('an active block left behind by the clock is saved as completed', () => {
    const { act } = setup([
      { start_hour: 10, end_hour: 11, broad_action: 'Haggle with the market traders', location_hint: marketName, status: 'active' },
      { start_hour: 11, end_hour: 12, broad_action: 'Haggle with the market traders', location_hint: marketName },
    ]);
    hour = 11;
    act();
    expect(savedStatuses()).toEqual(['completed', 'active']);
  });

  it('writes on transitions only, not on every pass', async () => {
    hour = 12;
    const { act } = setup([{ start_hour: 12, end_hour: 13, broad_action: 'Lunch at home', location_hint: homeName }]);
    const set =vi.spyOn(planCache, 'set');
    act(); // activates (one write) and decomposes deterministically (one write)
    const afterActivation = set.mock.calls.length;
    expect(afterActivation).toBeLessThanOrEqual(2);
    for (let m = 1; m < 50; m++) { minute = m; act(); }
    expect(set.mock.calls.length).toBe(afterActivation);
    set.mockRestore();
  });

  it('survives a cache reload (server restart)', () => {
    hour = 12;
    const { act } = setup([
      { start_hour: 8, end_hour: 9, broad_action: 'Haggle with the market traders', location_hint: marketName },
      { start_hour: 12, end_hour: 13, broad_action: 'Lunch at home', location_hint: homeName },
    ]);
    act();
    planCache.invalidate(agentId);
    expect(planCache.get(agentId)!.blocks.map((b) => b.status)).toEqual(['skipped', 'active']);
  });
});
