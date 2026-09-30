import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';

/**
 * End to end through the REAL task runner and generateResponse, with only the
 * model mocked: a fake-timer "LLM" that answers after a fixed real-time latency
 * (or never, until cancelled). One loop iteration = one real second = one tick,
 * advancing the game clock `tick_speed` minutes — the production cadence.
 *
 * Pins the review findings on G1: a player-requested conversation at 4x on a
 * slow model must actually get both lines out, and a conversation closed while
 * its turn is still running must hand its runner slot back.
 */

vi.mock('../../../ai/ollama', () => ({ callOllamaChat: vi.fn() }));
vi.mock('../../../ai/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../ai/prompts')>()),
  buildConversationPrompt: () => ({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] }),
}));
// Real addMessage / markConversationEnded / caches; only the context builder
// (memory retrieval, embeddings) is replaced by a plain DB read.
vi.mock('../../../helpers/conversationHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../helpers/conversationHelpers')>();
  return {
    ...actual,
    getConversationContext: vi.fn(async (conversationId: number, speakerId: number) => {
      const { db } = await import('../../../db');
      const schema = await import('../../../db/schema');
      const { eq } = await import('drizzle-orm');
      const conversation = db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).get();
      if (!conversation) return null;
      const otherId = (conversation.participants as number[]).find((p) => p !== speakerId)!;
      const speaker = db.select().from(schema.agents).where(eq(schema.agents.id, speakerId)).get();
      const otherAgent = db.select().from(schema.agents).where(eq(schema.agents.id, otherId)).get();
      const world = db.select().from(schema.worldState).get();
      return { conversation, speaker, otherAgent, world, memories: [], townNames: [] } as never;
    }),
  };
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
import { callOllamaChat } from '../../../ai/ollama';
import { LLMAbortedError } from '../../../ai/llmErrors';
import { taskRunner } from '../../../ai/taskRunner';
import { CONFIG } from '../../../lib/constants';
import { gameMinutes } from '../../../lib/gameClock';
import { recordTurnLatency, resetConversationPacing, turnLatencyEstimateMs } from '../../../lib/conversationPacing';
import { conversationsTick } from '../conversations';

const TAG = 'runnertest';

