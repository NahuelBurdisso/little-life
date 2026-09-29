import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  agents,
  conversations,
  conversationQueue,
  conversationSchedulerState,
  economy,
  locations,
  needs,
  relationships,
  relationshipEvents,
  templateUsage,
  worldEvents,
  worldState,
} from '../../db/schema';
import { recordScriptUsage, scriptLastUsed } from '../templates';
import { conversationsTick } from '../../engine/systems/conversations';
import { buildTemplateChatContext } from '../../helpers/templateChatContext';
import { SMALL_TALK_SCRIPTS } from '../../data/smallTalkScripts';
import { gameMinutesNow } from '../../lib/worldClock';

/**
 * Template-tier conversations end to end: the queue entry becomes one topic
 * script played from the real town (see server/lib/templateChat.ts, whose
 * own tests generate thousands of chats). Older regressions still pinned here:
 * no "{speaker.name}: " prefix, never a single line, each speaker speaks from
 * their own state.
 */

const TAG = 'tmpltest';

let locId = 0;
let a = 0;
let b = 0;
let c = 0;
const extraRows: { events: number[]; economy: number[] } = { events: [], economy: [] };

function clearUsage(): void {
  db.delete(templateUsage).where(inArray(templateUsage.agent_a, [a, b, c])).run();
}

function insertAgent(name: string): number {
  return db.insert(agents).values({
    name,
    bio: 'test',
    traits: [],
    personality: null,
    age: 30,
    gender: 'female',
    sprite_sheet: 'x',
    portrait_sprite: 'x',
    position: { x: 10, y: 10 },
    current_location: locId,
    current_action: { type: 'idle' },
    action_started: 0,
    action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: locId,
    created_at: 0,
    is_active: true,
  }).returning({ id: agents.id }).get().id;
}

function setFeelings(x: number, y: number, xTowardY: number, yTowardX: number, status = 'acquaintances'): void {
  const [lo, hi] = x < y ? [x, y] : [y, x];
  db.delete(relationships).where(sql`${relationships.agent_a} = ${lo} AND ${relationships.agent_b} = ${hi}`).run();
  db.insert(relationships).values({
    agent_a: lo, agent_b: hi,
    friendship_ab: x === lo ? xTowardY : yTowardX, friendship_ba: x === lo ? yTowardX : xTowardY,
    romance_ab: 0, romance_ba: 0, trust_ab: 50, trust_ba: 50,
    familiarity: 40, interaction_count: 5, last_interaction: 0,
    average_interaction_sentiment: 0, tags: [], status,
    created_at: 0, last_updated: 0,
  }).run();
}

function setMood(agentId: number, mood: number): void {
  db.update(needs).set({ mood }).where(eq(needs.agent_id, agentId)).run();
}

