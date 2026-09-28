import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
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
  worldState,
} from '../../../db/schema';
import { simEvents } from '../../../lib/simEvents';
import { initMemoryObserver } from '../../../lib/memory/MemoryObserver';
import type { MemoryService } from '../../../lib/memory/MemoryService';
import { conversationsTick } from '../conversations';

/**
 * B3 regression: Step A of `conversationsTick` computed a `truncated` flag for
 * conversations force-ended by the wall-clock turn budget, then dropped it on
 * the floor when handing them to `processCompletedConversation`. A cut-short
 * exchange was therefore indistinguishable from a natural one — including in the
 * agents' own memories ("we wrapped up our conversation").
 */

const record = vi.fn();
initMemoryObserver({ record } as unknown as MemoryService);

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

function setActive(entries: Array<{ conversationId: number; startedAt: number }>): void {
  const existing = db.select().from(conversationSchedulerState).get();
  if (existing) {
    db.update(conversationSchedulerState)
      .set({ active_llm_conversations: entries })
      .where(eq(conversationSchedulerState.id, existing.id))
      .run();
    return;
  }
  db.insert(conversationSchedulerState).values({
    active_llm_conversations: entries,
    max_concurrent_llm: 2,
    max_queue_size: 10,
    max_turns_deep: 6,
    max_turns_standard: 4,
    template_fallback_after_ms: 30000,
    stats: { llmConversationsTotal: 0, templateConversationsTotal: 0, averageResponseTimeMs: 0, queueTimeoutsTotal: 0 },
  }).run();
}

function insertHome(): number {
  return db.insert(locations).values({
    name: 'Test Cottage',
    type: 'home',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 0, y: 0 },
    capacity: 2,
    current_occupants: [],
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, home: number): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality: null,
    age: 30,
    gender: 'female',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 0, y: 0 },
    current_action: { type: 'idle' },
    action_started: 0,
    action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home,
    created_at: 0,
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function insertConversation(participants: number[], turns: number, maxTurns: number): number {
  const messages = Array.from({ length: turns }, (_, i) => ({
    speakerId: participants[i % 2],
    text: `line ${i}`,
    sentiment: 0.2,
    topics: [],
    timestamp: i,
  }));
  return db.insert(conversations).values({
    participants,
    messages,
    trigger_reason: 'test',
    topic: 'the harvest',
    status: 'active',
    started_at: Date.now(),
    ended_at: null,
    sentiment: 0,
    max_turns: maxTurns,
  }).returning({ id: conversations.id }).get().id;
}

