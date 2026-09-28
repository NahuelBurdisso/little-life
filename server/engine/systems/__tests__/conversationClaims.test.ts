import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';

// The LLM path must not actually run: accept every dispatch and do nothing, so
// the conversation rows Step E creates stay `active` for the assertions.
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
import { conversationsTick } from '../conversations';

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
  { priority = 50, queuedAt = Date.now() }: { priority?: number; queuedAt?: number } = {},
): number {
  return db.insert(conversationQueue).values({
    participants,
    tier,
    priority,
    trigger_reason: TAG,
    topic: null,
    queued_at: queuedAt,
    max_wait: 10000,
  }).returning({ id: conversationQueue.id }).get().id;
}

function startedConversations() {
  return db.select().from(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).all();
}

describe('conversationsTick — one conversation per agent', () => {
  let locId = 0;
  let a = 0, b = 0, c = 0, d = 0;
  let ids: number[] = [];

  beforeAll(() => {
    ensureWorld();
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

  it('keeps an entry queued while a participant is in a live conversation', async () => {
    db.insert(conversations).values({
      participants: [a, d],
      messages: [],
      trigger_reason: `${TAG} live`,
      topic: null,
      status: 'active',
      started_at: Date.now(),
      ended_at: null,
      sentiment: 0,
      max_turns: 4,
    }).run();
    enqueue([a, b], 'template');
    enqueue([a, c], 'llm_standard');

    await conversationsTick();

    expect(startedConversations().map((x) => x.participants)).toEqual([[a, d]]);
    expect(taskRunner.startConversation).not.toHaveBeenCalled();
    expect(db.select().from(conversationQueue).all()).toHaveLength(2);
  });

  it('drops a timed-out entry whose participant is busy instead of templating it', async () => {
    db.insert(conversations).values({
      participants: [a, d],
      messages: [],
      trigger_reason: `${TAG} live`,
      topic: null,
      status: 'active',
      started_at: Date.now(),
      ended_at: null,
      sentiment: 0,
      max_turns: 4,
    }).run();
    enqueue([a, b], 'llm_standard', { queuedAt: Date.now() - 60_000 });

    await conversationsTick();

    expect(startedConversations().map((x) => x.participants)).toEqual([[a, d]]);
    expect(db.select().from(conversationQueue).all()).toHaveLength(0);
  });
});
