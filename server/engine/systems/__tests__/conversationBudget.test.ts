import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';

// No LLM: the harness below plays the task runner, landing turns on a
// simulated real-time schedule through the same addMessage the runner uses.
vi.mock('../../../ai/taskRunner', () => ({
  taskRunner: { startConversation: vi.fn(() => true) },
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
  affordableTurns,
  averageTurnLatencyMs,
  conversationBudgetGameMinutes,
  isPastBedtime,
  needsWrapUpReason,
  recordTurnLatency,
  resetTurnLatency,
} from '../../../lib/conversationPacing';
import { conversationsTick } from '../conversations';

/**
 * G1 (playtest #2): at 4x, LLM conversations ate whole nights. The budget was
 * wall-clock (15 s × 10 turns), and an LLM turn takes 20–60 real seconds at any
 * speed — so a conversation could run ten GAME hours, and Rosa and Yuki talked
 * from 21:00 to 05:00 without sleeping. Budgets are game minutes now, the turn
 * count is sized to the observed latency at the current speed, and needs can
 * end a conversation.
 */

const TAG = 'budgettest';
const { GAME_MINUTES_PER_TURN, WRAP_UP_GRACE_GAME_MINUTES: GRACE, MIN_LLM_TURNS } = CONFIG.CONVERSATIONS;
const DEEP = 10;
const STANDARD = 6;

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

function enqueue(participants: number[], tier: string, priority = 50): void {
  db.insert(conversationQueue).values({
    participants,
    tier,
    priority,
    trigger_reason: TAG,
    topic: null,
    queued_at: Date.now(),
    max_wait: 600_000,
  }).run();
}

function taggedConversations() {
  return db.select().from(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).all();
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
  enqueue(participants, tier, priority);
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

describe('conversation pacing — pure helpers', () => {
  it('derives budgets from the tier turn count', () => {
    expect(conversationBudgetGameMinutes(STANDARD)).toBe(STANDARD * GAME_MINUTES_PER_TURN);
    expect(conversationBudgetGameMinutes(DEEP)).toBe(DEEP * GAME_MINUTES_PER_TURN);
  });

  it('scales affordable turns down with speed and latency', () => {
    // 5 s turns: 5 game min at 1x, 20 at 4x.
    expect(affordableTurns(54, 5000, 1)).toBe(10);
    expect(affordableTurns(54, 5000, 4)).toBe(2);
    expect(affordableTurns(54, 20_000, 4)).toBe(0);
    // No evidence yet → no cap.
    expect(affordableTurns(54, null, 4)).toBe(Infinity);
  });

  it('keeps a bounded rolling window of turn latency', () => {
    resetTurnLatency();
    expect(averageTurnLatencyMs()).toBeNull();
    for (let i = 0; i < CONFIG.CONVERSATIONS.TURN_LATENCY_WINDOW; i++) recordTurnLatency(1000);
    for (let i = 0; i < CONFIG.CONVERSATIONS.TURN_LATENCY_WINDOW; i++) recordTurnLatency(3000);
    expect(averageTurnLatencyMs()).toBe(3000);
    resetTurnLatency();
  });

  it('forgets stale latency, so a slow spell cannot pin the town on templates', () => {
    resetTurnLatency();
    recordTurnLatency(20_000, 1_000_000);
    expect(averageTurnLatencyMs(1_000_000 + CONFIG.CONVERSATIONS.TURN_LATENCY_MAX_AGE_MS)).toBe(20_000);
    expect(averageTurnLatencyMs(1_000_001 + CONFIG.CONVERSATIONS.TURN_LATENCY_MAX_AGE_MS)).toBeNull();
  });

  it('matches decisions.ts sleep windows', () => {
    const sched = { wakeTime: 6, sleepTime: 22 };
    expect(isPastBedtime(sched, null, 21)).toBe(false);
    expect(isPastBedtime(sched, null, 22)).toBe(true);
    expect(isPastBedtime(sched, null, 3)).toBe(true);
    expect(isPastBedtime(sched, null, 6)).toBe(false);
    // Night owl: +2 h (impulsiveness 100 → +1, sensuality 100 → +0.5, morality 0 → +0.75 → round 2).
    const owl = { impulsiveness: 100, sensuality: 100, morality: 0, neuroticism: 0 };
    expect(isPastBedtime(sched, owl, 23)).toBe(false);
    expect(isPastBedtime(sched, owl, 0)).toBe(true);
  });

  it('ranks the needs that end a conversation', () => {
    expect(needsWrapUpReason({ hunger: 50, energy: 50, critical: 15 }, false)).toBeNull();
    expect(needsWrapUpReason({ hunger: 5, energy: 5, critical: 15 }, true)).toBe('energy');
    expect(needsWrapUpReason({ hunger: 5, energy: 50, critical: 15 }, true)).toBe('sleep');
    expect(needsWrapUpReason({ hunger: 5, energy: 50, critical: 15 }, false)).toBe('hunger');
  });
});

describe('conversationsTick — game-time conversation budget (G1)', () => {
  let locId = 0;
  let a = 0, b = 0;
  let savedWorld: { time: any; tick_speed: number } | null = null;
  let savedTurns: { max_turns_deep: number; max_turns_standard: number } | null = null;

  beforeAll(() => {
    ensureWorld();
    const w = world();
    savedWorld = { time: w.time, tick_speed: w.tick_speed };
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
    resetTurnLatency();
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
    resetTurnLatency();
    resetScheduler();
    db.delete(conversationQueue).run();
    db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
    // 09:00 on a fresh day, well before anyone's bedtime.
    setClock(3 * 1440 + 9 * 60, 1);
    db.update(needs).set({ hunger: 60, energy: 60 }).where(inArray(needs.agent_id, [a, b])).run();
    db.update(agents).set({ current_action: { type: 'idle' } }).where(inArray(agents.id, [a, b])).run();
    vi.mocked(taskRunner.startConversation).mockClear();
  });

  function expectReleased(): void {
    for (const agent of db.select().from(agents).where(inArray(agents.id, [a, b])).all()) {
      expect(agent.current_action).toEqual({ type: 'idle' });
    }
  }

  describe('at 1x with fast turns, nothing changes', () => {
    it.each([
      ['llm_standard', STANDARD],
      ['llm_deep', DEEP],
    ])('%s runs its full %i turns and ends naturally', async (tier, turns) => {
      for (let i = 0; i < 4; i++) recordTurnLatency(5000);
      const { row, landed, elapsedGameMin } = await simulate([a, b], { speed: 1, turnSec: 5, tier });

      expect(landed).toBe(turns);
      expect(row.max_turns).toBe(turns);
      expect(row.messages).toHaveLength(turns); // no farewell appended
      expect(row.quality_breakdown).not.toHaveProperty('truncated');
      expect(elapsedGameMin).toBeLessThanOrEqual(conversationBudgetGameMinutes(turns));
      expectReleased();
    });

    it('keeps the tier length before any latency has been observed', async () => {
      const { row, landed } = await simulate([a, b], { speed: 4, turnSec: 1, tier: 'llm_deep' });
      expect(landed).toBe(DEEP);
      expect(row.messages).toHaveLength(DEEP);
    });
  });

  describe('at 4x with slow turns', () => {
    it('sizes the conversation to the latency and ends it inside the game-minute budget', async () => {
      // Observed 5 s turns → 20 game min each at 4x → 4 of the deep budget's 90.
      for (let i = 0; i < 4; i++) recordTurnLatency(5000);
      // ...but the model has slowed to 12 s (48 game min) a turn.
      const { row, landed, elapsedGameMin } = await simulate([a, b], { speed: 4, turnSec: 12, tier: 'llm_deep' });

      const budget = conversationBudgetGameMinutes(DEEP);
      // The old wall-clock budget (10 turns × 15 s = 150 s) allowed 600 game min.
      expect(elapsedGameMin).toBeLessThanOrEqual(budget + GRACE);
      expect(landed).toBe(2); // the in-flight second turn landed within the grace
      const msgs = row.messages as Array<{ speakerId: number; text: string }>;
      expect(msgs).toHaveLength(3);
      // Closed by the one whose turn it was, with a clock-flavoured goodbye.
      expect(msgs[2].speakerId).toBe(a);
      const budgetLines = WRAP_UP_FAREWELLS.budget.map((l) => l.text.replace('{other.name}', 'Yuki'));
      expect(budgetLines).toContain(msgs[2].text);
      // 2 of 4 planned turns: the clock really did cut it.
      expect(row.quality_breakdown?.truncated).toBe(1);
      expectReleased();
    });

    it('closes a hung conversation at budget + grace without inventing a goodbye', async () => {
      for (let i = 0; i < 4; i++) recordTurnLatency(5000);
      const { row, elapsedGameMin } = await simulate([a, b], { speed: 4, turnSec: null, tier: 'llm_standard' });

      const budget = conversationBudgetGameMinutes(STANDARD);
      expect(elapsedGameMin).toBeGreaterThanOrEqual(budget + GRACE);
      expect(elapsedGameMin).toBeLessThan(budget + GRACE + 4); // the first tick past it
      expect(row.messages).toEqual([]);
      expectReleased();
    });

    it('has a conversation that cannot fit one exchange on the template tier', async () => {
      // 20 s turns at 4x = 80 game min each; the standard budget is 54.
      for (let i = 0; i < 4; i++) recordTurnLatency(20_000);
      setClock(nowGameMin(), 4);
      enqueue([a, b], 'llm_standard');

      await conversationsTick();

      expect(taskRunner.startConversation).not.toHaveBeenCalled();
      const rows = taggedConversations();
      expect(rows).toHaveLength(1);
      expect(rows[0].trigger_reason).toBe(`${TAG} (template)`);
      expect(rows[0].status).toBe('ended');
      expectReleased();
    });

    it('still gives a player nudge the model, at the minimum length', async () => {
      for (let i = 0; i < 4; i++) recordTurnLatency(20_000);
      setClock(nowGameMin(), 4);
      enqueue([a, b], 'llm_deep', CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY);

      await conversationsTick();

      expect(taskRunner.startConversation).toHaveBeenCalledTimes(1);
      const row = taggedConversations().find((c) => c.status === 'active')!;
      expect(row.max_turns).toBe(MIN_LLM_TURNS);
      // Bounded like every other conversation.
      const entry = (db.select().from(conversationSchedulerState).get()!.active_llm_conversations as any[])
        .find((e) => e.conversationId === row.id);
      expect(entry).toMatchObject({ budgetGameMin: conversationBudgetGameMinutes(DEEP), plannedTurns: MIN_LLM_TURNS });
    });
  });

  describe('needs interrupt', () => {
    /** An LLM conversation two lines in, opened `agoGameMin` game minutes ago. */
    async function liveConversation(agoGameMin = 10): Promise<number> {
      setClock(nowGameMin(), 1);
      enqueue([a, b], 'llm_deep');
      await conversationsTick();
      const row = taggedConversations().find((c) => c.status === 'active')!;
      addMessage(row.id, a, 'How was the harvest?', 0.3, [], Date.now());
      addMessage(row.id, b, 'Better than last year, thankfully.', 0.4, [], Date.now());
      setClock(nowGameMin() + agoGameMin);
      return row.id;
    }

    function convo(id: number) {
      return db.select().from(conversations).where(eq(conversations.id, id)).get()!;
    }

    it('lets the in-flight turn land, then the exhausted one says goodnight', async () => {
      const id = await liveConversation();
      db.update(needs).set({ energy: 5 }).where(eq(needs.agent_id, b)).run();

      await conversationsTick();
      // Wound up, not ended: exactly the turn in flight may still land.
      expect(convo(id).status).toBe('active');
      expect(convo(id).max_turns).toBe(3);

      expect(addMessage(id, a, 'Glad to hear it.', 0.3, [], Date.now())).toEqual({ messageCount: 3, maxTurns: 3 });
      setClock(nowGameMin() + 1);
      await conversationsTick();

      const row = convo(id);
      expect(row.status).toBe('ended');
      const msgs = row.messages as Array<{ speakerId: number; text: string }>;
      expect(msgs).toHaveLength(4);
      expect(msgs[3].speakerId).toBe(b);
      expect(WRAP_UP_FAREWELLS.energy.map((l) => l.text.replace('{other.name}', 'Rosa'))).toContain(msgs[3].text);
      // Someone chose to leave: not a cut-short conversation.
      expect(row.quality_breakdown).not.toHaveProperty('truncated');
      expectReleased();
    });

    it('ends at bedtime once the grace passes, even if the reply never comes', async () => {
      setClock(3 * 1440 + 21 * 60 + 55);
      const id = await liveConversation(); // now 22:05 — past the 22:00 bedtime

      await conversationsTick();
      expect(convo(id).status).toBe('active');
      setClock(nowGameMin() + GRACE);
      await conversationsTick();

      const row = convo(id);
      expect(row.status).toBe('ended');
      const msgs = row.messages as Array<{ speakerId: number; text: string }>;
      expect(msgs).toHaveLength(3);
      expect(WRAP_UP_FAREWELLS.sleep.map((l) => l.text.replace('{other.name}', 'Yuki'))).toContain(msgs[2].text);
      expect(row.quality_breakdown).not.toHaveProperty('truncated');
      // A late reply can't land after the goodbye.
      expect(addMessage(id, a, 'Wait—', 0, [], Date.now())).toBeNull();
      expectReleased();
    });

    it('ends for critical hunger', async () => {
      const id = await liveConversation();
      db.update(needs).set({ hunger: 3 }).where(eq(needs.agent_id, a)).run();

      await conversationsTick();
      setClock(nowGameMin() + GRACE);
      await conversationsTick();

      const msgs = convo(id).messages as Array<{ speakerId: number; text: string }>;
      expect(convo(id).status).toBe('ended');
      expect(msgs[msgs.length - 1].speakerId).toBe(a);
      expect(WRAP_UP_FAREWELLS.hunger.map((l) => l.text.replace('{other.name}', 'Yuki')))
        .toContain(msgs[msgs.length - 1].text);
      expectReleased();
    });
  });
});
