import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  activityLog, agents, conversationQueue, locations, relationshipEvents, relationships, shared_knowledge,
  simSnapshots, worldEvents, worldState,
} from '../../db/schema';
import {
  PROPOSAL_MAX_DAYS, PROPOSAL_MIN_DAYS, PROPOSAL_PENDING_MINUTES, PROPOSAL_QUEUE_PRIORITY, WEDDING_DELAY_MINUTES,
  PROPOSAL_SEEK_SCORE, canProposeNow, canSeekPartner, clearMilestones, deterministicAnswer, getPairMilestone,
  inNoProposalState, isWeddingHour, milestonesSnapshotStore, milestonesTick, pendingProposalPartner, pickProposer,
  proposalDelayDays, proposalOutcome, queuePendingProposalNow, type SeekParty,
} from '../milestonesEngine';
import { proposalSeekDecision } from '../../engine/systems/decisions';
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

describe('canSeekPartner', () => {
  const free: SeekParty = { action: 'idle', inSleepWindow: false, onShift: false, notNow: false };

  it('goes when both are awake, off shift and free', () => {
    expect(canSeekPartner(free, free)).toBe(true);
    expect(canSeekPartner({ ...free, action: 'walking' }, { ...free, action: 'eating' })).toBe(true);
  });

  it('never wakes anyone or drags them from a conversation', () => {
    for (const action of ['sleeping', 'dead', 'talking']) {
      expect(canSeekPartner({ ...free, action }, free)).toBe(false);
      expect(canSeekPartner(free, { ...free, action })).toBe(false);
    }
    expect(canSeekPartner({ ...free, inSleepWindow: true }, free)).toBe(false);
    expect(canSeekPartner(free, { ...free, inSleepWindow: true })).toBe(false);
  });

  it('respects the workday on both sides', () => {
    expect(canSeekPartner({ ...free, onShift: true }, free)).toBe(false);
    expect(canSeekPartner(free, { ...free, onShift: true })).toBe(false);
    // A partner seen mid-task at the workplace outside their nominal shift is still working.
    expect(canSeekPartner(free, { ...free, action: 'working' })).toBe(false);
  });

  it('waits out a state that rules a proposal out', () => {
    expect(inNoProposalState(['tired', 'heartbroken'])).toBe(true);
    expect(inNoProposalState(['happy'])).toBe(false);
    expect(canSeekPartner({ ...free, notNow: true }, free)).toBe(false);
    expect(canSeekPartner(free, { ...free, notNow: true })).toBe(false);
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
  // A woman and a man by default: 1900 proposals only go to opposite-sex couples (see the same-sex test).
  const a = insertAgent(`Suitor ${made.length}`, { gender: 'female', ...agentOver });
  const b = insertAgent(`Beloved ${made.length}`, { gender: 'male', ...agentOver });
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

    it('never proposes to a same-sex couple: in 1900 they can be partners, but they cannot marry', () => {
      // Everything else says "ready": partners for ten days, keen, together.
      const same = couple({}, { gender: 'male' });
      const mixed = couple();
      tick();
      expect(getPairMilestone(same.a, same.b)).toBeUndefined();
      expect(queued(same.a, same.b)).toHaveLength(0);
      expect(rel(same.relId).status).toBe('partners');
      // ...and the gate is the pair's sex, nothing else: the mixed couple proposes.
      expect(getPairMilestone(mixed.a, mixed.b)).toMatchObject({ proposerId: mixed.a });
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
      tick(12, NOW + 43 * 60);
      expect(getPairMilestone(a, b)).toEqual({ retryAfter: NOW + 43 * 60 + DAY });
    });

    it('keeps a pending proposal alive past a day, so it always spans two evenings', () => {
      // The old 18 h window could end just before the only evening the pair shares: a
      // decision at 23:00 expired at 17:00 the next day, before the 19-22 window.
      expect(PROPOSAL_PENDING_MINUTES).toBe(42 * 60);
      const { a, b } = couple({}, { current_location: null });
      db.update(agents).set({ position: { x: 900, y: 0 } }).where(eq(agents.id, b)).run();
      tick();
      tick(12, NOW + 20 * 60);
      expect(getPairMilestone(a, b)).toMatchObject({ proposerId: a, pendingSince: NOW });
      // ...and the last minute of the window still counts; one past it does not.
      tick(12, NOW + PROPOSAL_PENDING_MINUTES);
      expect(getPairMilestone(a, b)?.proposerId).toBe(a);
      tick(12, NOW + PROPOSAL_PENDING_MINUTES + 10);
      expect(getPairMilestone(a, b)?.proposerId).toBeUndefined();
    });

    it('announces a proposal once, even when it expires and is decided again', () => {
      const { a, b } = couple();
      tick();
      expect(queued(a, b)).toHaveLength(1);
      expect(feed('proposal', a)).toHaveLength(1);

      // The queued conversation never got a slot (the queue gave up on it) and the
      // pending state times out: the retry entry remembers the feed line was written.
      db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, 'proposal')).run();
      const expiredAt = NOW + PROPOSAL_PENDING_MINUTES + 10;
      // The pair is together, so `tick` would seat it again before the window ends;
      // move them apart first so the expiry pass is the one that runs.
      db.update(agents).set({ current_location: squareId, position: { x: 900, y: 0 } }).where(eq(agents.id, b)).run();
      db.update(agents).set({ current_location: homeId, position: { x: 0, y: 0 } }).where(eq(agents.id, a)).run();
      tick(12, expiredAt);
      expect(getPairMilestone(a, b)).toEqual({ retryAfter: expiredAt + DAY, announced: true });
      expect(queued(a, b)).toHaveLength(0);

      // A day later the pair decides again, and the two are together this time.
      db.update(agents).set({ current_location: homeId, position: { x: 0, y: 0 } }).where(eq(agents.id, b)).run();
      const retryAt = expiredAt + DAY + 10;
      tick(12, retryAt);
      expect(getPairMilestone(a, b)).toMatchObject({ proposerId: a, pendingSince: retryAt, announced: true });
      expect(queued(a, b)).toHaveLength(1);
      expect(feed('proposal', a)).toHaveLength(1);
    });

    it('the proposer remembers the question they never got to ask', () => {
      const { a, b } = couple({}, { current_location: null });
      db.update(agents).set({ position: { x: 900, y: 0 } }).where(eq(agents.id, b)).run();
      tick();
      const heard: Array<{ agentId: number; description: string; valence: number; relatedAgentId?: number }> = [];
      // Couples left over from earlier tests are partners in the same DB and expire on the same pass.
      const listener = (m: (typeof heard)[number]) => { if (m.agentId === a) heard.push(m); };
      simEvents.on('life:milestone', listener);
      try {
        tick(12, NOW + 20 * 60);
        expect(heard).toHaveLength(0); // still inside the window: nothing to grieve
        tick(12, NOW + PROPOSAL_PENDING_MINUTES + 10);
      } finally {
        simEvents.off('life:milestone', listener);
      }
      const partner = db.select({ name: agents.name }).from(agents).where(eq(agents.id, b)).get()!.name;
      expect(heard).toHaveLength(1);
      expect(heard[0]).toMatchObject({ agentId: a, relatedAgentId: b, valence: -0.2 });
      expect(heard[0].description).toContain(partner);
      expect(heard[0].description).toContain('marry');
    });
  });

  describe('the proposer goes to find the partner', () => {
    const load = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;

    /** A pending proposal from `a`, the two apart: a in the cottage, b in the square. */
    function pendingApart() {
      const { a, b } = couple({}, { current_location: homeId });
      db.update(agents).set({ current_location: squareId, position: { x: 900, y: 0 } }).where(eq(agents.id, b)).run();
      tick(12);
      expect(getPairMilestone(a, b)?.proposerId).toBe(a);
      expect(queued(a, b)).toHaveLength(0);
      return { a, b };
    }

    it('exposes who a proposer is waiting on, only for the proposer', () => {
      const { a, b } = pendingApart();
      expect(pendingProposalPartner(a)).toBe(b);
      expect(pendingProposalPartner(b)).toBeNull();
      expect(pendingProposalPartner(123_456)).toBeNull();
    });

    it('walks to wherever the partner is, above the day plan and below the wedding', () => {
      const { a, b } = pendingApart();
      const all = db.select().from(locations).all();
      const d = proposalSeekDecision(load(a), load(b), all, 12, [], []);
      expect(d).toMatchObject({
        action: 'socializing', score: PROPOSAL_SEEK_SCORE, targetLocationId: squareId,
        targetAgentId: b, source: 'proposal_seek',
      });
      expect(PROPOSAL_SEEK_SCORE).toBeGreaterThan(6000);
      expect(PROPOSAL_SEEK_SCORE).toBeLessThan(6500);
    });

    it('heads for the square when the partner is out in the open', () => {
      const { a, b } = pendingApart();
      db.update(agents).set({ current_location: null, position: { x: 0, y: 0 } }).where(eq(agents.id, b)).run();
      const all = db.select().from(locations).all();
      expect(proposalSeekDecision(load(a), load(b), all, 12, [], [])?.targetLocationId).toBe(squareId);
    });

    it('holds off during the workday, in bed hours, and while asleep or unwell', () => {
      const { a, b } = couple({}, { current_location: homeId });
      db.update(agents).set({ workplace: squareId }).where(eq(agents.id, a)).run();
      const all = db.select().from(locations).all();
      // Fixture schedule: works 9-17, sleeps 22-6.
      expect(proposalSeekDecision(load(a), load(b), all, 11, [], [])).toBeNull();      // proposer on shift
      expect(proposalSeekDecision(load(a), load(b), all, 18, [], [])).not.toBeNull();  // shift over
      expect(proposalSeekDecision(load(a), load(b), all, 23, [], [])).toBeNull();      // bed hours
      expect(proposalSeekDecision(load(a), load(b), all, 18, ['sick'], [])).toBeNull();
      db.update(agents).set({ current_action: { type: 'sleeping' } }).where(eq(agents.id, b)).run();
      expect(proposalSeekDecision(load(a), load(b), all, 18, [], [])).toBeNull();      // partner asleep
    });

    it('seats the proposal the moment they are together, once', () => {
      const { a, b } = pendingApart();
      expect(queuePendingProposalNow(a)).toBe(false); // still apart
      expect(queued(a, b)).toHaveLength(0);

      db.update(agents).set({ current_location: squareId, position: { x: 900, y: 0 } }).where(eq(agents.id, a)).run();
      expect(queuePendingProposalNow(a)).toBe(true);
      expect(queued(a, b)).toHaveLength(1);
      expect(feed('proposal', a)).toHaveLength(1);

      // Idempotent, and the next 10-minute pass doesn't double it either.
      expect(queuePendingProposalNow(a)).toBe(true);
      tick(12);
      expect(queued(a, b)).toHaveLength(1);
      expect(feed('proposal', a)).toHaveLength(1);
    });

    it('does nothing for someone with no pending proposal, or whose partner is no longer a partner', () => {
      expect(queuePendingProposalNow(424_242)).toBe(false);
      const { a, b, relId } = couple({}, { current_location: homeId });
      tick(12);
      expect(pendingProposalPartner(a)).toBe(b);
      db.update(relationships).set({ status: 'friends' }).where(eq(relationships.id, relId)).run();
      expect(queuePendingProposalNow(a)).toBe(false);
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

    it('a template chat as conversations.ts really emits it (with a conversation id) also decides it', () => {
      const { a, b, relId } = pending();
      // The template tier stores its exchange as a conversation row, so the event
      // carries an id; `template: true` is what says it is not an LLM conversation.
      simEvents.emit('conversation:ended', {
        agentId: a, perpetratorId: b, conversationId: 998_000 + a, template: true,
        summary: 'the weather', turns: 3, sentiment: 0.2,
      });
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

    it('a retry entry keeps its announced flag through a checkpoint, and old checkpoints without it still load', () => {
      milestonesSnapshotStore.restore({
        '3-9': { retryAfter: 500, announced: true },
        '4-8': { retryAfter: 600 },
        // `announced` alone (no timer to hang it on) is not state.
        '5-6': { announced: true },
      });
      expect(milestonesSnapshotStore.serialize()).toEqual({
        '3-9': { retryAfter: 500, announced: true },
        '4-8': { retryAfter: 600 },
      });
      expect(getPairMilestone(3, 9)).toEqual({ retryAfter: 500, announced: true });
      expect(getPairMilestone(4, 8)).toEqual({ retryAfter: 600 });
    });

    it('restore skips malformed entries', () => {
      milestonesSnapshotStore.restore({
        '1-2': { engagedAt: 'soon' }, 'junk': { engagedAt: 5 }, '5-6': { proposerId: 5 }, '7-8': { retryAfter: 42 },
      });
      expect(milestonesSnapshotStore.serialize()).toEqual({ '7-8': { retryAfter: 42 } });
    });
  });
});
