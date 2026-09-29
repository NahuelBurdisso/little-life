import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';

// No LLM: the harness below plays the task runner, landing turns on a
// simulated real-time schedule through the same addMessage the runner uses.
// (conversationRunner.test.ts drives the real runner end to end.)
vi.mock('../../../ai/taskRunner', () => ({
  taskRunner: {
    startConversation: vi.fn(() => true),
    abortConversation: vi.fn(),
    isRunning: vi.fn(() => false),
    inFlightTurnMs: vi.fn(() => null),
    freeConversationSlots: 4,
  },
}));

import { db } from '../../../db';
import {
  agents,
  agentStates,
  conversations,
  conversationQueue,
  conversationSchedulerState,
  locations,
  needs,
  relationshipEvents,
  templateUsage,
  worldState,
} from '../../../db/schema';
import { taskRunner } from '../../../ai/taskRunner';
import { addMessage } from '../../../helpers/conversationHelpers';
import { CONFIG } from '../../../lib/constants';
import { gameMinutes } from '../../../lib/gameClock';
import { WRAP_UP_FAREWELLS } from '../../../data/templates';
import {
  conversationBudgetGameMinutes,
  queueMaxWait,
  recordTurnLatency,
  resetConversationPacing,
  turnLatencyEstimateMs,
} from '../../../lib/conversationPacing';
import { conversationsTick, endOrphanedLLMConversations } from '../conversations';

/**
 * G1 (playtest #2): at 4x, LLM conversations ate whole nights. The budget was
 * wall-clock (15 s × 10 turns), and an LLM turn takes 20–60 real seconds at any
 * speed — so a conversation could run ten GAME hours, and Rosa and Yuki talked
 * from 21:00 to 05:00 without sleeping. Budgets are game minutes now, the turn
 * count is sized to the expected latency at the current speed, needs can end a
 * conversation, and queue waits run on the game clock.
 */

const TAG = 'budgettest';
const { MIN_LLM_TURNS, PLAYER_NUDGE_PRIORITY } = CONFIG.CONVERSATIONS;
const DEEP = 10;
const STANDARD = 6;
const runner = taskRunner as unknown as {
  startConversation: ReturnType<typeof vi.fn>;
  abortConversation: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  inFlightTurnMs: ReturnType<typeof vi.fn>;
  freeConversationSlots: number;
};

function ensureWorld(): void {
  if (db.select().from(worldState).get()) return;
  db.insert(worldState).values({
    time: { day: 1, hour: 9, minute: 0, totalTicks: 540, seasonDay: 1, season: 'spring' },
    day_phase: 'morning',
    weather: 'sunny',
    weather_duration: 120,
    tick_speed: 1,
    is_paused: true,
    last_tick_completed: 0,
    current_tick_phase: 0,
    tick_id: 'test',
    pending_transitions: [],
    tax_pool: 0,
    map_width: 40,
    map_height: 30,
    collision_grid: '',
  }).run();
}

function world() {
  return db.select().from(worldState).get()!;
}

function nowGameMin(): number {
  return gameMinutes(world().time);
}

function setClock(totalMinutes: number, tickSpeed?: number): void {
  const w = world();
  const day = Math.floor(totalMinutes / 1440);
  const hour = Math.floor((totalMinutes % 1440) / 60);
  const minute = totalMinutes % 60;
  db.update(worldState)
    .set({
      time: { ...w.time, day, hour, minute },
      ...(tickSpeed != null ? { tick_speed: tickSpeed } : {}),
    })
    .where(eq(worldState.id, w.id))
    .run();
}

function resetScheduler(): void {
  const existing = db.select().from(conversationSchedulerState).get();
  const values = {
    active_llm_conversations: [],
    max_concurrent_llm: 2,
    max_turns_deep: DEEP,
    max_turns_standard: STANDARD,
  };
  if (existing) {
    db.update(conversationSchedulerState).set(values)
      .where(eq(conversationSchedulerState.id, existing.id)).run();
    return;
  }
  db.insert(conversationSchedulerState).values({
    ...values,
    max_queue_size: 10,
    template_fallback_after_ms: 30000,
    stats: { llmConversationsTotal: 0, templateConversationsTotal: 0, averageResponseTimeMs: 0, queueTimeoutsTotal: 0 },
  }).run();
}

