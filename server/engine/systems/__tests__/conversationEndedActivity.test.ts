import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import {
  activityLog,
  agents,
  conversations,
  conversationQueue,
  conversationSchedulerState,
  locations,
  needs,
  relationshipEvents,
  worldState,
} from '../../../db/schema';
import { conversationsTick } from '../conversations';

/**
 * Playtest regression: the feed read "X and Y finished talking at flirting" —
 * `conversation_ended` fed the conversation's topic into the `{location}` slot.
 */

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

describe('conversationsTick — conversation_ended activity', () => {
  let locId = 0;
  const ids: number[] = [];

  beforeAll(() => {
    ensureWorld();
    locId = db.insert(locations).values({
      name: 'The Rusty Mug',
      type: 'tavern',
      position: { x: 0, y: 0, width: 4, height: 4 },
      entry_point: { x: 0, y: 0 },
      capacity: 8,
      current_occupants: [],
      services: [],
      description: 'test',
    }).returning({ id: locations.id }).get().id;
    for (const name of ['Sofia', 'Omar']) {
      const id = db.insert(agents).values({
        name,
        bio: 'test',
        traits: [],
        personality: null,
        age: 30,
        gender: 'female',
        sprite_sheet: 'x',
        portrait_sprite: 'x',
        position: { x: 0, y: 0 },
        current_location: locId,
        current_action: { type: 'idle' },
        action_started: 0,
        action_queue: [],
        schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
        home: locId,
        created_at: 0,
        is_active: true,
      }).returning({ id: agents.id }).get().id;
      ids.push(id);
      db.insert(needs).values({
        agent_id: id,
        hunger: 50, energy: 50, social: 40, comfort: 50, fun: 40, mood: 50, stress: 20,
        decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
        thresholds: { critical: 10, low: 30, satisfied: 70 },
        mood_modifiers: [],
        last_updated: 0,
      }).run();
    }
  });

  afterAll(() => {
    setActive([]);
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    db.run(sql`DELETE FROM activity_log
               WHERE initiator_id IN (${idList}) OR target_id IN (${idList})
                  OR EXISTS (SELECT 1 FROM json_each(activity_log.agent_ids) WHERE value IN (${idList}))`);
    db.delete(conversations).where(eq(conversations.trigger_reason, 'endedtest')).run();
    db.delete(relationshipEvents).where(inArray(relationshipEvents.agent_a, ids)).run();
    db.delete(needs).where(inArray(needs.agent_id, ids)).run();
    db.delete(agents).where(inArray(agents.id, ids)).run();
    db.delete(locations).where(eq(locations.id, locId)).run();
  });

  it('logs the location name as the location and the topic separately', async () => {
    db.delete(conversationQueue).run();
    const id = db.insert(conversations).values({
      participants: ids,
      messages: Array.from({ length: 4 }, (_, i) => ({
        speakerId: ids[i % 2], text: `line ${i}`, sentiment: 0.2, topics: [], timestamp: i,
      })),
      location: locId,
      trigger_reason: 'endedtest',
      topic: 'flirting',
      status: 'active',
      started_at: Date.now(),
      ended_at: null,
      sentiment: 0,
      max_turns: 4,
    }).returning({ id: conversations.id }).get().id;
    setActive([{ conversationId: id, startedAt: Date.now() }]);

    await conversationsTick();

    const row = db.select().from(activityLog)
      .where(eq(activityLog.type, 'conversation_ended'))
      .all()
      .find((r) => (r.agent_ids as number[]).includes(ids[0]));
    expect(row).toBeDefined();
    expect(row!.template_data).toMatchObject({ location: 'The Rusty Mug', topic: 'flirting' });
    expect(row!.location_id).toBe(locId);
  });
});