describe('conversationsTick — truncated conversations (B3)', () => {
  const agentIds: number[] = [];
  let homeId = 0;
  const ended: Array<{ agentId: number; truncated?: boolean }> = [];
  const onEnded = (p: { agentId: number; truncated?: boolean }) => ended.push(p);

  beforeAll(() => {
    ensureWorld();
    homeId = insertHome();
    agentIds.push(insertAgent('Ada', homeId), insertAgent('Bram', homeId));
    for (const agent_id of agentIds) {
      db.insert(needs).values({
        agent_id,
        hunger: 50, energy: 50, social: 40, comfort: 50, fun: 40, mood: 50, stress: 20,
        decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
        thresholds: { critical: 10, low: 30, satisfied: 70 },
        mood_modifiers: [],
        last_updated: 0,
      }).run();
    }
    simEvents.on('conversation:ended', onEnded);
  });

  afterAll(() => {
    simEvents.off('conversation:ended', onEnded);
    setActive([]);
    // Workers reuse the DB across files, so leave nothing of these two behind.
    const ids = sql.join(agentIds.map((id) => sql`${id}`), sql`, `);
    db.run(sql`DELETE FROM activity_log
               WHERE initiator_id IN (${ids}) OR target_id IN (${ids})
                  OR EXISTS (SELECT 1 FROM json_each(activity_log.agent_ids) WHERE value IN (${ids}))`);
    db.delete(conversations).where(eq(conversations.trigger_reason, 'test')).run();
    db.delete(relationshipEvents).where(inArray(relationshipEvents.agent_a, agentIds)).run();
    db.delete(relationshipEvents).where(inArray(relationshipEvents.agent_b, agentIds)).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, agentIds)).run();
    db.delete(needs).where(inArray(needs.agent_id, agentIds)).run();
    db.delete(agents).where(inArray(agents.id, agentIds)).run();
    db.delete(locations).where(eq(locations.id, homeId)).run();
  });

  beforeEach(() => {
    ended.length = 0;
    record.mockClear();
    // Keep Steps C–E inert: only the scheduler entries this test sets matter.
    db.delete(conversationQueue).run();
  });

  afterEach(() => setActive([]));

  it('flags a conversation the turn budget cut off, end to end', async () => {
    const id = insertConversation(agentIds, 1, 6);
    // Far past any budget: max_turns_deep × 15 s.
    setActive([{ conversationId: id, startedAt: Date.now() - 10_000_000 }]);

    await conversationsTick();

    expect(ended).toHaveLength(2);
    expect(ended.every((e) => e.truncated === true)).toBe(true);

    const row = db.select().from(conversations).where(eq(conversations.id, id)).get()!;
    expect(row.status).toBe('ended');
    expect(row.quality_breakdown?.truncated).toBe(1);

    const convoMemories = record.mock.calls.filter((c) => c[1] === 'conversation');
    expect(convoMemories).toHaveLength(2);
    for (const [, , description, metadata] of convoMemories) {
      expect(description).not.toMatch(/wrapped up/);
      expect(description).toMatch(/cut off|before we were done/);
      expect(metadata).toMatchObject({ truncated: true });
    }
  });

  it('does not flag a conversation that reached max_turns on its own', async () => {
    const id = insertConversation(agentIds, 4, 4);
    setActive([{ conversationId: id, startedAt: Date.now() }]);

    await conversationsTick();

    expect(ended).toHaveLength(2);
    expect(ended.every((e) => e.truncated === false)).toBe(true);
    const row = db.select().from(conversations).where(eq(conversations.id, id)).get()!;
    expect(row.quality_breakdown).not.toHaveProperty('truncated');
    for (const [, , , metadata] of record.mock.calls.filter((c) => c[1] === 'conversation')) {
      expect(metadata).not.toHaveProperty('truncated');
    }
  });

  it('does not flag a timed-out conversation whose last turn landed in time', async () => {
    // Over budget, but the in-flight final turn filled the transcript: nothing
    // was actually cut, so it must read as a finished conversation.
    const id = insertConversation(agentIds, 6, 6);
    setActive([{ conversationId: id, startedAt: Date.now() - 10_000_000 }]);

    await conversationsTick();

    expect(ended).toHaveLength(2);
    expect(ended.every((e) => e.truncated === false)).toBe(true);
  });

  it('ends a zero-turn force-ended conversation quietly', async () => {
    // The LLM hung for the whole budget and nothing was ever said.
    const id = insertConversation(agentIds, 0, 6);
    for (const agentId of agentIds) {
      db.update(agents)
        .set({ current_action: { type: 'talking', conversationId: id } })
        .where(eq(agents.id, agentId))
        .run();
    }
    const socialBefore = db.select().from(needs).where(inArray(needs.agent_id, agentIds)).all()
      .map((n) => n.social);
    const relEventsBefore = db.select().from(relationshipEvents)
      .where(inArray(relationshipEvents.agent_a, agentIds)).all().length;
    setActive([{ conversationId: id, startedAt: Date.now() - 10_000_000 }]);

    await conversationsTick();

    const row = db.select().from(conversations).where(eq(conversations.id, id)).get()!;
    expect(row.status).toBe('ended');
    // No memory, no cascade trigger, no relationship change, no social boost.
    expect(ended).toHaveLength(0);
    expect(record).not.toHaveBeenCalled();
    expect(db.select().from(relationshipEvents)
      .where(inArray(relationshipEvents.agent_a, agentIds)).all()).toHaveLength(relEventsBefore);
    expect(db.select().from(needs).where(inArray(needs.agent_id, agentIds)).all()
      .map((n) => n.social)).toEqual(socialBefore);
    // ...but the participants are handed back.
    for (const a of db.select().from(agents).where(inArray(agents.id, agentIds)).all()) {
      expect(a.current_action).toEqual({ type: 'idle' });
    }
  });
});