function insertAgent(name: string, locationId: number): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality: null,
    age: 30,
    gender: 'female',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 100, y: 100 },
    current_location: locationId,
    current_action: { type: 'idle' },
    action_started: 0,
    action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: locationId,
    created_at: 0,
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function enqueue(
  participants: number[],
  tier: string,
  { priority = 50, maxWait = 600_000, queuedAt = Date.now() }: { priority?: number; maxWait?: number; queuedAt?: number } = {},
): number {
  return db.insert(conversationQueue).values({
    participants,
    tier,
    priority,
    trigger_reason: TAG,
    topic: null,
    queued_at: queuedAt,
    max_wait: maxWait,
  }).returning({ id: conversationQueue.id }).get().id;
}

function taggedConversations() {
  return db.select().from(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).all();
}

function schedulerEntry(conversationId: number): Record<string, unknown> | undefined {
  return (db.select().from(conversationSchedulerState).get()!.active_llm_conversations as Array<Record<string, unknown>>)
    .find((e) => e.conversationId === conversationId);
}

function measured(ms: number): void {
  for (let i = 0; i < 4; i++) recordTurnLatency(ms, nowGameMin());
}

interface SimResult {
  row: typeof conversations.$inferSelect;
  /** Game minutes from the conversation opening to it ending. */
  elapsedGameMin: number;
  /** Lines the simulated runner got in (excludes any farewell). */
  landed: number;
}

/**
 * Open a queued conversation, then play the tick loop: every tick is one real
 * second and advances the clock `speed` game minutes; the simulated task runner
 * lands a turn every `turnSec` ticks (never, if null) and stops the way the real
 * one does — when addMessage refuses or reports `messageCount >= maxTurns`.
 */
async function simulate(
  participants: number[],
  { speed, turnSec, tier, priority = 50, maxTicks = 2000 }:
  { speed: number; turnSec: number | null; tier: string; priority?: number; maxTicks?: number },
): Promise<SimResult> {
  setClock(nowGameMin(), speed);
  enqueue(participants, tier, { priority });
  await conversationsTick();
  const opened = taggedConversations().find((c) => c.status === 'active');
  if (!opened) throw new Error('conversation did not open');
  const startMin = nowGameMin();

  let running = true;
  let speaker = participants[0];
  let sinceLastTurn = 0;
  let landed = 0;
  for (let tick = 1; tick <= maxTicks; tick++) {
    setClock(nowGameMin() + speed);
    sinceLastTurn++;
    if (running && turnSec != null && sinceLastTurn >= turnSec) {
      const r = addMessage(opened.id, speaker, `line ${landed}`, 0.3, [], Date.now());
      if (!r) {
        running = false;
      } else {
        landed++;
        sinceLastTurn = 0;
        speaker = participants.find((p) => p !== speaker)!;
        if (r.messageCount >= r.maxTurns) running = false;
      }
    }
    await conversationsTick();
    const row = db.select().from(conversations).where(eq(conversations.id, opened.id)).get()!;
    if (row.status === 'ended') return { row, elapsedGameMin: nowGameMin() - startMin, landed };
  }
  throw new Error('conversation never ended');
}

