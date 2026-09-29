import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  agents,
  conversations,
  conversationQueue,
  conversationSchedulerState,
  locations,
  needs,
  relationships,
  relationshipEvents,
  templateUsage,
  worldState,
} from '../../db/schema';
import { CONVERSATION_TEMPLATES } from '../../data/templates';
import { greetingCategory, selectTemplate, type TemplateState } from '../templates';
import { conversationsTick } from '../../engine/systems/conversations';

/**
 * Playtest regressions in template-tier conversations:
 *  - every line was stored as "{speaker.name}: ...", and the UI labels the
 *    speaker too, so it read "Priya Sharma: Priya Sharma: I can barely see...";
 *  - the fog line fired in cloudy weather, "Perfect weather for being
 *    outdoors" indoors, "You have to come to Home 4" at Home 4;
 *  - some template conversations were a single line.
 */

const TAG = 'tmpltest';
const DRAWS = 200;

function state(overrides: Partial<TemplateState> = {}): TemplateState {
  return {
    friendship: 50,
    mood: 80,
    timeOfDay: 'afternoon',
    locationType: null,
    weather: 'sunny',
    setting: null,
    listenerElsewhere: false,
    ...overrides,
  };
}

let locId = 0;
let a = 0;
let b = 0;

function clearUsage(): void {
  db.delete(templateUsage).where(inArray(templateUsage.agent_a, [a, b])).run();
}

/** Every text the selector can produce for these inputs, cooldowns cleared each draw. */
function draw(category: string, s: TemplateState): Set<string> {
  return drawWith(category, s, undefined);
}

function drawWith(category: string, s: TemplateState, vars: Record<string, string> | undefined): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < DRAWS; i++) {
    clearUsage();
    const picked = selectTemplate(category, a, b, s, vars);
    if (picked) seen.add(picked.text);
  }
  return seen;
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
  const mk = (name: string) => db.insert(agents).values({
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
  a = mk('Priya Sharma');
  b = mk('Omar Haddad');
  for (const agent_id of [a, b]) {
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
  const ids = [a, b];
  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  db.run(sql`DELETE FROM activity_log
             WHERE initiator_id IN (${idList}) OR target_id IN (${idList})
                OR EXISTS (SELECT 1 FROM json_each(activity_log.agent_ids) WHERE value IN (${idList}))`);
  clearUsage();
  db.delete(conversations).where(like(conversations.trigger_reason, `${TAG}%`)).run();
  db.delete(relationshipEvents).where(inArray(relationshipEvents.agent_a, ids)).run();
  db.delete(needs).where(inArray(needs.agent_id, ids)).run();
  db.delete(agents).where(inArray(agents.id, ids)).run();
  db.delete(locations).where(eq(locations.id, locId)).run();
});

describe('template catalog', () => {
  it('stores only the spoken line, never a speaker-name prefix', () => {
    for (const t of CONVERSATION_TEMPLATES) {
      for (const v of t.variants) {
        expect(v.text).not.toMatch(/^\{speaker\.name\}/);
        expect(v.text).not.toContain('{speaker.name}:');
      }
    }
  });

  it('never frames a location as the whole world ("my favorite person in Home 4")', () => {
    for (const t of CONVERSATION_TEMPLATES) {
      for (const v of t.variants) expect(v.text).not.toMatch(/\bin \{location\.name\}/);
    }
  });

  it('keeps fog talk to foggy weather', () => {
    for (const t of CONVERSATION_TEMPLATES) {
      if (!t.variants.some((v) => /fog/i.test(v.text))) continue;
      expect(t.conditions.weather).toEqual(['foggy']);
    }
  });
});

describe('selectTemplate — context', () => {
  beforeEach(clearUsage);

  it('never talks about fog in cloudy weather', () => {
    const lines = draw('small_talk_weather', state({ weather: 'cloudy' }));
    expect(lines.size).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/fog/i);
  });

  it('never says an outdoors-only line indoors', () => {
    const lines = draw('small_talk_weather', state({ weather: 'sunny', setting: 'indoor' }));
    expect(lines.size).toBeGreaterThan(0);
    expect(lines).not.toContain("Perfect weather for being outdoors, don't you think, {other.name}?");
    // ...but outdoors it's still in the pool.
    expect(draw('small_talk_weather', state({ weather: 'sunny', setting: 'outdoor' })))
      .toContain("Perfect weather for being outdoors, don't you think, {other.name}?");
  });

  it('only invites someone to {location.name} when they are elsewhere', () => {
    const here = draw('excited_event', state({ listenerElsewhere: false }));
    for (const line of here) expect(line).not.toContain('come to {location.name}');
    const away = draw('excited_event', state({ listenerElsewhere: true }));
    expect([...away].some((l) => l.includes('come to {location.name}'))).toBe(true);
  });
});