beforeAll(() => {
  if (!db.select().from(worldState).get()) {
    db.insert(worldState).values({
      time: { day: 1, hour: 14, minute: 0, totalTicks: 840, seasonDay: 1, season: 'spring' },
      day_phase: 'afternoon',
      weather: 'cloudy',
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
  locId = db.insert(locations).values({
    name: 'Home 4',
    type: 'home',
    position: { x: 0, y: 0, width: 4, height: 4 },
    entry_point: { x: 0, y: 0 },
    capacity: 2,
    current_occupants: [],
    services: [],
    description: 'test',
  }).returning({ id: locations.id }).get().id;
  a = insertAgent('Priya Sharma');
  b = insertAgent('Omar Haddad');
  c = insertAgent('Tmpl Ines');
  db.update(agents).set({ current_location: null }).where(eq(agents.id, c)).run();
  for (const agent_id of [a, b, c]) {
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
  const ids = [a, b, c];
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  db.run(sql`DELETE FROM activity_log
             WHERE initiator_id IN (${idList}) OR target_id IN (${idList})
                OR EXISTS (SELECT 1 FROM json_each(activity_log.agent_ids) WHERE value IN (${idList}))`);
  clearUsage();
  if (extraRows.events.length) db.delete(worldEvents).where(inArray(worldEvents.id, extraRows.events)).run();
  if (extraRows.economy.length) db.delete(economy).where(inArray(economy.id, extraRows.economy)).run();
  db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
  db.delete(relationshipEvents).where(inArray(relationshipEvents.agent_a, ids)).run();
  db.delete(relationships).where(inArray(relationships.agent_a, ids)).run();
  db.delete(needs).where(inArray(needs.agent_id, ids)).run();
  db.delete(agents).where(inArray(agents.id, ids)).run();
  db.delete(locations).where(eq(locations.id, locId)).run();
});

describe('script cooldowns', () => {
  beforeEach(clearUsage);

  it('records per pair and topic, in game minutes, whichever order the pair is given', () => {
    recordScriptUsage(b, a, 'weather_wet', 1234);
    recordScriptUsage(a, b, 'weather_wet', 1300);
    recordScriptUsage(a, b, 'the_day', 1250);
    expect(scriptLastUsed(a, b)).toEqual(new Map([['weather_wet', 1300], ['the_day', 1250]]));
    expect(scriptLastUsed(a, c).size).toBe(0);
  });

  it('ignores the old per-category rows', () => {
    db.insert(templateUsage).values({
      template_category: 'farewell', agent_a: Math.min(a, b), agent_b: Math.max(a, b), used_at: 0, used_game_min: 5,
    }).run();
    expect(scriptLastUsed(a, b).size).toBe(0);
  });
});

describe('the chat context comes from the real town', () => {
  afterEach(() => {
    db.delete(relationships).where(inArray(relationships.agent_a, [a, b, c])).run();
    db.delete(relationships).where(inArray(relationships.agent_b, [a, b, c])).run();
  });

  it('reads each side, a mutual acquaintance, a live event and the town baker', () => {
    setFeelings(a, b, 60, -30);
    setFeelings(a, c, 50, 0);
    setFeelings(b, c, -40, 0);
    setMood(b, 20);
    extraRows.events.push(db.insert(worldEvents).values({
      type: 'festival', name: 'Town Festival', description: 'x', started_at: 0, duration: 6,
      effects: {}, location_id: null, triggered_by: 'test', is_active: true,
    }).returning({ id: worldEvents.id }).get().id);
    extraRows.economy.push(db.insert(economy).values({
      agent_id: c, job: 'baker', job_title: 'Baker', salary: 20, work_performance: 50, money: 0,
      daily_expenses: 0, inventory: {}, last_payday: 0, production_remainder: 0,
    } as typeof economy.$inferInsert).returning({ id: economy.id }).get().id);

    const world = db.select().from(worldState).get()!;
    const [pa, pb] = [a, b].map((id) => db.select().from(agents).where(eq(agents.id, id)).get()!);
    const ctx = buildTemplateChatContext([pa, pb], locId, world, () => 0);

    expect(ctx.people[0]).toMatchObject({ first: 'Priya', friendship: 60, tone: 'warm', livesHere: true });
    expect(ctx.people[1]).toMatchObject({ first: 'Omar', friendship: -30, mood: 20, tone: 'cool' });
    expect(ctx.place).toMatchObject({ name: 'Home 4', type: 'home', setting: 'indoor', speakable: false });
    expect(ctx.mutual).toEqual({ first: 'Tmpl', openerLikes: true, listenerLikes: false });
    expect(ctx.event).toMatchObject({ key: 'festival', phrase: 'the festival' });
    expect(ctx.roles.baker).toBe('Tmpl');
    setMood(b, 55);
  });
});

describe('template conversations', () => {
  beforeEach(() => {
    clearUsage();
    db.delete(conversationQueue).run();
    db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
    const sched = db.select().from(conversationSchedulerState).get();
    if (sched) {
      db.update(conversationSchedulerState).set({ active_llm_conversations: [] })
        .where(eq(conversationSchedulerState.id, sched.id)).run();
    } else {
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
  });

  afterEach(() => {
    db.delete(relationships).where(inArray(relationships.agent_a, [a, b, c])).run();
    setMood(a, 55);
    setMood(b, 55);
  });

  async function runTemplateConversation() {
    db.insert(conversationQueue).values({
      participants: [a, b],
      tier: 'template',
      priority: 50,
      trigger_reason: TAG,
      topic: null,
      queued_at: Date.now(),
      max_wait: 10000,
    }).run();
    await conversationsTick();
    const rows = db.select().from(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).all();
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it('is one topic in alternating turns, first names only, and books its cooldown', async () => {
    const convo = await runTemplateConversation();
    const messages = convo.messages as Array<{ speakerId: number; text: string }>;
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages[0].speakerId).toBe(a);
    for (let k = 1; k < messages.length; k++) expect(messages[k].speakerId).not.toBe(messages[k - 1].speakerId);
    for (const m of messages) {
      expect(m.text).not.toMatch(/^(Priya Sharma|Omar Haddad):/);
      expect(m.text).not.toMatch(/Sharma|Haddad/);
      expect(m.text).not.toContain('{');
    }
    const used = [...scriptLastUsed(a, b).keys()];
    expect(used).toHaveLength(1);
    const script = SMALL_TALK_SCRIPTS.find((s) => s.id === used[0])!;
    expect(convo.topic).toBeTruthy();
    expect(script).toBeDefined();
  });

  it('still has a conversation when every topic is on cooldown', async () => {
    const now = gameMinutesNow();
    for (const s of SMALL_TALK_SCRIPTS) recordScriptUsage(a, b, s.id, now);
    const convo = await runTemplateConversation();
    const messages = convo.messages as Array<{ speakerId: number; text: string }>;
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages[0].speakerId).toBe(a);
    expect(messages[1].speakerId).toBe(b);
  });

  describe('each speaker speaks from their own state', () => {
    it("uses the replier's own friendship: a warm opener gets a cool reply from someone who dislikes them", async () => {
      setFeelings(a, b, 60, -50);
      for (let n = 0; n < 5; n++) {
        clearUsage();
        db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
        const messages = (await runTemplateConversation()).messages as Array<{ sentiment: number }>;
        expect(messages[1].sentiment).toBeLessThanOrEqual(0.1);
      }
    });

    it("uses the replier's own mood: a cheerful opener doesn't make a miserable partner cheerful", async () => {
      setFeelings(a, b, 60, 60);
      setMood(a, 85);
      setMood(b, 10);
      for (let n = 0; n < 5; n++) {
        clearUsage();
        db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
        const messages = (await runTemplateConversation()).messages as Array<{ sentiment: number }>;
        expect(messages[1].sentiment).toBeLessThanOrEqual(0.1);
      }
    });
  });
});