describe('conversationsTick — game-time conversation budget (G1)', () => {
  let locId = 0;
  let a = 0, b = 0;
  let savedWorld: { time: any; tick_speed: number; is_paused: boolean } | null = null;
  let savedTurns: { max_turns_deep: number; max_turns_standard: number } | null = null;

  beforeAll(() => {
    ensureWorld();
    const w = world();
    savedWorld = { time: w.time, tick_speed: w.tick_speed, is_paused: w.is_paused };
    const sched = db.select().from(conversationSchedulerState).get();
    if (sched) savedTurns = { max_turns_deep: sched.max_turns_deep, max_turns_standard: sched.max_turns_standard };
    locId = db.insert(locations).values({
      name: 'Budget Square',
      type: 'town_square',
      position: { x: 0, y: 0, width: 10, height: 10 },
      entry_point: { x: 0, y: 0 },
      capacity: 10,
      current_occupants: [],
      services: [],
      description: 'test',
    }).returning({ id: locations.id }).get().id;
    a = insertAgent('Rosa', locId);
    b = insertAgent('Yuki', locId);
    for (const agent_id of [a, b]) {
      db.insert(needs).values({
        agent_id,
        hunger: 60, energy: 60, social: 40, comfort: 50, fun: 40, mood: 55, stress: 20,
        decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
        thresholds: { critical: 15, low: 35, satisfied: 70 },
        mood_modifiers: [],
        last_updated: 0,
      }).run();
    }
  });

  afterAll(() => {
    resetConversationPacing();
    if (savedWorld) db.update(worldState).set(savedWorld).run();
    resetScheduler();
    if (savedTurns) db.update(conversationSchedulerState).set(savedTurns).run();
    const ids = [a, b];
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    db.run(sql`DELETE FROM activity_log
               WHERE initiator_id IN (${idList}) OR target_id IN (${idList})
                  OR EXISTS (SELECT 1 FROM json_each(activity_log.agent_ids) WHERE value IN (${idList}))`);
    db.delete(conversationQueue).run();
    db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
    db.delete(relationshipEvents).where(inArray(relationshipEvents.agent_a, ids)).run();
    db.delete(templateUsage).where(inArray(templateUsage.agent_a, ids)).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, ids)).run();
    db.delete(needs).where(inArray(needs.agent_id, ids)).run();
    db.delete(agents).where(inArray(agents.id, ids)).run();
    db.delete(locations).where(eq(locations.id, locId)).run();
  });

  beforeEach(() => {
    resetConversationPacing();
    resetScheduler();
    db.delete(conversationQueue).run();
    db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
    // 09:00 on a fresh day, well before anyone's bedtime.
    setClock(3 * 1440 + 9 * 60, 1);
    db.update(needs).set({ hunger: 60, energy: 60 }).where(inArray(needs.agent_id, [a, b])).run();
    db.update(agents).set({ current_action: { type: 'idle' } }).where(inArray(agents.id, [a, b])).run();
    runner.startConversation.mockClear();
    runner.abortConversation.mockClear();
    runner.isRunning.mockReset().mockReturnValue(false);
    runner.inFlightTurnMs.mockReset().mockReturnValue(null);
    runner.freeConversationSlots = 4;
  });

  function expectReleased(): void {
    for (const agent of db.select().from(agents).where(inArray(agents.id, [a, b])).all()) {
      expect(agent.current_action).toEqual({ type: 'idle' });
    }
  }

  describe('at 1x, conversations run as before', () => {
    it.each([
      ['llm_standard', STANDARD],
      ['llm_deep', DEEP],
    ])('%s with fast measured turns runs its full %i turns and ends naturally', async (tier, turns) => {
      measured(5000);
      const { row, landed, elapsedGameMin } = await simulate([a, b], { speed: 1, turnSec: 5, tier });

      expect(landed).toBe(turns);
      expect(row.max_turns).toBe(turns);
      expect(row.messages).toHaveLength(turns); // no farewell appended
      expect(row.quality_breakdown).not.toHaveProperty('truncated');
      expect(elapsedGameMin).toBeLessThanOrEqual(conversationBudgetGameMinutes(turns));
      expectReleased();
    });

    it('keeps the tier length before any latency has been measured', async () => {
      // 12 s turns: 72 game minutes for six, inside the 90-minute budget.
      const { row, landed } = await simulate([a, b], { speed: 1, turnSec: 12, tier: 'llm_standard' });
      expect(landed).toBe(STANDARD);
      expect(row.messages).toHaveLength(STANDARD);
    });
  });

  describe('at 4x with slow turns', () => {
    it('sizes the conversation to the latency and ends it inside budget + grace', async () => {
      // Measured 5 s turns → 20 game min each at 4x → 7 of the deep budget's 150.
      measured(5000);
      // ...but the model has slowed to 12 s (48 game min) a turn.
      const { row, landed, elapsedGameMin } = await simulate([a, b], { speed: 4, turnSec: 12, tier: 'llm_deep' });

      const budget = conversationBudgetGameMinutes(DEEP);
      const grace = 20; // one expected turn
      // The old wall-clock budget (10 turns × 15 s = 150 s) allowed 600 game min.
      expect(elapsedGameMin).toBeGreaterThanOrEqual(budget + grace);
      expect(elapsedGameMin).toBeLessThan(budget + grace + 4);
      expect(landed).toBe(3);
      const msgs = row.messages as Array<{ speakerId: number; text: string }>;
      expect(msgs).toHaveLength(4);
      // Closed by the one whose turn it was, with a clock-flavoured goodbye.
      expect(msgs[3].speakerId).toBe(b);
      const budgetLines = WRAP_UP_FAREWELLS.budget.map((l) => l.text.replace('{other.name}', 'Rosa'));
      expect(budgetLines).toContain(msgs[3].text);
      // 3 of 7 planned turns: the clock really did cut it.
      expect(row.quality_breakdown?.truncated).toBe(1);
      // The abandoned fourth turn is cancelled.
      expect(runner.abortConversation).toHaveBeenCalledWith(row.id);
      expectReleased();
    });

    it('closes a hung conversation at budget + grace without inventing a goodbye', async () => {
      measured(5000);
      const { row, elapsedGameMin } = await simulate([a, b], { speed: 4, turnSec: null, tier: 'llm_standard' });

      const limit = conversationBudgetGameMinutes(STANDARD) + 20;
      expect(elapsedGameMin).toBeGreaterThanOrEqual(limit);
      expect(elapsedGameMin).toBeLessThan(limit + 4); // the first tick past it
      expect(row.messages).toEqual([]);
      expect(runner.abortConversation).toHaveBeenCalledWith(row.id);
      expectReleased();
    });

    it('has an ordinary conversation that cannot fit one exchange on the template tier', async () => {
      // 20 s turns at 4x = 80 game min each; the standard budget is 90.
      measured(20_000);
      setClock(nowGameMin(), 4);
      enqueue([a, b], 'llm_standard');

      await conversationsTick();

      expect(runner.startConversation).not.toHaveBeenCalled();
      const rows = taggedConversations();
      expect(rows).toHaveLength(1);
      expect(rows[0].trigger_reason).toBe(`${TAG} (template)`);
      expect(rows[0].status).toBe('ended');
      expectReleased();
    });

    it('probes the model once when nothing has been measured, then trusts the prior', async () => {
      setClock(nowGameMin(), 4);
      enqueue([a, b], 'llm_standard');
      await conversationsTick();

      const probe = taggedConversations().find((c) => c.status === 'active')!;
      expect(probe.max_turns).toBe(MIN_LLM_TURNS);
      // 2 turns × 80 game min (the 20 s prior at 4x), grace one turn.
      expect(schedulerEntry(probe.id)).toMatchObject({ budgetGameMin: 160, graceGameMin: 80 });

      resetScheduler();
      db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
      enqueue([a, b], 'llm_standard');
      await conversationsTick();
      expect(taggedConversations().map((c) => c.trigger_reason)).toEqual([`${TAG} (template)`]);
    });

    it('gives a player nudge the model with room for both lines', async () => {
      measured(20_000);
      setClock(nowGameMin(), 4);
      enqueue([a, b], 'llm_deep', { priority: PLAYER_NUDGE_PRIORITY });

      await conversationsTick();

      expect(runner.startConversation).toHaveBeenCalledTimes(1);
      const row = taggedConversations().find((c) => c.status === 'active')!;
      expect(row.max_turns).toBe(MIN_LLM_TURNS);
      expect(schedulerEntry(row.id)).toMatchObject({
        budgetGameMin: 160, graceGameMin: 80, plannedTurns: MIN_LLM_TURNS, protected: true,
      });
    });
  });

  describe('latency samples from closed turns', () => {
    it('books nothing for a turn no chain is running (dead chain / restart), even at 1x', async () => {
      // isRunning / inFlightTurnMs: nothing live (the mock default).
      const { row } = await simulate([a, b], { speed: 1, turnSec: null, tier: 'llm_standard' });

      expect(row.status).toBe('ended');
      expect(turnLatencyEstimateMs(nowGameMin())).toBeNull();
    });

    it('books a live abandoned turn, capped at every attempt timing out', async () => {
      runner.inFlightTurnMs.mockReturnValue(10 * 60_000);
      await simulate([a, b], { speed: 1, turnSec: null, tier: 'llm_standard' });

      expect(turnLatencyEstimateMs(nowGameMin())).toBe(CONFIG.AI.TIMEOUT_MS * CONFIG.AI.RETRY_ATTEMPTS);
    });
  });

  describe('restart', () => {
    async function openWithOneLine(): Promise<number> {
      enqueue([a, b], 'llm_deep');
      await conversationsTick();
      const id = taggedConversations().find((c) => c.status === 'active')!.id;
      addMessage(id, a, 'Did you hear about the mill?', 0.2, [], Date.now());
      return id;
    }

    it('ends conversations the new process has no turn chain for, quietly', async () => {
      const id = await openWithOneLine();
      const relEventsBefore = db.select().from(relationshipEvents)
        .where(inArray(relationshipEvents.agent_a, [a, b])).all().length;

      expect(endOrphanedLLMConversations()).toBe(1);

      const row = db.select().from(conversations).where(eq(conversations.id, id)).get()!;
      expect(row.status).toBe('ended');
      expect(db.select().from(conversationSchedulerState).get()!.active_llm_conversations).toEqual([]);
      expectReleased();
      expect(db.select().from(relationshipEvents)
        .where(inArray(relationshipEvents.agent_a, [a, b])).all()).toHaveLength(relEventsBefore);
      // Nothing left for Step A to book as a latency sample.
      setClock(nowGameMin() + 500);
      await conversationsTick();
      expect(turnLatencyEstimateMs(nowGameMin())).toBeNull();
    });

    it('keeps a conversation whose chain is still alive', async () => {
      const id = await openWithOneLine();
      runner.isRunning.mockReturnValue(true);

      expect(endOrphanedLLMConversations()).toBe(0);
      expect(db.select().from(conversations).where(eq(conversations.id, id)).get()!.status).toBe('active');
      expect(schedulerEntry(id)).toBeDefined();
    });
  });

  describe('task runner slots', () => {
    it('does not use up the probe on a dispatch the runner rejects', async () => {
      setClock(nowGameMin(), 4);
      runner.startConversation.mockReturnValueOnce(false);
      enqueue([a, b], 'llm_standard');

      await conversationsTick();
      expect(taggedConversations()).toHaveLength(0);

      await conversationsTick();
      const probe = taggedConversations().find((c) => c.status === 'active');
      expect(probe?.max_turns).toBe(MIN_LLM_TURNS);
    });

    it('keeps the entry queued while the runner has no free chain', async () => {
      runner.freeConversationSlots = 0;
      const id = enqueue([a, b], 'llm_standard');

      await conversationsTick();

      expect(runner.startConversation).not.toHaveBeenCalled();
      expect(db.select().from(conversationQueue).where(eq(conversationQueue.id, id)).get()).toBeDefined();
      expect(taggedConversations()).toHaveLength(0);
    });

    it('re-queues an entry the runner rejects instead of losing it', async () => {
      runner.startConversation.mockReturnValueOnce(false);
      enqueue([a, b], 'llm_deep', { priority: PLAYER_NUDGE_PRIORITY });

      await conversationsTick();

      const queued = db.select().from(conversationQueue).all();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ participants: [a, b], priority: PLAYER_NUDGE_PRIORITY, tier: 'llm_deep' });
      expect(queued[0].deadline_game_min).toBe(nowGameMin() + 600);
      expect(taggedConversations()).toHaveLength(0);
      expectReleased();

      // ...and it opens on the next tick.
      await conversationsTick();
      expect(taggedConversations().filter((c) => c.status === 'active')).toHaveLength(1);
    });
  });

  describe('queue waits run on game time', () => {
    /**
     * Ticks until a queued LLM entry that can never get a slot times out into
     * a template chat. Every tick advances the clock `speed` game minutes.
     */
    async function ticksToTimeout(speed: number): Promise<{ ticks: number; gameMin: number }> {
      db.update(conversationSchedulerState).set({ max_concurrent_llm: 0 }).run();
      setClock(nowGameMin(), speed);
      const start = nowGameMin();
      const id = enqueue([a, b], 'llm_standard', { maxWait: queueMaxWait(CONFIG.CONVERSATIONS.QUEUE_MAX_WAIT_GAME_MINUTES) });
      for (let tick = 0; tick < 100; tick++) {
        await conversationsTick();
        if (!db.select().from(conversationQueue).where(eq(conversationQueue.id, id)).get()) {
          return { ticks: tick, gameMin: nowGameMin() - start };
        }
        setClock(nowGameMin() + speed);
      }
      throw new Error('entry never timed out');
    }

    it('times out after the same game minutes at 1x and 4x', async () => {
      const slow = await ticksToTimeout(1);
      // 1x is what it always was: ten seconds, one game minute each.
      expect(slow).toEqual({ ticks: 11, gameMin: 11 });
      db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
      db.delete(templateUsage).where(inArray(templateUsage.agent_a, [a, b])).run();

      const fast = await ticksToTimeout(4);
      // Used to be ten seconds = 40 game minutes at 4x.
      expect(fast).toEqual({ ticks: 3, gameMin: 12 });
      expect(taggedConversations().map((c) => c.trigger_reason)).toEqual([`${TAG} (template)`]);
    });

    it('stores the deadline once, so a speed change does not move it', async () => {
      db.update(conversationSchedulerState).set({ max_concurrent_llm: 0 }).run();
      const id = enqueue([a, b], 'llm_standard', { maxWait: 10_000 });
      await conversationsTick();
      const stamped = db.select().from(conversationQueue).where(eq(conversationQueue.id, id)).get()!.deadline_game_min;
      expect(stamped).toBe(nowGameMin() + 10);
      setClock(nowGameMin() + 1, 4);
      await conversationsTick();
      expect(db.select().from(conversationQueue).where(eq(conversationQueue.id, id)).get()!.deadline_game_min).toBe(stamped);
    });

    it('does not expire an entry queued before a long pause', async () => {
      // Queued, then the world sat paused for ten real minutes: no game time
      // passed, so it has waited nothing.
      db.update(worldState).set({ is_paused: true }).run();
      db.update(conversationSchedulerState).set({ max_concurrent_llm: 0 }).run();
      const id = enqueue([a, b], 'llm_standard', { maxWait: 10_000, queuedAt: Date.now() - 600_000 });

      await conversationsTick();

      const entry = db.select().from(conversationQueue).where(eq(conversationQueue.id, id)).get();
      expect(entry?.deadline_game_min).toBe(nowGameMin() + 10);
      expect(taggedConversations()).toHaveLength(0);
    });
  });

  describe('needs', () => {
    /** An LLM conversation two lines in (Rosa, then Yuki), opened 10 game minutes ago. */
    async function liveConversation(priority = 50): Promise<number> {
      setClock(nowGameMin(), 1);
      enqueue([a, b], 'llm_deep', { priority });
      await conversationsTick();
      const row = taggedConversations().find((c) => c.status === 'active')!;
      addMessage(row.id, a, 'How was the harvest?', 0.3, [], Date.now());
      addMessage(row.id, b, 'Better than last year, thankfully.', 0.4, [], Date.now());
      setClock(nowGameMin() + 10);
      return row.id;
    }

    function convo(id: number) {
      return db.select().from(conversations).where(eq(conversations.id, id)).get()!;
    }

    function lines(id: number) {
      return convo(id).messages as Array<{ speakerId: number; text: string }>;
    }

    it("lets the partner's in-flight reply land, then the exhausted one says goodnight", async () => {
      const id = await liveConversation();
      db.update(needs).set({ energy: 5 }).where(eq(needs.agent_id, b)).run();

      await conversationsTick();
      // Wound up, not ended: exactly Rosa's turn in flight may still land.
      expect(convo(id).status).toBe('active');
      expect(convo(id).max_turns).toBe(3);

      expect(addMessage(id, a, 'Glad to hear it.', 0.3, [], Date.now())).toEqual({ messageCount: 3, maxTurns: 3 });
      setClock(nowGameMin() + 1);
      await conversationsTick();

      const row = convo(id);
      expect(row.status).toBe('ended');
      const msgs = lines(id);
      expect(msgs).toHaveLength(4);
      expect(msgs[3].speakerId).toBe(b);
      expect(WRAP_UP_FAREWELLS.energy.map((l) => l.text.replace('{other.name}', 'Rosa'))).toContain(msgs[3].text);
      // Someone chose to leave: not a cut-short conversation.
      expect(row.quality_breakdown).not.toHaveProperty('truncated');
      expectReleased();
    });

    it('replaces the leaver’s own in-flight turn with the goodbye (bedtime)', async () => {
      setClock(3 * 1440 + 21 * 60 + 55);
      const id = await liveConversation(); // now 22:05 — past the 22:00 bedtime

      await conversationsTick();

      const row = convo(id);
      expect(row.status).toBe('ended');
      const msgs = lines(id);
      expect(msgs.map((m) => m.speakerId)).toEqual([a, b, a]);
      expect(WRAP_UP_FAREWELLS.sleep.map((l) => l.text.replace('{other.name}', 'Yuki'))).toContain(msgs[2].text);
      expect(row.quality_breakdown).not.toHaveProperty('truncated');
      // Rosa's own reply, still in flight, is refused and cancelled.
      expect(addMessage(id, a, 'Wait—', 0, [], Date.now())).toBeNull();
      expect(runner.abortConversation).toHaveBeenCalledWith(id);
      expectReleased();
    });

    it('ends for critical hunger', async () => {
      const id = await liveConversation();
      db.update(needs).set({ hunger: 3 }).where(eq(needs.agent_id, a)).run();

      await conversationsTick();

      const msgs = lines(id);
      expect(convo(id).status).toBe('ended');
      expect(msgs[msgs.length - 1].speakerId).toBe(a);
      expect(WRAP_UP_FAREWELLS.hunger.map((l) => l.text.replace('{other.name}', 'Yuki')))
        .toContain(msgs[msgs.length - 1].text);
      expectReleased();
    });

    it('never has the leaver speak twice in a row', async () => {
      const id = await liveConversation();
      db.update(needs).set({ energy: 5 }).where(eq(needs.agent_id, b)).run();

      await conversationsTick();
      // Rosa's reply never comes; the grace (15 game min at 1x) runs out.
      setClock(nowGameMin() + 15);
      await conversationsTick();

      expect(convo(id).status).toBe('ended');
      // Yuki spoke last: no goodbye tacked onto her own line.
      expect(lines(id).map((m) => m.speakerId)).toEqual([a, b]);
      expectReleased();
    });

    it('holds an ordinary conversation someone must leave, and opens it once they can stay', async () => {
      db.update(needs).set({ hunger: 3 }).where(eq(needs.agent_id, a)).run();
      const id = enqueue([a, b], 'llm_standard');

      await conversationsTick();
      expect(runner.startConversation).not.toHaveBeenCalled();
      expect(taggedConversations()).toHaveLength(0);
      // Kept, not deleted: a perception reaction is never queued twice.
      expect(db.select().from(conversationQueue).where(eq(conversationQueue.id, id)).get()).toBeDefined();

      db.update(needs).set({ hunger: 60 }).where(eq(needs.agent_id, a)).run();
      await conversationsTick();
      expect(taggedConversations().filter((c) => c.status === 'active')).toHaveLength(1);
    });

    it('lets a held one-shot entry age out into a template chat if the need persists', async () => {
      db.update(needs).set({ hunger: 3 }).where(eq(needs.agent_id, a)).run();
      enqueue([a, b], 'llm_standard', { maxWait: 10_000 });

      await conversationsTick();
      setClock(nowGameMin() + 11);
      await conversationsTick();

      expect(runner.startConversation).not.toHaveBeenCalled();
      expect(taggedConversations().map((c) => c.trigger_reason)).toEqual([`${TAG} (template)`]);
    });

    it('lets a player nudge at bedtime have its first exchange before anyone leaves', async () => {
      setClock(3 * 1440 + 23 * 60);
      enqueue([a, b], 'llm_deep', { priority: PLAYER_NUDGE_PRIORITY });
      await conversationsTick();
      const id = taggedConversations().find((c) => c.status === 'active')!.id;

      setClock(nowGameMin() + 5);
      await conversationsTick();
      expect(convo(id).status).toBe('active');
      expect(convo(id).max_turns).toBe(DEEP);

      addMessage(id, a, 'I had to tell you tonight.', 0.2, [], Date.now());
      await conversationsTick();
      expect(convo(id).status).toBe('active');

      addMessage(id, b, 'Then tell me.', 0.1, [], Date.now());
      await conversationsTick();
      expect(convo(id).status).toBe('ended');
      expect(lines(id).map((m) => m.speakerId)).toEqual([a, b, a]);
      expectReleased();
    });
  });
});