describe('greetings', () => {
  it('have a template for every relationship band, mood and time of day', () => {
    const phases = ['dawn', 'morning', 'afternoon', 'evening', 'night'];
    const gaps: string[] = [];
    for (let friendship = -100; friendship <= 100; friendship += 5) {
      for (let mood = 0; mood <= 100; mood += 10) {
        for (const timeOfDay of phases) {
          clearUsage();
          const category = greetingCategory(friendship);
          const picked = selectTemplate(category, a, b, state({ friendship, mood, timeOfDay, weather: 'cloudy' }));
          if (!picked) gaps.push(`${category} f=${friendship} mood=${mood} ${timeOfDay}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it('greets a stranger (friendship 0) neutrally', () => {
    expect(greetingCategory(0)).toBe('greeting_neutral');
    expect(draw('greeting_neutral', state({ friendship: 0, mood: 50 })).size).toBeGreaterThan(0);
  });
});

describe('templates grounded in the real town', () => {
  beforeEach(clearUsage);

  it('names no member of the old fixed cast', () => {
    for (const t of CONVERSATION_TEMPLATES) {
      for (const v of t.variants) expect(v.text).not.toMatch(/\b(Priya|Marco|Little Life)\b/);
    }
  });

  const base = { 'other.name': 'Omar', 'location.name': 'Home 4', 'speaker.name': 'Priya' };
  const hungry = state({ friendship: 50, timeOfDay: 'afternoon', locationType: 'home' });

  it("drops a role line when nobody holds that job", () => {
    for (const line of drawWith('hungry', hungry, base)) expect(line).not.toContain('{baker.name}');
    expect(drawWith('hungry', hungry, { ...base, 'baker.name': 'Ines' })).toContain(
      "{baker.name}'s bread was incredible today. Have you tried it, {other.name}?",
    );
  });

  it('never invites someone to the tavern while already in it', () => {
    const vars = { ...base, 'tavern.name': 'The Rusty Mug' };
    const atTavern = drawWith('hungry', { ...hungry, locationType: 'tavern' }, vars);
    for (const line of atTavern) expect(line).not.toContain('{tavern.name}');
    expect([...drawWith('hungry', hungry, vars)].some((l) => l.includes('{tavern.name}'))).toBe(true);
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

  it('gives both people a line and no line repeats the speaker name', async () => {
    const convo = await runTemplateConversation();
    const messages = convo.messages as Array<{ speakerId: number; text: string }>;
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(new Set(messages.map((m) => m.speakerId))).toEqual(new Set([a, b]));
    for (const m of messages) {
      expect(m.text).not.toMatch(/^(Priya Sharma|Omar Haddad):/);
      expect(m.text).not.toContain('{');
    }
  });

  it('still gives the partner a reply when every template category is on cooldown', async () => {
    const now = Date.now();
    for (const category of new Set(CONVERSATION_TEMPLATES.map((t) => t.category))) {
      db.insert(templateUsage).values({ template_category: category, agent_a: Math.min(a, b), agent_b: Math.max(a, b), used_at: now }).run();
    }
    const convo = await runTemplateConversation();
    const messages = convo.messages as Array<{ speakerId: number; text: string }>;
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].speakerId).toBe(a);
    expect(messages[1].speakerId).toBe(b);
  });

  describe('each speaker speaks from their own state', () => {
    // a < b (inserted first), so friendship_ab is a's feeling toward b.
    function setFeelings(aTowardB: number, bTowardA: number): void {
      db.delete(relationships).where(eq(relationships.agent_a, a)).run();
      db.insert(relationships).values({
        agent_a: a, agent_b: b,
        friendship_ab: aTowardB, friendship_ba: bTowardA,
        romance_ab: 0, romance_ba: 0, trust_ab: 50, trust_ba: 50,
        familiarity: 40, interaction_count: 5, last_interaction: 0,
        average_interaction_sentiment: 0, tags: [], status: 'acquaintance',
        created_at: 0, last_updated: 0,
      }).run();
    }
    function setMood(agentId: number, mood: number): void {
      db.update(needs).set({ mood }).where(eq(needs.agent_id, agentId)).run();
    }
    const lines = (category: string) =>
      CONVERSATION_TEMPLATES.filter((t) => t.category === category).flatMap((t) => t.variants.map((v) => v.text));
    const render = (text: string, otherName: string) =>
      text.replace('{other.name}', otherName).replace('{location.name}', 'Home 4');

    afterEach(() => {
      db.delete(relationships).where(eq(relationships.agent_a, a)).run();
      setMood(a, 55);
      setMood(b, 55);
    });

    it("uses the replier's own friendship: a warm opener gets a cold reply from someone who dislikes them", async () => {
      setFeelings(60, -50);
      setMood(a, 55);
      setMood(b, 55);

      const messages = (await runTemplateConversation()).messages as Array<{ text: string }>;

      // Omar (friendship -50, mood 55) answers from the cold list; at that
      // friendship and mood only tense_encounter matches.
      expect(lines('tense_encounter').map((t) => render(t, 'Priya Sharma'))).toContain(messages[1].text);
    });

    it("uses the replier's own mood: a cheerful opener doesn't make a miserable partner cheerful", async () => {
      setFeelings(60, 60);
      setMood(a, 85);
      setMood(b, 10);

      const messages = (await runTemplateConversation()).messages as Array<{ text: string }>;

      // Priya (mood 85) opens excited; Omar (mood 10) answers from his own mood.
      expect(lines('excited_event').map((t) => render(t, 'Omar Haddad'))).toContain(messages[0].text);
      expect(lines('complaint_mood').map((t) => render(t, 'Priya Sharma'))).toContain(messages[1].text);
    });
  });
});
