import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  agentStates, agents, conversationQueue, locations, needs, relationshipEvents, relationships, shared_knowledge, worldState,
} from '../../../db/schema';
import { SUSPICION_TOPIC } from '../../../ai/prompts';
import {
  SUSPICION_AFTER_TALK, SUSPICION_TRIGGER, SUSPICIOUS_MINUTES, onSuspicionConversationEnded, registerSuspicionListeners,
  suspicionPass,
} from '../suspicion';
import { intimacyTick } from '../index';
import { beginTryst, trystPass } from '../tryst';
import { clearIntimacy, ensureAgentIntimacy, getAgentIntimacy, getSuspicionProcessedDay } from '../state';
import { MARRIED_TAG } from '../../marriage';
import { learnFact } from '../../gossip';
import { setRuleOverrides } from '../../worldRules';
import { gameMinutes } from '../../gameClock';
import { simEvents } from '../../simEvents';
import { getActiveStatePrompts } from '../../states';

/**
 * Partners who share a home notice an empty bed: two nights away and they are
 * suspicious (and go and ask), one is not yet enough; only partners who share the
 * bed, only adults, only with the rule on; learning the real thing ends it; and how
 * the confrontation ended decides what it leaves.
 */

const TIME = { day: 40, hour: 20, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const DAY = 24 * 60;
const morningOf = (day: number, hour = 7) => ({ ...TIME, day, hour, minute: 0 });
const MORNING = morningOf(41);
const NOW = gameMinutes(MORNING);

const madeAgents: number[] = [];
const madeLocations: number[] = [];

function setClock(time = MORNING): void {
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, weather: 'sunny', tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time, day_phase: 'morning', weather: 'sunny', weather_duration: 120, tick_speed: 1,
    is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
    pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
  }).run();
}

function insertLocation(name: string, x = 0): number {
  const id = db.insert(locations).values({
    name, type: 'home', position: { x, y: 0, width: 96, height: 96 }, entry_point: { x, y: 96 },
    capacity: 20, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  madeLocations.push(id);
  return id;
}

function insertAgent(name: string, home: number, over: Partial<typeof agents.$inferInsert> = {}, personality: Record<string, number> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 50, morality: 60, sensuality: 50, neuroticism: 40, ...personality,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 23, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home, current_location: home, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  madeAgents.push(id);
  db.insert(needs).values({
    agent_id: id, hunger: 60, energy: 60, social: 40, comfort: 50, fun: 40, mood: 55, stress: 20,
    decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
    thresholds: { critical: 10, low: 30, satisfied: 70 }, mood_modifiers: [], last_updated: 0,
  }).run();
  return id;
}

function relate(x: number, y: number, status = 'partners', tags: string[] = []): number {
  return db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y), friendship_ab: 70, friendship_ba: 70,
    romance_ab: 80, romance_ba: 80, trust_ab: 70, trust_ba: 70, familiarity: 80, interaction_count: 40,
    last_interaction: 0, average_interaction_sentiment: 0.5, tags, status, created_at: 0, last_updated: 0,
  }).returning({ id: relationships.id }).get().id;
}

/**
 * A wife (`p`) and her husband (`g`) who live together, and a woman (`h`) in a home of her own whose
 * guest `g` was last night: he was away from his own bed for it.
 */
function household(over: { pOver?: Partial<typeof agents.$inferInsert>; pPersonality?: Record<string, number>; status?: string } = {}) {
  const home = insertLocation(`Cottage ${madeLocations.length}`, 100);
  const hostHome = insertLocation(`Rooms ${madeLocations.length}`, 300);
  const p = insertAgent(`Wife ${madeAgents.length}`, home, { gender: 'female', ...over.pOver }, over.pPersonality);
  const g = insertAgent(`Husband ${madeAgents.length}`, home, { gender: 'male' });
  const h = insertAgent(`Widow ${madeAgents.length}`, hostHome, { gender: 'female' });
  const relId = relate(p, g, over.status ?? 'partners', [MARRIED_TAG]);
  return { p, g, h, home, hostHome, relId };
}

/** `guest` spent last night at `host`'s (recorded the way tryst.ts does when the evening ends). */
const awayLastNight = (guest: number, host: number, hoursAgo = 9) => {
  ensureAgentIntimacy(guest).awayNight = { since: NOW - hoursAgo * 60, hostId: host };
};

