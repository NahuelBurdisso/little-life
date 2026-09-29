import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  activityLog, agents, conversationQueue, locations, relationshipEvents, relationships, shared_knowledge,
  simSnapshots, worldEvents, worldState,
} from '../../db/schema';
import {
  PROPOSAL_MAX_DAYS, PROPOSAL_MIN_DAYS, PROPOSAL_QUEUE_PRIORITY, WEDDING_DELAY_MINUTES,
  canProposeNow, clearMilestones, deterministicAnswer, getPairMilestone, isWeddingHour, milestonesSnapshotStore,
  milestonesTick, pickProposer, proposalDelayDays, proposalOutcome,
} from '../milestonesEngine';
import { simEvents } from '../simEvents';
import { gameMinutes } from '../gameClock';
import { PROPOSAL_TOPIC } from '../../ai/prompts';
import { MARRIED_AFFAIR_SENSITIVITY } from '../marriage';
import { clearPerWorldCaches, persistedStoreKeys, restoreWorldCaches, saveWorldCaches } from '../../engine/worldCaches';

/**
 * Life milestones: a couple that has been `partners` long enough proposes (an
 * llm_deep conversation), the answer decides engagement or heartbreak, and an
 * engaged couple marries at their own wedding a game day later.
 */

// ─── Pure rules ──────────────────────────────────────────────────────────────

describe('proposal timing', () => {
  it('stays between the min and max game days', () => {
    const eager = proposalDelayDays({ romance: 100, trust: 100, impulsiveness: 100, loyalty: 100 });
    const cautious = proposalDelayDays({ romance: 70, trust: 0, impulsiveness: 0, loyalty: 0 });
    expect(eager).toBeCloseTo(PROPOSAL_MIN_DAYS);
    expect(cautious).toBeCloseTo(PROPOSAL_MAX_DAYS);
    // Out-of-range inputs are clamped, never outside the window.
    expect(proposalDelayDays({ romance: 200, trust: 500, impulsiveness: 300, loyalty: 300 })).toBeGreaterThanOrEqual(PROPOSAL_MIN_DAYS);
    expect(proposalDelayDays({ romance: -50, trust: -100, impulsiveness: -5, loyalty: -5 })).toBeLessThanOrEqual(PROPOSAL_MAX_DAYS);
  });

  it('comes sooner with deeper romance, more trust and a bolder proposer', () => {
    const base = { romance: 80, trust: 40, impulsiveness: 50, loyalty: 50 };
    const d = proposalDelayDays(base);
    expect(proposalDelayDays({ ...base, romance: 95 })).toBeLessThan(d);
    expect(proposalDelayDays({ ...base, trust: 90 })).toBeLessThan(d);
    expect(proposalDelayDays({ ...base, impulsiveness: 90 })).toBeLessThan(d);
  });

  it('the keener, bolder partner proposes; ties go to the lower id', () => {
    expect(pickProposer({ id: 1, romanceToward: 80, impulsiveness: 20 }, { id: 2, romanceToward: 90, impulsiveness: 20 })).toBe(2);
    expect(pickProposer({ id: 1, romanceToward: 80, impulsiveness: 90 }, { id: 2, romanceToward: 85, impulsiveness: 10 })).toBe(1);
    expect(pickProposer({ id: 7, romanceToward: 80, impulsiveness: 50 }, { id: 3, romanceToward: 80, impulsiveness: 50 })).toBe(3);
  });

  it('weddings start in the daytime only', () => {
    expect(isWeddingHour(3)).toBe(false);
    expect(isWeddingHour(9)).toBe(false);
    expect(isWeddingHour(10)).toBe(true);
    expect(isWeddingHour(16)).toBe(true);
    expect(isWeddingHour(17)).toBe(false);
  });
});

