import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';

// The LLM path must not actually run: accept every dispatch and do nothing, so
// the conversation rows Step E creates stay `active` for the assertions.
vi.mock('../../../ai/taskRunner', () => ({
  taskRunner: { startConversation: vi.fn(() => true) },
}));
// Pass-through, so a test can make one completion throw halfway.
vi.mock('../../../lib/conversationEvaluator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/conversationEvaluator')>();
  return { ...actual, evaluateConversation: vi.fn(actual.evaluateConversation) };
});

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
import { evaluateConversation } from '../../../lib/conversationEvaluator';
import { conversationsTick } from '../conversations';
import { nudgeRouter } from '../../../routers/nudge';
import { CONFIG } from '../../../lib/constants';
import { gameMinutes } from '../../../lib/gameClock';

/**
 * Playtest regression: one agent in two conversations at once. The queue held
 * both [Sofia,Omar] and [Omar,Sofia] (each had decided to socialize with the
 * other in the same decisions pass), and Diego was queued with two partners;
 * `conversationsTick` turned every entry into a conversation independently.
 */

const TAG = 'claimtest';

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

function resetScheduler(): void {
  const existing = db.select().from(conversationSchedulerState).get();
  if (existing) {
    db.update(conversationSchedulerState)
      .set({ active_llm_conversations: [], max_concurrent_llm: 2 })
      .where(eq(conversationSchedulerState.id, existing.id))
      .run();
    return;
  }
  db.insert(conversationSchedulerState).values({
    active_llm_conversations: [],
    max_concurrent_llm: 2,
    max_queue_size: 10,
    max_turns_deep: 6,
    max_turns_standard: 4,
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
    // All standing together, so proximity/staging never gets in the way.
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
  {
    priority = 50,
    queuedAt = Date.now(),
    topic = null,
    trigger = TAG,
  }: { priority?: number; queuedAt?: number; topic?: string | null; trigger?: string } = {},
): number {
  return db.insert(conversationQueue).values({
    participants,
    tier,
    priority,
    trigger_reason: trigger,
    topic,
    queued_at: queuedAt,
    max_wait: 10000,
  }).returning({ id: conversationQueue.id }).get().id;
}

/**
 * A live LLM conversation: an `active` row the scheduler tracks, with both
 * agents `talking` in it. `tracked: false` leaves it out of the scheduler, which
 * is what an orphan looks like.
 */
function startLive(
  participants: number[],
  { tracked = true, startedAt = Date.now(), turns = 0 }: { tracked?: boolean; startedAt?: number; turns?: number } = {},
): number {
  const id = db.insert(conversations).values({
    participants,
    messages: Array.from({ length: turns }, (_, i) => ({
      speakerId: participants[i % 2], text: `line ${i}`, sentiment: 0.1, topics: [], timestamp: i,
    })),
    trigger_reason: `${TAG} live`,
    topic: null,
    status: 'active',
    started_at: startedAt,
    ended_at: null,
    sentiment: 0,
    max_turns: 4,
  }).returning({ id: conversations.id }).get().id;
  db.update(agents).set({ current_action: { type: 'talking', conversationId: id } })
    .where(inArray(agents.id, participants)).run();
  if (tracked) {
    const sched = db.select().from(conversationSchedulerState).get()!;
    db.update(conversationSchedulerState)
      .set({ active_llm_conversations: [...(sched.active_llm_conversations as any[]), { conversationId: id, startedAt }] })
      .where(eq(conversationSchedulerState.id, sched.id))
      .run();
  }
  return id;
}

function startedConversations() {
  return db.select().from(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).all();
}

describe('conversationsTick — one conversation per agent', () => {
  let locId = 0;
  let a = 0, b = 0, c = 0, d = 0;
  let ids: number[] = [];

  let savedWorld: { time: any; tick_speed: number } | null = null;

  beforeAll(() => {
    ensureWorld();
    // Mid-morning at 1x: the shared worker DB may hold any clock, and at night
    // every live conversation would be wound up for bedtime (Step A's needs
    // interrupt), which is not what these tests are about.
    const w = db.select().from(worldState).get()!;
    savedWorld = { time: w.time, tick_speed: w.tick_speed };
    db.update(worldState)
      .set({ time: { ...w.time, hour: 9, minute: 0 }, tick_speed: 1 })
      .where(eq(worldState.id, w.id)).run();
    locId = db.insert(locations).values({
      name: 'Claim Square',
      type: 'town_square',
      position: { x: 0, y: 0, width: 10, height: 10 },
      entry_point: { x: 0, y: 0 },
      capacity: 10,
      current_occupants: [],
      services: [],
      description: 'test',
    }).returning({ id: locations.id }).get().id;
    a = insertAgent('Sofia', locId);
    b = insertAgent('Omar', locId);
    c = insertAgent('Diego', locId);
    d = insertAgent('Lena', locId);
    ids = [a, b, c, d];
    for (const agent_id of ids) {
      db.insert(needs).values({
        agent_id,
        hunger: 60, energy: 60, social: 40, comfort: 50, fun: 40, mood: 55, stress: 20,
        decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
        thresholds: { critical: 10, low: 30, satisfied: 70 },
        mood_modifiers: [],
        last_updated: 0,
      }).run();
    }
  });

  afterAll(() => {
    if (savedWorld) db.update(worldState).set(savedWorld).run();
    resetScheduler();
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
    vi.mocked(taskRunner.startConversation).mockClear();
    db.delete(conversationQueue).run();
    db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
    // Template cooldowns would otherwise leak between cases.
    db.delete(templateUsage).where(inArray(templateUsage.agent_a, ids)).run();
    db.update(agents).set({ current_action: { type: 'idle' } }).where(inArray(agents.id, ids)).run();
    resetScheduler();
  });

  it('turns a symmetric template pair queued twice into one conversation', async () => {
    enqueue([a, b], 'template');
    enqueue([b, a], 'template');

    await conversationsTick();

    expect(startedConversations()).toHaveLength(1);
    // The duplicate is dropped, not left to fire on a later tick.
    expect(db.select().from(conversationQueue).all()).toHaveLength(0);
  });

  it('turns a symmetric LLM pair queued twice into one conversation', async () => {
    enqueue([a, b], 'llm_standard');
    enqueue([b, a], 'llm_standard');

    await conversationsTick();

    expect(startedConversations()).toHaveLength(1);
    expect(taskRunner.startConversation).toHaveBeenCalledTimes(1);
    expect(db.select().from(conversationQueue).all()).toHaveLength(0);
  });

  it('never puts one agent into two conversations started in the same pass', async () => {
    enqueue([c, a], 'llm_standard', { priority: 90 });
    enqueue([c, b], 'llm_standard', { priority: 80 });
    enqueue([c, d], 'template', { priority: 70 });

    await conversationsTick();

    const started = startedConversations();
    expect(started).toHaveLength(1);
    // Highest priority wins, whatever its tier.
    expect(started[0].participants).toEqual([c, a]);
    // The losers wait their turn rather than being thrown away.
    expect(db.select().from(conversationQueue).all()).toHaveLength(2);
  });

  it('does not let a lower-priority template take an agent a higher-priority LLM entry needs', async () => {
    enqueue([c, d], 'template', { priority: 10 });
    enqueue([c, a], 'llm_deep', { priority: 90 });

    await conversationsTick();

    expect(startedConversations().map((x) => x.participants)).toEqual([[c, a]]);
    expect(taskRunner.startConversation).toHaveBeenCalledTimes(1);
    expect(db.select().from(conversationQueue).all().map((q) => q.participants)).toEqual([[c, d]]);
  });

  it('holds both agents of a higher-priority LLM entry that is still walking over', async () => {
    // Omar is 60px away: the LLM entry stages (Sofia walks over) instead of opening.
    db.update(agents).set({ position: { x: 160, y: 100 } }).where(eq(agents.id, b)).run();
    try {
      enqueue([a, b], 'llm_standard', { priority: 90 });
      enqueue([b, c], 'template', { priority: 10 });

      await conversationsTick();

      expect(startedConversations()).toHaveLength(0);
      expect(db.select().from(conversationQueue).all()).toHaveLength(2);
      const sofia = db.select().from(agents).where(eq(agents.id, a)).get()!;
      expect(sofia.current_action).toMatchObject({ type: 'walking', reason: 'approaching_conversation' });
    } finally {
      db.update(agents).set({ position: { x: 100, y: 100 }, current_destination: null })
        .where(eq(agents.id, b)).run();
    }
  });

  it('still runs lower-priority templates once the LLM slots are full', async () => {
    const sched = db.select().from(conversationSchedulerState).get()!;
    db.update(conversationSchedulerState).set({ max_concurrent_llm: 0 })
      .where(eq(conversationSchedulerState.id, sched.id)).run();
    enqueue([a, b], 'llm_standard', { priority: 90 });
    enqueue([c, d], 'template', { priority: 10 });

    await conversationsTick();

    expect(startedConversations().map((x) => x.participants)).toEqual([[c, d]]);
  });

  it('keeps a same-pair template waiting behind a higher-priority LLM entry when slots are full', async () => {
    const sched = db.select().from(conversationSchedulerState).get()!;
    db.update(conversationSchedulerState).set({ max_concurrent_llm: 0 })
      .where(eq(conversationSchedulerState.id, sched.id)).run();
    enqueue([a, b], 'llm_deep', { priority: 90 });
    enqueue([b, a], 'template', { priority: 10 });

    await conversationsTick();

    expect(startedConversations()).toHaveLength(0);
    expect(db.select().from(conversationQueue).all()).toHaveLength(2);
  });

  it('does not let a timed-out pair that walked apart claim an agent', async () => {
    // Omar left the square and walked off.
    db.update(agents).set({ position: { x: 400, y: 400 }, current_location: null }).where(eq(agents.id, b)).run();
    try {
      enqueue([a, b], 'template', { priority: 90, queuedAt: Date.now() - 60_000 });
      enqueue([a, c], 'template', { priority: 10 });

      await conversationsTick();

      expect(startedConversations().map((x) => x.participants)).toEqual([[a, c]]);
    } finally {
      db.update(agents).set({ position: { x: 100, y: 100 }, current_location: locId }).where(eq(agents.id, b)).run();
    }
  });

  it('keeps an entry queued while a participant is in a live conversation', async () => {
    startLive([a, d]);
    enqueue([a, b], 'template');
    enqueue([a, c], 'llm_standard');

    await conversationsTick();

    expect(startedConversations().map((x) => x.participants)).toEqual([[a, d]]);
    expect(taskRunner.startConversation).not.toHaveBeenCalled();
    expect(db.select().from(conversationQueue).all()).toHaveLength(2);
  });

  it('drops a timed-out entry whose participant is busy instead of templating it', async () => {
    startLive([a, d]);
    enqueue([a, b], 'llm_standard', { queuedAt: Date.now() - 60_000 });

    await conversationsTick();

    expect(startedConversations().map((x) => x.participants)).toEqual([[a, d]]);
    expect(db.select().from(conversationQueue).all()).toHaveLength(0);
  });

  it('sweeps an orphaned active row and frees its participants', async () => {
    // Untracked by the scheduler and older than any conversation may run: the
    // leftover of a completion that crashed. It used to lock Sofia and Lena out.
    const orphan = startLive([a, d], { tracked: false, startedAt: Date.now() - 10_000_000 });
    enqueue([a, b], 'llm_standard');

    await conversationsTick();

    const row = db.select().from(conversations).where(eq(conversations.id, orphan)).get()!;
    expect(row.status).toBe('ended');
    const lena = db.select().from(agents).where(eq(agents.id, d)).get()!;
    expect(lena.current_action).toEqual({ type: 'idle' });
    // ...and Sofia is free to talk again this very tick.
    expect(startedConversations().filter((x) => x.status === 'active').map((x) => x.participants))
      .toEqual([[a, b]]);
  });

  it('does not sweep a recent row, nor treat an untracked one as busy', async () => {
    const fresh = startLive([a, d], { tracked: false });
    enqueue([a, b], 'llm_standard');

    await conversationsTick();

    expect(db.select().from(conversations).where(eq(conversations.id, fresh)).get()!.status).toBe('active');
    expect(taskRunner.startConversation).toHaveBeenCalledTimes(1);
  });

  it('ends the row and frees the agents even when completion throws', async () => {
    const id = startLive([a, b], { turns: 4 });
    vi.mocked(evaluateConversation).mockImplementationOnce(() => { throw new Error('boom'); });

    await conversationsTick();

    expect(db.select().from(conversations).where(eq(conversations.id, id)).get()!.status).toBe('ended');
    for (const agent of db.select().from(agents).where(inArray(agents.id, [a, b])).all()) {
      expect(agent.current_action).toEqual({ type: 'idle' });
    }
  });

  describe('player nudges and comfort visits', () => {
    const NUDGE = CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY;

    it('waits for the blocking conversation instead of dropping a timed-out nudge', async () => {
      const startedAt = Date.now();
      startLive([a, d], { startedAt });
      const queuedAt = Date.now() - 60_000;
      const id = enqueue([a, b], 'llm_deep', { priority: NUDGE, queuedAt, topic: 'confrontation' });

      await conversationsTick();

      const entry = db.select().from(conversationQueue).where(eq(conversationQueue.id, id)).get();
      expect(entry).toBeDefined();
      // Bounded, in game minutes: until the blocker must be over — its budget
      // (4 turns × allowance) plus the wrap-up grace — plus the margin.
      const { GAME_MINUTES_PER_TURN, WRAP_UP_GRACE_GAME_MINUTES, PROTECTED_WAIT_MARGIN_GAME_MINUTES } = CONFIG.CONVERSATIONS;
      expect(entry!.deadline_game_min).toBe(
        gameMinutes(db.select().from(worldState).get()!.time)
          + 4 * GAME_MINUTES_PER_TURN + WRAP_UP_GRACE_GAME_MINUTES + PROTECTED_WAIT_MARGIN_GAME_MINUTES,
      );
      expect(startedConversations().map((x) => x.participants)).toEqual([[a, d]]);
    });

    it('treats a comfort visit as protected too', async () => {
      startLive([a, d]);
      const id = enqueue([a, b], 'llm_standard', { queuedAt: Date.now() - 60_000, trigger: 'comfort_visit' });

      await conversationsTick();

      expect(db.select().from(conversationQueue).where(eq(conversationQueue.id, id)).get()).toBeDefined();
    });

    it('keeps a nudge with a new topic for a pair that is already talking', async () => {
      startLive([a, b]);
      const id = enqueue([a, b], 'llm_deep', { priority: NUDGE, topic: 'revealing: the affair' });

      await conversationsTick();

      expect(db.select().from(conversationQueue).where(eq(conversationQueue.id, id)).get()).toBeDefined();
    });

    it('still drops a true duplicate of the live conversation', async () => {
      startLive([a, b]);
      const id = enqueue([a, b], 'llm_deep', { priority: NUDGE, topic: null });

      await conversationsTick();

      expect(db.select().from(conversationQueue).where(eq(conversationQueue.id, id)).get()).toBeUndefined();
    });

    it('nudge router reports "busy talking — queued" and leaves the talker in their conversation', async () => {
      const liveId = startLive([a, d]);
      const caller = nudgeRouter.createCaller({} as any);

      const res = await caller.execute({ action: { type: 'force_confront', agentA: a, agentB: b } });

      expect(res).toMatchObject({ success: true, queued: true, message: 'Sofia is busy talking — queued' });
      const sofia = db.select().from(agents).where(eq(agents.id, a)).get()!;
      expect(sofia.current_action).toEqual({ type: 'talking', conversationId: liveId });
      expect(db.select().from(conversationQueue).all().map((q) => q.participants)).toEqual([[a, b]]);
      db.update(agents).set({ action_queue: [], current_destination: null }).where(inArray(agents.id, ids)).run();
    });
  });
});