const statesOf = (id: number) => db.select().from(agentStates).where(eq(agentStates.agent_id, id)).all();
const queued = () => db.select().from(conversationQueue).where(eq(conversationQueue.trigger_reason, SUSPICION_TRIGGER)).all();
const suspicionOf = (observer: number, partner: number) => getAgentIntimacy(observer)?.suspicion[partner];
const relOf = (id: number) => db.select().from(relationships).where(eq(relationships.id, id)).get()!;

describe('suspicion of an empty bed', () => {
  beforeAll(() => {
    setClock();
    setRuleOverrides({ adultContent: true });
  });

  beforeEach(() => {
    clearIntimacy();
    setRuleOverrides({ adultContent: true });
    setClock();
    db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, SUSPICION_TRIGGER)).run();
    if (madeAgents.length) db.update(agents).set({ is_active: false }).where(inArray(agents.id, madeAgents)).run();
  });

  afterAll(() => {
    setRuleOverrides({ adultContent: false });
    db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, SUSPICION_TRIGGER)).run();
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, madeAgents), inArray(shared_knowledge.target_id, madeAgents))).run();
    db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, madeAgents), inArray(relationshipEvents.agent_b, madeAgents))).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, madeAgents)).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, madeAgents), inArray(relationships.agent_b, madeAgents))).run();
    db.delete(needs).where(inArray(needs.agent_id, madeAgents)).run();
    db.delete(agents).where(inArray(agents.id, madeAgents)).run();
    db.delete(locations).where(inArray(locations.id, madeLocations)).run();
    clearIntimacy();
  });

  // ─── Noticing ─────────────────────────────────────────────────────────────

  describe('the morning pass', () => {
    it('one night away is a doubt, not yet a suspicion: nothing else happens', () => {
      const { p, g, h } = household();
      awayLastNight(g, h);
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBe(1);
      expect(statesOf(p).map((s) => s.type)).not.toContain('suspicious');
      expect(queued()).toHaveLength(0);
      // The absence was counted, once.
      expect(getAgentIntimacy(g)!.awayNight).toBeUndefined();
    });

    it('a second night away makes them suspicious, targeting the partner, and queues the confrontation', () => {
      const { p, g, h } = household();
      awayLastNight(g, h);
      suspicionPass(MORNING);
      const tomorrow = morningOf(42);
      setClock(tomorrow);
      ensureAgentIntimacy(g).awayNight = { since: gameMinutes(tomorrow) - 9 * 60, hostId: h };
      suspicionPass(tomorrow);

      expect(suspicionOf(p, g)).toBe(2);
      const state = statesOf(p).filter((s) => s.type === 'suspicious');
      expect(state).toHaveLength(1);
      expect(state[0]).toMatchObject({ target_agent_id: g, duration: SUSPICIOUS_MINUTES, started_at: gameMinutes(tomorrow) });
      const q = queued();
      expect(q).toHaveLength(1);
      // The suspicious one first (they open), a real deep conversation with the topic's own label.
      expect(q[0]).toMatchObject({ participants: [p, g], tier: 'llm_deep', topic: SUSPICION_TOPIC, trigger_reason: 'suspicion' });
      // The state speaks in the prompt.
      expect(getActiveStatePrompts(p, gameMinutes(tomorrow)).join(' ')).toContain(`You suspect ${db.select().from(agents).where(eq(agents.id, g)).get()!.name} is hiding something`);
    });

    it('a second pass the same morning does nothing more (once per game day, by game time)', () => {
      const { p, g, h } = household();
      awayLastNight(g, h);
      suspicionPass(MORNING);
      expect(getSuspicionProcessedDay()).toBe(Math.floor(NOW / DAY));
      awayLastNight(g, h); // another night recorded, unread until tomorrow
      suspicionPass({ ...MORNING, hour: 9 });
      expect(suspicionOf(p, g)).toBe(1);
      expect(getAgentIntimacy(g)!.awayNight).toBeDefined();
      // ...and the next morning it runs again.
      const tomorrow = morningOf(42);
      ensureAgentIntimacy(g).awayNight = { since: gameMinutes(tomorrow) - 9 * 60, hostId: h };
      suspicionPass(tomorrow);
      expect(suspicionOf(p, g)).toBe(2);
    });

    it('waits for the morning: before 7 h the pass does not run, and does not spend the day', () => {
      const { p, g, h } = household();
      awayLastNight(g, h);
      suspicionPass(morningOf(41, 6));
      expect(suspicionOf(p, g)).toBeUndefined();
      expect(getSuspicionProcessedDay()).toBeNull();
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBe(1);
    });

    it('a partner who is curious, and a guest still glowing, is suspicious after a single night', () => {
      const { p, g, h } = household({ pPersonality: { curiosity: 80 } });
      awayLastNight(g, h);
      db.insert(agentStates).values({
        agent_id: g, type: 'afterglow', severity: 0.6, started_at: NOW - 60, duration: 480, target_agent_id: h,
        source: 'test', metadata: null,
      }).run();
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBe(2);
      expect(statesOf(p).map((s) => s.type)).toContain('suspicious');
      expect(queued()).toHaveLength(1);
    });

    it('the glow gives nothing away to an incurious partner', () => {
      const { p, g, h } = household({ pPersonality: { curiosity: 40 } });
      awayLastNight(g, h);
      db.insert(agentStates).values({
        agent_id: g, type: 'afterglow', severity: 0.6, started_at: NOW - 60, duration: 480, target_agent_id: h,
        source: 'test', metadata: null,
      }).run();
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBe(1);
    });

    it('a night from before the morning\'s window is not last night', () => {
      const { p, g, h } = household();
      awayLastNight(g, h, 30);
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBeUndefined();
      expect(getAgentIntimacy(g)!.awayNight).toBeUndefined();
    });
  });

  // ─── Who ──────────────────────────────────────────────────────────────────

  describe('only partners who share the bed, only adults', () => {
    it('a friend or a stranger who lives in the house notices nothing', () => {
      const { p, g, h } = household({ status: 'friends' });
      awayLastNight(g, h);
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBeUndefined();
      // Nor does somebody with no relationship row at all.
      const home = insertLocation('Strangers', 500);
      const s1 = insertAgent(`Lodger ${madeAgents.length}`, home);
      const s2 = insertAgent(`Traveller ${madeAgents.length}`, home);
      awayLastNight(s2, h);
      suspicionPass(morningOf(42));
      expect(suspicionOf(s1, s2)).toBeUndefined();
    });

    it('a partner who lives elsewhere sees no empty bed', () => {
      const { p, g, h } = household();
      db.update(agents).set({ home: insertLocation('Elsewhere', 700) }).where(eq(agents.id, p)).run();
      awayLastNight(g, h);
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBeUndefined();
    });

    it('the host\'s own partner is not the one who spent the night with them', () => {
      const { p, g } = household();
      // The night was spent with the wife herself.
      awayLastNight(g, p);
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBeUndefined();
    });

    it('nobody under 18 is ever pulled into it, even as the one who notices', () => {
      const { p, g, h } = household({ pOver: { age: 17 } });
      awayLastNight(g, h);
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBeUndefined();
      expect(statesOf(p)).toHaveLength(0);
      expect(queued()).toHaveLength(0);
    });

    it('a pair that broke up in the meantime is let go', () => {
      const { p, g, h, relId } = household();
      ensureAgentIntimacy(p).suspicion[g] = 3;
      awayLastNight(g, h);
      db.update(relationships).set({ status: 'rivals', tags: [] }).where(eq(relationships.id, relId)).run();
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBeUndefined();
      expect(queued()).toHaveLength(0);
    });
  });

  describe('with the rule off', () => {
    it('nothing is counted or queued, and the day is not spent', () => {
      const { p, g, h } = household();
      ensureAgentIntimacy(p).suspicion[g] = 5;
      awayLastNight(g, h);
      setRuleOverrides({ adultContent: false });
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBe(5);
      expect(statesOf(p)).toHaveLength(0);
      expect(queued()).toHaveLength(0);
      expect(getSuspicionProcessedDay()).toBeNull();
    });
  });

  // ─── Knowing ──────────────────────────────────────────────────────────────

  describe('learning the truth ends it', () => {
    it('an affair fact the suspicious one learns (gossip) clears the doubt and the state', () => {
      const { p, g, h } = household();
      ensureAgentIntimacy(p).suspicion[g] = 2;
      db.insert(agentStates).values({
        agent_id: p, type: 'suspicious', severity: 0.6, started_at: NOW, duration: 999, target_agent_id: g, source: 'test', metadata: null,
      }).run();
      registerSuspicionListeners();
      const factId = learnFact('affair', g, h, 3, [g, h, p], 'witnessed')!;
      simEvents.emit('gossip:learned', { agentId: p, sourceName: 'x', content: 'x', factType: 'affair', factId });
      expect(suspicionOf(p, g)).toBeUndefined();
      expect(statesOf(p).map((s) => s.type)).not.toContain('suspicious');
    });

    it('a tryst_seen fact counts too, and one about somebody else does not', () => {
      const { p, g, h } = household();
      const other = insertAgent(`Bystander ${madeAgents.length}`, insertLocation('Elsewhere 2', 900));
      ensureAgentIntimacy(p).suspicion[g] = 2;
      registerSuspicionListeners();
      const unrelated = learnFact('tryst_seen', other, h, 3, [p], 'observed')!;
      simEvents.emit('gossip:learned', { agentId: p, factType: 'tryst_seen', factId: unrelated });
      expect(suspicionOf(p, g)).toBe(2);
      const about = learnFact('tryst_seen', g, h, 3, [p], 'observed')!;
      simEvents.emit('gossip:learned', { agentId: p, factType: 'tryst_seen', factId: about });
      expect(suspicionOf(p, g)).toBeUndefined();
    });

    it('a fact a witness learned by `known_by` (no event) is caught by the morning pass, and stops the counting', () => {
      const { p, g, h } = household();
      ensureAgentIntimacy(p).suspicion[g] = 2;
      learnFact('tryst_seen', g, h, 3, [p], 'observed');
      awayLastNight(g, h);
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBeUndefined();
      expect(queued()).toHaveLength(0);
    });

    it('a fact that is about the suspicious one\'s own tryst with the partner is not a betrayal by the partner', () => {
      const { p, g, h } = household();
      ensureAgentIntimacy(p).suspicion[g] = 1;
      learnFact('tryst_seen', g, p, 3, [p], 'observed');
      awayLastNight(g, h);
      suspicionPass(MORNING);
      expect(suspicionOf(p, g)).toBe(2);
    });
  });

  // ─── The confrontation ────────────────────────────────────────────────────

  describe('the confrontation', () => {
    const suspicious = (p: number, g: number) => {
      ensureAgentIntimacy(p).suspicion[g] = 2;
      db.insert(agentStates).values({
        agent_id: p, type: 'suspicious', severity: 0.6, started_at: NOW, duration: SUSPICIOUS_MINUTES, target_agent_id: g,
        source: 'test', metadata: null,
      }).run();
    };
    const ended = (p: number, g: number, sentiment: number, extra: Record<string, unknown> = {}) =>
      onSuspicionConversationEnded({ agentId: p, perpetratorId: g, summary: SUSPICION_TOPIC, sentiment, ...extra });

    it('a bad ending is believed: a rager breaks up, and the suspicion is spent', () => {
      const { p, g, relId } = household({ pPersonality: { aggression: 90 } });
      suspicious(p, g);
      ended(p, g, -0.7);
      expect(relOf(relId).status).toBe('rivals');
      expect(suspicionOf(p, g)).toBeUndefined();
      expect(statesOf(p).map((s) => s.type)).toEqual(expect.arrayContaining(['heartbroken', 'angry']));
      expect(statesOf(p).map((s) => s.type)).not.toContain('suspicious');
    });

    it('a bad ending with a loyal partner: forgiven, at a price in trust', () => {
      const { p, g, relId } = household({ pPersonality: { loyalty: 90, aggression: 10 } });
      suspicious(p, g);
      const before = relOf(relId);
      ended(p, g, -0.6);
      const after = relOf(relId);
      expect(after.status).toBe('partners');
      const trust = (r: typeof before) => (p < g ? r.trust_ab : r.trust_ba);
      expect(trust(after)).toBe(trust(before) - 30);
      expect(suspicionOf(p, g)).toBeUndefined();
    });

    it('a calm one: trust −10, the suspicion eases to 1, the state is gone', () => {
      const { p, g } = household({ pPersonality: { aggression: 90 } });
      suspicious(p, g);
      ended(p, g, 0.1);
      const events = db.select().from(relationshipEvents)
        .where(and(eq(relationshipEvents.agent_a, Math.min(p, g)), eq(relationshipEvents.agent_b, Math.max(p, g)))).all();
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('suspicion');
      const [mine, theirs] = p < g
        ? [events[0].trust_delta_ab, events[0].trust_delta_ba]
        : [events[0].trust_delta_ba, events[0].trust_delta_ab];
      expect([mine, theirs]).toEqual([-10, 0]);
      expect(suspicionOf(p, g)).toBe(SUSPICION_AFTER_TALK);
      expect(statesOf(p).map((s) => s.type)).not.toContain('suspicious');
    });

    it('acts once: the answerer\'s copy of the event, a second run, and a template chat do nothing', () => {
      const { p, g } = household();
      suspicious(p, g);
      ended(g, p, 0.1); // the partner's own conversation:ended
      expect(suspicionOf(p, g)).toBe(2);
      ended(p, g, 0.1, { template: true });
      expect(suspicionOf(p, g)).toBe(2);
      ended(p, g, 0.1);
      expect(suspicionOf(p, g)).toBe(SUSPICION_AFTER_TALK);
      ended(p, g, 0.1); // fired again for the same conversation: the state is gone, nothing to settle
      expect(db.select().from(relationshipEvents).where(eq(relationshipEvents.event_type, 'suspicion')).all()
        .filter((e) => [e.agent_a, e.agent_b].includes(p))).toHaveLength(1);
    });

    it('any other conversation is not the confrontation', () => {
      const { p, g } = household();
      suspicious(p, g);
      onSuspicionConversationEnded({ agentId: p, perpetratorId: g, summary: 'weather', sentiment: -0.9 });
      expect(suspicionOf(p, g)).toBe(2);
    });

    it('is heard through the real event too', () => {
      const { p, g, relId } = household({ pPersonality: { aggression: 90 } });
      suspicious(p, g);
      registerSuspicionListeners();
      simEvents.emit('conversation:ended', { agentId: p, perpetratorId: g, summary: SUSPICION_TOPIC, sentiment: -0.8 });
      expect(relOf(relId).status).toBe('rivals');
    });
  });

  // ─── Recording the night ──────────────────────────────────────────────────

  describe('the night is recorded when the guest stays', () => {
    const lovers = () => {
      const aHome = insertLocation(`Cottage ${madeLocations.length}`, 200);
      const bHome = insertLocation(`Farmhouse ${madeLocations.length}`, 400);
      const a = insertAgent(`Host ${madeAgents.length}`, aHome, { gender: 'female' });
      const b = insertAgent(`Guest ${madeAgents.length}`, bHome, { gender: 'male', current_location: aHome });
      return { a, b, aHome };
    };
    const TRYST_TIME = { ...TIME, day: 40, hour: 20 };
    const load = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;
    const locOf = (id: number) => db.select().from(locations).where(eq(locations.id, id)).get()!;

    it('a completed evening at the host\'s home marks the guest, and only the guest, as away', () => {
      setClock(TRYST_TIME);
      const { a, b, aHome } = lovers();
      expect(beginTryst(load(a), load(b), locOf(aHome), TRYST_TIME, () => 0)).toBe(true);
      trystPass({ ...TRYST_TIME, hour: 21 }, () => 0);
      expect(getAgentIntimacy(b)!.awayNight).toEqual({ since: gameMinutes({ ...TRYST_TIME, hour: 21 }), hostId: a });
      expect(getAgentIntimacy(a)?.awayNight).toBeUndefined();
    });

    it('an evening walked in on sends the guest home: no night away', () => {
      setClock(TRYST_TIME);
      const { a, b, aHome } = lovers();
      beginTryst(load(a), load(b), locOf(aHome), TRYST_TIME, () => 0);
      insertAgent(`Housemate ${madeAgents.length}`, aHome, { gender: 'male' });
      trystPass({ ...TRYST_TIME, minute: 10 }, () => 0);
      expect(getAgentIntimacy(b)?.awayNight).toBeUndefined();
    });

    it('a couple who both live at the venue spend no night away from anyone', () => {
      setClock(TRYST_TIME);
      const { a, b, aHome } = lovers();
      db.update(agents).set({ home: aHome }).where(eq(agents.id, b)).run();
      beginTryst(load(a), load(b), locOf(aHome), TRYST_TIME, () => 0);
      trystPass({ ...TRYST_TIME, hour: 21 }, () => 0);
      expect(getAgentIntimacy(b)?.awayNight).toBeUndefined();
    });
  });

  it('runs from the intimacy tick: two mornings, and the confrontation is queued', () => {
    const { p, g, h } = household();
    for (const day of [41, 42]) {
      const t = morningOf(day);
      setClock(t);
      ensureAgentIntimacy(g).awayNight = { since: gameMinutes(t) - 8 * 60, hostId: h };
      intimacyTick(t);
    }
    expect(queued().map((q) => q.participants)).toEqual([[p, g]]);
  });
});