describe('proposal outcome mapping', () => {
  const warm = { romance: 85, trust: 60 };
  const cold = { romance: 72, trust: -20 };

  it('reads a plain yes or no from the answer first', () => {
    expect(proposalOutcome({ answerText: 'Yes! Oh, a thousand times yes.', sentiment: -0.5, ...cold }))
      .toEqual({ accepted: true, source: 'answer' });
    expect(proposalOutcome({ answerText: "I'm sorry, Tom. I can't marry you.", sentiment: 0.6, ...warm }))
      .toEqual({ accepted: false, source: 'answer' });
    expect(proposalOutcome({ answerText: 'Of course I will, you silly man.', sentiment: 0, ...cold }))
      .toEqual({ accepted: true, source: 'answer' });
  });

  it('falls back to the exchange sentiment when the answer is mixed or silent', () => {
    // "no one" and "yes" both match: the words don't settle it.
    expect(proposalOutcome({ answerText: "There's no one else I'd rather — yes!", sentiment: 0.5, ...cold }))
      .toEqual({ accepted: true, source: 'sentiment' });
    expect(proposalOutcome({ answerText: 'Oh, Tom...', sentiment: -0.4, ...warm }))
      .toEqual({ accepted: false, source: 'sentiment' });
  });

  it('decides a lukewarm or template exchange by the answerer’s feelings', () => {
    expect(proposalOutcome({ answerText: 'Oh, Tom...', sentiment: 0.05, ...warm })).toEqual({ accepted: true, source: 'relationship' });
    expect(proposalOutcome({ answerText: null, sentiment: null, ...warm })).toEqual({ accepted: true, source: 'relationship' });
    expect(proposalOutcome({ answerText: null, sentiment: null, ...cold })).toEqual({ accepted: false, source: 'relationship' });
    expect(deterministicAnswer(80, 30)).toBe(true);
    expect(deterministicAnswer(75, 0)).toBe(false);
  });
});

describe('canProposeNow', () => {
  const at = (x: number, loc: number | null, type = 'idle') =>
    ({ current_action: { type }, current_location: loc, position: { x, y: 0 } }) as any;

  it('needs both awake, free and together', () => {
    expect(canProposeNow(at(0, 5), at(900, 5))).toBe(true);        // same building
    expect(canProposeNow(at(0, null), at(40, null))).toBe(true);    // side by side outdoors
    expect(canProposeNow(at(0, null), at(400, null))).toBe(false);  // apart
    expect(canProposeNow(at(0, 5, 'sleeping'), at(0, 5))).toBe(false);
    expect(canProposeNow(at(0, 5), at(0, 5, 'talking'))).toBe(false);
  });
});

// ─── Against the DB ──────────────────────────────────────────────────────────

const TIME = { day: 40, hour: 12, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);
const DAY = 24 * 60;

let homeId: number;
let squareId: number;
const made: number[] = [];

function setClock(): void {
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time: TIME, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time: TIME, day_phase: 'afternoon', weather: 'sunny', weather_duration: 120, tick_speed: 1,
    is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
    pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
  }).run();
}