function world() {
  return db.select().from(worldState).get()!;
}
function nowGameMin(): number {
  return gameMinutes(world().time);
}
function setClock(totalMinutes: number, tickSpeed?: number): void {
  const w = world();
  db.update(worldState)
    .set({
      time: {
        ...w.time,
        day: Math.floor(totalMinutes / 1440),
        hour: Math.floor((totalMinutes % 1440) / 60),
        minute: totalMinutes % 60,
      },
      ...(tickSpeed != null ? { tick_speed: tickSpeed } : {}),
    })
    .where(eq(worldState.id, w.id))
    .run();
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

/** The model: answers after `latencyMs` of (fake) real time, or never; honours abort. */
function modelWithLatency(latencyMs: number | null): void {
  let n = 0;
  vi.mocked(callOllamaChat).mockImplementation((req) => new Promise((resolve, reject) => {
    const line = `This is line number ${++n}, and I mean every word of it.`;
    const timer = latencyMs == null ? null : setTimeout(() => resolve({ text: line }), latencyMs);
    req.signal?.addEventListener('abort', () => {
      if (timer) clearTimeout(timer);
      reject(new LLMAbortedError());
    }, { once: true });
  }));
}

/** One production tick: a real second passes, then the clock and the phase run. */
async function tick(speed: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(1000);
  setClock(nowGameMin() + speed);
  await conversationsTick();
}

describe('conversations through the real task runner (G1 review)', () => {
  let locId = 0;
  let a = 0, b = 0;
  let saved: { time: any; tick_speed: number } | null = null;

  beforeAll(() => {
    if (!db.select().from(worldState).get()) {
      db.insert(worldState).values({
        time: { day: 1, hour: 9, minute: 0, totalTicks: 540, seasonDay: 1, season: 'spring' },
        day_phase: 'morning', weather: 'sunny', weather_duration: 120, tick_speed: 1, is_paused: true,
        last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test', pending_transitions: [], tax_pool: 0,
        map_width: 40, map_height: 30, collision_grid: '',
      }).run();
    }
    const w = world();
    saved = { time: w.time, tick_speed: w.tick_speed };
    locId = db.insert(locations).values({
      name: 'Runner Square', type: 'town_square', position: { x: 0, y: 0, width: 10, height: 10 },
      entry_point: { x: 0, y: 0 }, capacity: 10, current_occupants: [], services: [], description: 'test',
    }).returning({ id: locations.id }).get().id;
    a = insertAgent('Rosa', locId);
    b = insertAgent('Yuki', locId);
    for (const agent_id of [a, b]) {
      db.insert(needs).values({
        agent_id, hunger: 60, energy: 60, social: 40, comfort: 50, fun: 40, mood: 55, stress: 20,
        decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
        thresholds: { critical: 15, low: 35, satisfied: 70 }, mood_modifiers: [], last_updated: 0,
      }).run();
    }
  });

  afterAll(() => {
    if (saved) db.update(worldState).set(saved).run();
    const ids = [a, b];
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    db.run(sql`DELETE FROM activity_log
               WHERE initiator_id IN (${idList}) OR target_id IN (${idList})
                  OR EXISTS (SELECT 1 FROM json_each(activity_log.agent_ids) WHERE value IN (${idList}))`);
    db.update(conversationSchedulerState).set({ active_llm_conversations: [] }).run();
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    resetConversationPacing();
    taskRunner.resetSlots();
    vi.mocked(callOllamaChat).mockClear();
    const sched = db.select().from(conversationSchedulerState).get();
    const values = { active_llm_conversations: [], max_concurrent_llm: 2, max_turns_deep: 10, max_turns_standard: 6 };
    if (sched) {
      db.update(conversationSchedulerState).set(values).where(eq(conversationSchedulerState.id, sched.id)).run();
    } else {
      db.insert(conversationSchedulerState).values({
        ...values, max_queue_size: 10, template_fallback_after_ms: 10000,
        stats: { llmConversationsTotal: 0, templateConversationsTotal: 0, averageResponseTimeMs: 0, queueTimeoutsTotal: 0 },
      }).run();
    }
    db.delete(conversationQueue).run();
    db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
    db.update(agents).set({ current_action: { type: 'idle' } }).where(inArray(agents.id, [a, b])).run();
    setClock(3 * 1440 + 9 * 60, 4);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function enqueue(tier: string, priority: number): void {
    db.insert(conversationQueue).values({
      participants: [a, b], tier, priority, trigger_reason: TAG, topic: null,
      queued_at: Date.now(), max_wait: 600_000,
    }).run();
  }

  function active() {
    return db.select().from(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).all();
  }

  it('a player nudge at 4x on a 20 s model gets both of its lines out', async () => {
    for (let i = 0; i < 4; i++) recordTurnLatency(20_000, nowGameMin());
    modelWithLatency(20_000);
    // Standard tier (comfort visits, autoplay): its own budget is 90 game min,
    // less than the ~161 the second line needs at 80 a turn. Without the
    // stretched budget and one-turn grace the reply was lost every time.
    enqueue('llm_standard', CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY);

    await conversationsTick();
    const id = active().find((c) => c.status === 'active')!.id;
    const start = nowGameMin();
    for (let i = 0; i < 120 && active().find((c) => c.id === id)!.status === 'active'; i++) await tick(4);

    const row = active().find((c) => c.id === id)!;
    expect(row.status).toBe('ended');
    const msgs = row.messages as Array<{ speakerId: number; fallback?: boolean }>;
    expect(msgs.map((m) => m.speakerId)).toEqual([a, b]);
    expect(msgs.every((m) => m.fallback === false)).toBe(true);
    expect(row.quality_breakdown).not.toHaveProperty('truncated');
    // Stretched budget (2 × 80) plus at most one tick.
    expect(nowGameMin() - start).toBeLessThanOrEqual(160 + 80);
    // The model's real latency was measured from inside generateResponse.
    expect(turnLatencyEstimateMs(nowGameMin())).toBe(20_000);
    expect(taskRunner.activeConversations).toBe(0);
  });

  it('closing a conversation cancels its hung turn and frees the runner slot', async () => {
    for (let i = 0; i < 4; i++) recordTurnLatency(5000, nowGameMin());
    modelWithLatency(null); // never answers
    enqueue('llm_standard', 50);

    await conversationsTick();
    expect(taskRunner.activeConversations).toBe(1);
    const id = active().find((c) => c.status === 'active')!.id;
    for (let i = 0; i < 60 && active().find((c) => c.id === id)!.status === 'active'; i++) await tick(4);
    expect(active().find((c) => c.id === id)!.status).toBe('ended');

    // The abort unwinds on the next microtasks — no model reply needed.
    await vi.advanceTimersByTimeAsync(0);
    expect(taskRunner.activeConversations).toBe(0);
    expect(taskRunner.freeConversationSlots).toBe(4);
    // Cancelled, not failed: no retry attempts and no fallback line.
    expect(vi.mocked(callOllamaChat)).toHaveBeenCalledTimes(1);
    expect(active().find((c) => c.id === id)!.messages).toEqual([]);
  });
});