function insertLocation(name: string, type: string): number {
  return db.insert(locations).values({
    name, type, position: { x: 0, y: 0, width: 4, height: 4 }, entry_point: { x: 0, y: 0 },
    capacity: 20, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
}

function insertAgent(name: string, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 22, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  return id;
}

function couple(over: Partial<typeof relationships.$inferInsert> = {}, agentOver: Partial<typeof agents.$inferInsert> = {}) {
  const a = insertAgent(`Suitor ${made.length}`, agentOver);
  const b = insertAgent(`Beloved ${made.length}`, agentOver);
  const relId = db.insert(relationships).values({
    agent_a: a, agent_b: b,
    friendship_ab: 70, friendship_ba: 70, romance_ab: 90, romance_ba: 80,
    trust_ab: 60, trust_ba: 60, familiarity: 80, interaction_count: 40,
    last_interaction: 0, last_interaction_minute: NOW, average_interaction_sentiment: 0.5,
    tags: ['partner'], status: 'partners', status_since_minute: NOW - 10 * DAY,
    created_at: 0, last_updated: 0, ...over,
  }).returning({ id: relationships.id }).get().id;
  return { a, b, relId };
}

const rel = (id: number) => db.select().from(relationships).where(eq(relationships.id, id)).get()!;
const queued = (a: number, b: number) => db.select().from(conversationQueue)
  .where(eq(conversationQueue.trigger_reason, 'proposal')).all()
  .filter((q) => q.participants.includes(a) && q.participants.includes(b));
const feed = (type: string, id: number) => db.select().from(activityLog)
  .where(eq(activityLog.type, type)).all().filter((r) => (r.agent_ids as number[]).includes(id));
const tick = (hour = 12, now = NOW) => milestonesTick({ ...TIME, hour }, now);

/** What conversations.ts emits when an LLM conversation closes, for the proposer. */
function llmEnded(proposer: number, other: number, lines: string[], sentiment = 0, summary = PROPOSAL_TOPIC) {
  simEvents.emit('conversation:ended', {
    agentId: proposer, perpetratorId: other, conversationId: 999_000 + proposer, summary,
    turns: lines.length, sentiment,
    messages: lines.map((text, i) => ({ speakerId: i % 2 === 0 ? proposer : other, text })),
  });
}

describe('milestones against the DB', () => {
  beforeAll(() => {
    setClock();
    homeId = insertLocation('Milestone Cottage', 'home');
    squareId = insertLocation('Milestone Square', 'town_square');
  });

  beforeEach(() => {
    clearMilestones();
    // One wedding at a time: a leftover from an earlier test would block the next.
    db.update(worldEvents).set({ is_active: false }).where(eq(worldEvents.type, 'wedding')).run();
  });

  afterAll(() => {
    db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, 'proposal')).run();
    db.delete(worldEvents).where(eq(worldEvents.type, 'wedding')).run();
    db.delete(shared_knowledge).where(or(inArray(shared_knowledge.subject_id, made), inArray(shared_knowledge.target_id, made))).run();
    db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, made), inArray(relationshipEvents.agent_b, made))).run();
    db.delete(activityLog).where(inArray(activityLog.type, ['proposal', 'engagement', 'rejection', 'wedding', 'engagement_ended'])).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
    db.delete(agents).where(inArray(agents.id, made)).run();
    db.delete(locations).where(inArray(locations.id, [homeId, squareId])).run();
    clearMilestones();
  });

  describe('timing gates', () => {
    it('waits until the couple has been partners for a few game days', () => {
      const { a, b } = couple({ status_since_minute: NOW - 2 * DAY });
      tick();
      expect(getPairMilestone(a, b)).toBeUndefined();
      expect(queued(a, b)).toHaveLength(0);
    });

    it('decides who proposes once they have, then queues the proposal when the two are together', () => {
      // a has 90 romance toward b (b: 80) and equal nerve: a asks.
      const { a, b } = couple({}, { current_location: null });
      db.update(agents).set({ position: { x: 0, y: 0 } }).where(eq(agents.id, a)).run();
      db.update(agents).set({ position: { x: 500, y: 0 } }).where(eq(agents.id, b)).run();
      tick();
      expect(getPairMilestone(a, b)).toMatchObject({ proposerId: a, pendingSince: NOW });
      expect(queued(a, b)).toHaveLength(0); // apart

      db.update(agents).set({ position: { x: 30, y: 0 } }).where(eq(agents.id, b)).run();
      tick();
      const q = queued(a, b);
      expect(q).toHaveLength(1);
      expect(q[0]).toMatchObject({
        participants: [a, b], tier: 'llm_deep', topic: PROPOSAL_TOPIC, priority: PROPOSAL_QUEUE_PRIORITY,
      });
      expect(feed('proposal', a)).toHaveLength(1);

      // Not queued twice while one waits, and announced once.
      tick();
      expect(queued(a, b)).toHaveLength(1);
      expect(feed('proposal', a)).toHaveLength(1);
    });

    it('starts the clock of a pair with no status stamp instead of proposing', () => {
      const { a, b, relId } = couple({ status_since_minute: null });
      tick();
      expect(rel(relId).status_since_minute).toBe(NOW);
      expect(getPairMilestone(a, b)).toBeUndefined();
    });

    it('never has minors or someone already spoken for propose', () => {
      const young = couple({}, { age: 16 });
      tick();
      expect(getPairMilestone(young.a, young.b)).toBeUndefined();

      const { a, b } = couple();
      const third = insertAgent('Spouse Elsewhere');
      db.insert(relationships).values({
        agent_a: Math.min(a, third), agent_b: Math.max(a, third),
        friendship_ab: 50, friendship_ba: 50, romance_ab: 60, romance_ba: 60, trust_ab: 50, trust_ba: 50,
        familiarity: 50, interaction_count: 5, last_interaction: 0, average_interaction_sentiment: 0,
        tags: ['married'], status: 'partners', created_at: 0, last_updated: 0,
      }).run();
      tick();
      expect(getPairMilestone(a, b)).toBeUndefined();
    });

    it('gives up a proposal that never found its moment, and tries again later', () => {
      const { a, b } = couple({}, { current_location: null });
      db.update(agents).set({ position: { x: 900, y: 0 } }).where(eq(agents.id, b)).run();
      tick();
      expect(getPairMilestone(a, b)?.proposerId).toBe(a);
      tick(12, NOW + 19 * 60);
      expect(getPairMilestone(a, b)).toEqual({ retryAfter: NOW + 19 * 60 + DAY });
    });
  });

  describe('outcome', () => {
    function pending() {
      const c = couple();
      tick();
      expect(queued(c.a, c.b)).toHaveLength(1);
      return c;
    }

    it('a yes makes them engaged, with the feed, the news and the timer', () => {
      const { a, b, relId } = pending();
      llmEnded(a, b, ['Will you marry me, dearest?', 'Yes! Yes, of course I will.']);
      expect(rel(relId).tags).toContain('engaged');
      expect(getPairMilestone(a, b)).toEqual({ engagedAt: NOW });
      expect(queued(a, b)).toHaveLength(0);
      expect(feed('engagement', a)).toHaveLength(1);
      const ev = db.select().from(relationshipEvents)
        .where(and(eq(relationshipEvents.agent_a, a), eq(relationshipEvents.event_type, 'proposal'))).get()!;
      expect(ev.romance_delta_ab).toBeGreaterThan(0);
      const fact = db.select().from(shared_knowledge)
        .where(and(eq(shared_knowledge.type, 'engagement'), eq(shared_knowledge.subject_id, a))).get()!;
      expect(fact.sensitivity).toBe(1);
      expect(fact.content).toContain('engaged to be married');
    });

    it('a no breaks the proposer’s heart and keeps them from asking again for a while', () => {
      const { a, b, relId } = pending();
      llmEnded(a, b, ['Will you marry me?', "No. I'm sorry — I can't."], 0.3);
      expect(rel(relId).tags).not.toContain('engaged');
      expect(getPairMilestone(a, b)?.retryAfter).toBeGreaterThan(NOW + 6 * DAY);
      expect(feed('rejection', a)).toHaveLength(1);
      // The proposer's romance drop is past the states phase's heartbreak line (-20).
      const ev = db.select().from(relationshipEvents)
        .where(and(eq(relationshipEvents.agent_a, a), eq(relationshipEvents.event_type, 'proposal'))).get()!;
      expect(ev.romance_delta_ab).toBeLessThan(-20);
      expect(ev.sentiment).toBeLessThan(0);
      const fact = db.select().from(shared_knowledge)
        .where(and(eq(shared_knowledge.type, 'proposal_rejected'), eq(shared_knowledge.subject_id, a))).get()!;
      expect(fact.sensitivity).toBe(2);

      // Still partners and long enough: no new proposal inside the wait.
      tick(12, NOW + 3 * DAY);
      expect(getPairMilestone(a, b)?.proposerId).toBeUndefined();
    });

    it('ignores another LLM conversation the two have meanwhile', () => {
      const { a, b, relId } = pending();
      llmEnded(a, b, ['Lovely weather.', 'Yes, lovely.'], 0.8, 'weather');
      expect(rel(relId).tags).not.toContain('engaged');
      expect(getPairMilestone(a, b)?.proposerId).toBe(a);
    });

    it('a template-tier exchange is decided by the answerer’s feelings', () => {
      const { a, b, relId } = pending();
      // No conversationId: the template path. b's romance 80 / trust 60 toward a → yes.
      simEvents.emit('conversation:ended', { agentId: a, perpetratorId: b, summary: 'small talk', turns: 2, sentiment: 0 });
      expect(rel(relId).tags).toContain('engaged');
      expect(queued(a, b)).toHaveLength(0);
    });

    it('only the proposer’s own event counts', () => {
      const { a, b, relId } = pending();
      llmEnded(b, a, ['Will you?', 'Yes!']);
      expect(rel(relId).tags).not.toContain('engaged');
    });
  });

  describe('wedding', () => {
    function engaged(engagedAgo: number) {
      const c = couple({ tags: ['partner', 'engaged'] });
      milestonesSnapshotStore.restore({ [`${c.a}-${c.b}`]: { engagedAt: NOW - engagedAgo } });
      return c;
    }

    it('holds the couple’s wedding a game day after the engagement, in the daytime', () => {
      const { a, b, relId } = engaged(WEDDING_DELAY_MINUTES + 10);
      tick(3); // small hours: waits
      expect(rel(relId).tags).toContain('engaged');

      tick(12);
      const ev = db.select().from(worldEvents).where(eq(worldEvents.triggered_by, `wedding:${a}-${b}`)).get()!;
      expect(ev).toBeDefined();
      expect(ev.type).toBe('wedding');
      expect(ev.is_active).toBe(true);
      const venue = db.select().from(locations).where(eq(locations.id, ev.location_id!)).get()!;
      expect(venue.type).toBe('town_square');
      const names = db.select({ name: agents.name }).from(agents).where(inArray(agents.id, [a, b])).all().map((r) => r.name);
      expect(ev.name).toBe(`Wedding of ${names[0]} & ${names[1]}`);

      const r = rel(relId);
      expect(r.tags).toContain('married');
      expect(r.tags).not.toContain('engaged');
      expect(getPairMilestone(a, b)).toBeUndefined();
      expect(feed('wedding', a)).toHaveLength(1);
    });

    it('not before the day is up', () => {
      const { relId } = engaged(WEDDING_DELAY_MINUTES - 60);
      tick(12);
      expect(rel(relId).tags).toContain('engaged');
    });

    it('raises an affair either spouse was already known for', () => {
      const { a, b } = engaged(WEDDING_DELAY_MINUTES + 10);
      const lover = insertAgent('Old Flame');
      const factId = Number(db.insert(shared_knowledge).values({
        type: 'affair', subject_id: a, target_id: lover, content: 'test', sensitivity: 3,
        known_by: [lover], created_at: 0, is_active: true, source: 'observed',
      }).run().lastInsertRowid);
      tick(12);
      expect(db.select().from(worldEvents).where(eq(worldEvents.triggered_by, `wedding:${a}-${b}`)).get()).toBeDefined();
      const s = db.select({ s: shared_knowledge.sensitivity }).from(shared_knowledge).where(eq(shared_knowledge.id, factId)).get()!.s;
      expect(s).toBe(MARRIED_AFFAIR_SENSITIVITY);
    });

    it('calls off an engagement when the couple stops being partners', () => {
      const { a, relId } = engaged(10);
      db.update(relationships).set({ status: 'friends' }).where(eq(relationships.id, relId)).run();
      tick(12);
      expect(rel(relId).tags).not.toContain('engaged');
      expect(feed('engagement_ended', a)).toHaveLength(1);
    });
  });

  describe('persistence', () => {
    it('is a registered snapshot store, cleared on a world replace and restored after a restart', () => {
      expect(persistedStoreKeys()).toContain('milestones');
      db.delete(simSnapshots).run();
      milestonesSnapshotStore.restore({ '3-9': { engagedAt: 1234 }, '4-8': { proposerId: 4, pendingSince: 99, announced: true } });
      const before = milestonesSnapshotStore.serialize();
      saveWorldCaches();

      clearPerWorldCaches();
      expect(getPairMilestone(3, 9)).toBeUndefined();

      restoreWorldCaches();
      expect(milestonesSnapshotStore.serialize()).toEqual(before);
      expect(getPairMilestone(9, 3)).toEqual({ engagedAt: 1234 });
    });

    it('restore skips malformed entries', () => {
      milestonesSnapshotStore.restore({
        '1-2': { engagedAt: 'soon' }, 'junk': { engagedAt: 5 }, '5-6': { proposerId: 5 }, '7-8': { retryAfter: 42 },
      });
      expect(milestonesSnapshotStore.serialize()).toEqual({ '7-8': { retryAfter: 42 } });
    });
  });
});
