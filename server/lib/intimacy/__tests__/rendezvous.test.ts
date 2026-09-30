import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  agentStates, agents, conversationQueue, locations, needs, relationships, worldState,
} from '../../../db/schema';
import {
  ACCEPT_MIN_WILLINGNESS, INVITE_MIN_WILLINGNESS, RENDEZVOUS_AGREED_MINUTES, RENDEZVOUS_EXPIRED_RETRY_MINUTES,
  RENDEZVOUS_MIN_LONGING, RENDEZVOUS_MIN_LONGING_COUPLE, RENDEZVOUS_PENDING_MINUTES, RENDEZVOUS_QUEUE_PRIORITY,
  RENDEZVOUS_SEEK_SCORE, isRendezvousHour, isRendezvousHourFor, worksEveningShift, longingThreshold, pendingRendezvousPartner, pickRendezvousInitiator,
  queuePendingRendezvousNow, rendezvousPass, willingness, type WillingnessSelf,
} from '../rendezvous';
import { clearIntimacy, ensureAgentIntimacy, getPairIntimacy, updatePairIntimacy } from '../state';
import { KISSED_TAG } from '../kiss';
import { MARRIED_TAG } from '../../marriage';
import { setRuleOverrides } from '../../worldRules';
import { gameMinutes } from '../../gameClock';
import { PROPOSAL_QUEUE_PRIORITY, PROPOSAL_SEEK_SCORE } from '../../milestonesEngine';
import { RENDEZVOUS_TOPIC } from '../../../ai/prompts';
import { rendezvousSeekDecision } from '../../../engine/systems/decisions';

/**
 * Who asks whom, and when. The pure rule (`willingness`) is walked at its truth
 * points; the pass runs against the DB with the adult layer switched on, and the
 * age gate is pinned with the most tempting inputs there are.
 */

// ─── Pure rules ──────────────────────────────────────────────────────────────

const self = (over: Partial<WillingnessSelf> = {}): WillingnessSelf => ({
  romance: 80, trust: 50, longing: 60, impulsiveness: 50, loyalty: 50, morality: 50, spokenForElsewhere: false, ...over,
});
const free = { marriedElsewhere: false };
const alone = { together: false };

describe('willingness', () => {
  it('is romance 0.5 + trust 0.2 + longing 0.3, each scaled 0..1', () => {
    expect(willingness(self(), free, alone)).toBeCloseTo(0.4 + 0.1 + 0.18);
    expect(willingness(self({ romance: 100, trust: 0, longing: 0 }), free, alone)).toBeCloseTo(0.5);
    expect(willingness(self({ romance: 0, trust: 100, longing: 0 }), free, alone)).toBeCloseTo(0.2);
    expect(willingness(self({ romance: 0, trust: 0, longing: 100 }), free, alone)).toBeCloseTo(0.3);
  });

  it('being spoken for elsewhere costs up to 0.35, scaled by loyalty and morality', () => {
    const base = willingness(self(), free, alone);
    expect(willingness(self({ spokenForElsewhere: true, loyalty: 100, morality: 100 }), free, alone)).toBeCloseTo(base - 0.35);
    expect(willingness(self({ spokenForElsewhere: true, loyalty: 50, morality: 50 }), free, alone)).toBeCloseTo(base - 0.175);
    expect(willingness(self({ spokenForElsewhere: true, loyalty: 0, morality: 0 }), free, alone)).toBeCloseTo(base);
    // Not spoken for: character does not matter.
    expect(willingness(self({ loyalty: 100, morality: 100 }), free, alone)).toBeCloseTo(base);
  });

  it('being asked by somebody else\'s husband or wife costs up to 0.2, scaled by morality', () => {
    const base = willingness(self(), free, alone);
    expect(willingness(self({ morality: 100 }), { marriedElsewhere: true }, alone)).toBeCloseTo(base - 0.2);
    expect(willingness(self({ morality: 50 }), { marriedElsewhere: true }, alone)).toBeCloseTo(base - 0.1);
    expect(willingness(self({ morality: 0 }), { marriedElsewhere: true }, alone)).toBeCloseTo(base);
  });

  it('the impulsive (over 70) add 0.15 and a couple who are together 0.25', () => {
    const base = willingness(self(), free, alone);
    expect(willingness(self({ impulsiveness: 71 }), free, alone)).toBeCloseTo(base + 0.15);
    expect(willingness(self({ impulsiveness: 70 }), free, alone)).toBeCloseTo(base);
    expect(willingness(self(), free, { together: true })).toBeCloseTo(base + 0.25);
  });

  it('stays within 0..1', () => {
    expect(willingness(self({ romance: 100, trust: 100, longing: 100, impulsiveness: 100 }), free, { together: true })).toBe(1);
    expect(willingness(
      self({ romance: 0, trust: 0, longing: 0, spokenForElsewhere: true, loyalty: 100, morality: 100 }),
      { marriedElsewhere: true }, alone,
    )).toBe(0);
  });

  it('a faithful spouse tempted by a stranger they barely know says no on character; a lover free of ties says yes', () => {
    expect(willingness(self({ romance: 60, trust: 30, longing: 40, spokenForElsewhere: true, loyalty: 90, morality: 90 }), free, alone))
      .toBeLessThan(ACCEPT_MIN_WILLINGNESS);
    expect(willingness(self({ romance: 75, trust: 50, longing: 55 }), free, alone)).toBeGreaterThanOrEqual(INVITE_MIN_WILLINGNESS);
  });
});

describe('the small rules', () => {
  it('the one who aches more asks; a tie goes to the lower id whatever the order', () => {
    expect(pickRendezvousInitiator({ id: 1, longing: 40 }, { id: 2, longing: 70 }).initiator.id).toBe(2);
    expect(pickRendezvousInitiator({ id: 2, longing: 70 }, { id: 1, longing: 40 }).initiator.id).toBe(2);
    expect(pickRendezvousInitiator({ id: 5, longing: 60 }, { id: 3, longing: 60 }).initiator.id).toBe(3);
    expect(pickRendezvousInitiator({ id: 3, longing: 60 }, { id: 5, longing: 60 }).initiator.id).toBe(3);
  });

  it('a couple needs less longing to ask than two people who are not openly together', () => {
    expect(longingThreshold(false)).toBe(RENDEZVOUS_MIN_LONGING);
    expect(longingThreshold(true)).toBe(RENDEZVOUS_MIN_LONGING_COUPLE);
    expect(RENDEZVOUS_MIN_LONGING_COUPLE).toBeLessThan(RENDEZVOUS_MIN_LONGING);
  });

  it('invitations are made from 19 to 23 h', () => {
    expect([18, 19, 22, 23, 0].map(isRendezvousHour)).toEqual([false, true, true, false, false]);
  });

  // I4c: a partner on the evening shift (the bartender and the musician work until 23 h) used to
  // make the 19-23 window close the moment they were free.
  it('a partner on the evening shift moves the window to when they are off, up to 01:00', () => {
    const at = (shiftEnd: number | null) => [18, 19, 20, 21, 22, 23, 0, 1, 2].map((h) => isRendezvousHourFor(h, shiftEnd));
    expect(at(null)).toEqual([false, true, true, true, true, false, false, false, false]);
    expect(at(23)).toEqual([false, false, false, false, false, true, true, false, false]);
    expect(at(21)).toEqual([false, false, false, true, true, true, true, false, false]);
    // A shift that ends before the evening starts moves nothing but the late edge (still 19 h to 01:00).
    expect(at(17)).toEqual([false, true, true, true, true, true, true, false, false]);
  });

  it('what counts as an evening shift: a workplace and a workEnd of 21 h or later', () => {
    expect(worksEveningShift({ workplace: 3, schedule: { workEnd: 23 } })).toBe(true);
    expect(worksEveningShift({ workplace: 3, schedule: { workEnd: 21 } })).toBe(true);
    expect(worksEveningShift({ workplace: 3, schedule: { workEnd: 20 } })).toBe(false);
    expect(worksEveningShift({ workplace: null, schedule: { workEnd: 23 } })).toBe(false);
    expect(worksEveningShift({ workplace: 3, schedule: null })).toBe(false);
  });

  it('queues at the proposal\'s protected priority and walks below a pending proposal', () => {
    expect(RENDEZVOUS_QUEUE_PRIORITY).toBe(PROPOSAL_QUEUE_PRIORITY);
    expect(RENDEZVOUS_SEEK_SCORE).toBe(6300);
    expect(RENDEZVOUS_SEEK_SCORE).toBeGreaterThan(6000);
    expect(RENDEZVOUS_SEEK_SCORE).toBeLessThan(PROPOSAL_SEEK_SCORE);
  });
});

// ─── Against the DB ──────────────────────────────────────────────────────────

const TIME = { day: 40, hour: 20, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);
const DAY = 24 * 60;

let homeId: number;
let otherHomeId: number;
let squareId: number;
const made: number[] = [];

function setClock(hour = TIME.hour): void {
  const time = { ...TIME, hour };
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time, day_phase: 'evening', weather: 'sunny', weather_duration: 120, tick_speed: 1,
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
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
    },
    sprite_sheet: 'x', portrait_sprite: 'x', position: { x: 0, y: 0 },
    current_action: { type: 'idle' }, action_started: 0, action_queue: [],
    schedule: { wakeTime: 6, sleepTime: 23, workStart: 9, workEnd: 17, lunchTime: 12, freeTimePreferences: [] },
    home: homeId, current_location: homeId, created_at: 0, is_active: true, ...over,
  }).returning({ id: agents.id }).get().id;
  made.push(id);
  db.insert(needs).values({
    agent_id: id, hunger: 60, energy: 60, social: 40, comfort: 50, fun: 40, mood: 55, stress: 20,
    decay_rates: { hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1 },
    thresholds: { critical: 10, low: 30, satisfied: 70 }, mood_modifiers: [], last_updated: 0,
  }).run();
  return id;
}

/**
 * A woman (`a`) and a man (`b`) who have kissed, both keen and trusting, where
 * `a` aches more (longing 70 vs 30). Everything is overridable.
 */
function lovers(opts: {
  romanceA?: number; romanceB?: number; trustA?: number; trustB?: number; longingA?: number; longingB?: number;
  tags?: string[]; status?: string; aOver?: Partial<typeof agents.$inferInsert>; bOver?: Partial<typeof agents.$inferInsert>;
} = {}) {
  const a = insertAgent(`Lover ${made.length}`, { gender: 'female', ...opts.aOver });
  const b = insertAgent(`Beloved ${made.length}`, { gender: 'male', ...opts.bOver });
  const relId = db.insert(relationships).values({
    agent_a: a, agent_b: b,
    friendship_ab: 70, friendship_ba: 70, romance_ab: opts.romanceA ?? 75, romance_ba: opts.romanceB ?? 75,
    trust_ab: opts.trustA ?? 60, trust_ba: opts.trustB ?? 60, familiarity: 80, interaction_count: 40,
    last_interaction: 0, last_interaction_minute: NOW, average_interaction_sentiment: 0.5,
    tags: opts.tags ?? [KISSED_TAG], status: opts.status ?? 'romantic_interest', status_since_minute: NOW - DAY,
    created_at: 0, last_updated: 0,
  }).returning({ id: relationships.id }).get().id;
  ensureAgentIntimacy(a).longing = opts.longingA ?? 70;
  ensureAgentIntimacy(b).longing = opts.longingB ?? 30;
  return { a, b, relId };
}

/** Somewhere else, out of talking range. */
const awayFromHome = () => ({ current_location: otherHomeId, position: { x: 500, y: 0 } });
const queued = (a: number, b: number) => db.select().from(conversationQueue)
  .where(eq(conversationQueue.trigger_reason, 'rendezvous')).all()
  .filter((q) => q.participants.includes(a) && q.participants.includes(b));
const pending = (a: number, b: number) => getPairIntimacy(a, b)?.pendingRendezvous;
const pass = (hour = 20, minuteOffset = 0) => rendezvousPass({ ...TIME, hour, minute: minuteOffset });
const load = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;

describe('the rendezvous pass', () => {
  beforeAll(() => {
    setClock();
    homeId = insertLocation('Rendezvous Cottage', 'home');
    otherHomeId = insertLocation('Rendezvous Farm', 'home');
    squareId = insertLocation('Rendezvous Square', 'town_square');
    setRuleOverrides({ adultContent: true });
  });

  beforeEach(() => {
    clearIntimacy();
    setRuleOverrides({ adultContent: true });
    setClock();
    db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, 'rendezvous')).run();
    // Everyone a previous test made is out of the world.
    db.update(agents).set({ is_active: false }).where(inArray(agents.id, made)).run();
  });

  afterAll(() => {
    setRuleOverrides({ adultContent: false });
    db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, 'rendezvous')).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, made)).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, made), inArray(relationships.agent_b, made))).run();
    db.delete(needs).where(inArray(needs.agent_id, made)).run();
    db.delete(agents).where(inArray(agents.id, made)).run();
    db.delete(locations).where(inArray(locations.id, [homeId, otherHomeId, squareId])).run();
    clearIntimacy();
  });

  describe('who becomes a candidate', () => {
    it('two kissed lovers, keen and trusting, in the evening: the one who aches more asks, and the invitation is queued', () => {
      const { a, b } = lovers({ longingA: 70, longingB: 30 });
      pass();
      expect(pending(a, b)).toEqual({ initiatorId: a, since: NOW });
      const q = queued(a, b);
      expect(q).toHaveLength(1);
      expect(q[0]).toMatchObject({
        participants: [a, b], tier: 'llm_deep', topic: RENDEZVOUS_TOPIC, trigger_reason: 'rendezvous',
        priority: RENDEZVOUS_QUEUE_PRIORITY,
      });
    });

    it('the higher longing is the initiator whichever of them is the lower id', () => {
      const { a, b } = lovers({ longingA: 30, longingB: 70 });
      pass();
      expect(pending(a, b)?.initiatorId).toBe(b);
      expect(queued(a, b)[0].participants).toEqual([b, a]);
    });

    it('apart, the invitation is pending but not queued (the asker walks over: rendezvousSeekDecision)', () => {
      const { a, b } = lovers({ bOver: awayFromHome() });
      pass();
      expect(pending(a, b)?.initiatorId).toBe(a);
      expect(queued(a, b)).toHaveLength(0);
    });

    it('does not run before 19 h or from 23 h', () => {
      const { a, b } = lovers();
      for (const hour of [12, 18, 23, 2]) pass(hour);
      expect(pending(a, b)).toBeUndefined();
    });

    it('an evening-shift partner: not while on shift, from the shift\'s end until 01:00, and not after', () => {
      const evening = { workplace: squareId, schedule: { wakeTime: 10, sleepTime: 1, workStart: 17, workEnd: 23, lunchTime: 14, freeTimePreferences: [] } };
      const { a, b } = lovers({ bOver: evening });
      const reset = () => { clearIntimacy(); ensureAgentIntimacy(a).longing = 70; ensureAgentIntimacy(b).longing = 30; };
      pass(21);
      expect(pending(a, b)).toBeUndefined();
      pass(23);
      expect(pending(a, b)).toMatchObject({ initiatorId: a });
      reset();
      pass(0);
      expect(pending(a, b)).toMatchObject({ initiatorId: a });
      reset();
      pass(1);
      expect(pending(a, b)).toBeUndefined();
    });

    it('two ordinary workers keep the 19-23 window (nothing else moved)', () => {
      const { a, b } = lovers();
      pass(23);
      pass(0);
      expect(pending(a, b)).toBeUndefined();
      pass(22);
      expect(pending(a, b)).toMatchObject({ initiatorId: a });
    });

    it('needs the `kissed` tag', () => {
      const { a, b } = lovers({ tags: [] });
      pass();
      expect(pending(a, b)).toBeUndefined();
    });

    it('needs romance >= 60 and trust >= 25 on both sides', () => {
      for (const opts of [{ romanceA: 59 }, { romanceB: 59 }, { trustA: 24 }, { trustB: 24 }]) {
        const { a, b } = lovers(opts);
        pass();
        expect(pending(a, b), JSON.stringify(opts)).toBeUndefined();
      }
      const { a, b } = lovers({ romanceA: 60, romanceB: 60, trustA: 25, trustB: 25, longingA: 100 });
      pass();
      expect(pending(a, b)).toBeDefined();
    });

    it('needs the asker to ache enough: 55, or 40 for a couple who are openly together', () => {
      const short = lovers({ longingA: 54, longingB: 20 });
      const enough = lovers({ longingA: 55, longingB: 20 });
      const couple = lovers({ longingA: 40, longingB: 20, status: 'partners' });
      const coupleShort = lovers({ longingA: 39, longingB: 20, status: 'partners' });
      pass();
      expect(pending(short.a, short.b)).toBeUndefined();
      expect(pending(enough.a, enough.b)).toBeDefined();
      expect(pending(couple.a, couple.b)).toBeDefined();
      expect(pending(coupleShort.a, coupleShort.b)).toBeUndefined();
    });

    it('needs the asker to think the answer is probably yes (willingness >= 0.55)', () => {
      // Married to somebody else and faithful: 0.65 - 0.35 = 0.30.
      const { a, b } = lovers({
        aOver: {
          personality: {
            honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
            curiosity: 50, loyalty: 100, morality: 100, sensuality: 50, neuroticism: 40,
          },
        },
      });
      const spouse = insertAgent(`Spouse ${made.length}`, { gender: 'male' });
      db.insert(relationships).values({
        agent_a: Math.min(a, spouse), agent_b: Math.max(a, spouse), friendship_ab: 70, friendship_ba: 70,
        romance_ab: 70, romance_ba: 70, trust_ab: 70, trust_ba: 70, familiarity: 80, interaction_count: 40,
        last_interaction: 0, average_interaction_sentiment: 0.5, tags: [MARRIED_TAG], status: 'partners', created_at: 0, last_updated: 0,
      }).run();
      pass();
      expect(pending(a, b)).toBeUndefined();
    });

    it('is off for someone heartbroken, grieving, sick or arrested on either side', () => {
      for (const state of ['heartbroken', 'grieving', 'sick', 'arrested', 'depressed']) {
        const { a, b } = lovers();
        db.insert(agentStates).values({ agent_id: b, type: state, severity: 1, started_at: NOW, duration: 600, source: 'test' }).run();
        pass();
        expect(pending(a, b), state).toBeUndefined();
      }
    });

    it('never starts for a pair that already has an invitation, or that was refused recently', () => {
      const { a, b } = lovers();
      updatePairIntimacy(a, b, (p) => { p.pendingRendezvous = { initiatorId: b, since: NOW - 30 }; });
      pass();
      expect(pending(a, b)).toEqual({ initiatorId: b, since: NOW - 30 });
      expect(queued(a, b)).toHaveLength(0);
    });

    it('does not pick a second partner for someone who already has an invitation out', () => {
      const first = lovers();
      const second = lovers();
      // The first pair's woman also has a second, keener suitor: she gets one invitation, not two.
      const rival = insertAgent(`Rival ${made.length}`, { gender: 'male' });
      db.insert(relationships).values({
        agent_a: Math.min(first.a, rival), agent_b: Math.max(first.a, rival), friendship_ab: 70, friendship_ba: 70,
        romance_ab: 75, romance_ba: 75, trust_ab: 60, trust_ba: 60, familiarity: 80, interaction_count: 40,
        last_interaction: 0, average_interaction_sentiment: 0.5, tags: [KISSED_TAG], status: 'romantic_interest',
        created_at: 0, last_updated: 0,
      }).run();
      ensureAgentIntimacy(rival).longing = 100;
      pass();
      const withFirstWoman = [pending(first.a, first.b), pending(first.a, rival)].filter(Boolean);
      expect(withFirstWoman).toHaveLength(1);
      expect(pending(second.a, second.b)).toBeDefined();
    });
  });

  describe('the retry lock', () => {
    it('no new invitation before rendezvousRetryAfter, then yes', () => {
      const { a, b } = lovers();
      updatePairIntimacy(a, b, (p) => { p.rendezvousRetryAfter = NOW + 2 * DAY; });
      pass();
      expect(pending(a, b)).toBeUndefined();
      updatePairIntimacy(a, b, (p) => { p.rendezvousRetryAfter = NOW - 1; });
      pass();
      expect(pending(a, b)?.initiatorId).toBe(a);
    });
  });

  describe('the age gate and the rule', () => {
    it('minors never become candidates, however keen (romance, trust and longing maxed)', () => {
      const cases: Array<[Partial<typeof agents.$inferInsert>, Partial<typeof agents.$inferInsert>]> = [
        [{ age: 17 }, { age: 30 }],
        [{ age: 30 }, { age: 17 }],
        [{ age: 15 }, { age: 16 }],
        [{ age: 0 }, { age: 30 }],
        [{ age: 17 }, { age: 17 }],
      ];
      for (const [aOver, bOver] of cases) {
        const { a, b } = lovers({ romanceA: 100, romanceB: 100, trustA: 100, trustB: 100, longingA: 100, longingB: 100, aOver, bOver });
        pass();
        expect(pending(a, b), JSON.stringify([aOver, bOver])).toBeUndefined();
        expect(queued(a, b)).toHaveLength(0);
      }
    });

    it('a minor in a married-at-home pair is not agreed either', () => {
      const { a, b } = lovers({ tags: [KISSED_TAG, MARRIED_TAG], status: 'partners', bOver: { age: 17 } });
      pass();
      expect(pending(a, b)).toBeUndefined();
    });

    it('two straight women (or men) are not candidates; a gay pair is', () => {
      const straight = lovers({ bOver: { gender: 'female' } });
      const gay = lovers({
        aOver: { orientation: 'gay' }, bOver: { gender: 'female', orientation: 'gay' },
      });
      pass();
      expect(pending(straight.a, straight.b)).toBeUndefined();
      expect(pending(gay.a, gay.b)).toBeDefined();
    });

    it('with adultContent off nothing starts, however keen', () => {
      setRuleOverrides({ adultContent: false });
      const { a, b } = lovers({ longingA: 100 });
      pass();
      expect(pending(a, b)).toBeUndefined();
      expect(queued(a, b)).toHaveLength(0);
    });

    it('flipping the rule off drops an invitation that was out, with its queued conversation', () => {
      const { a, b } = lovers();
      pass();
      expect(pending(a, b)).toBeDefined();
      expect(queued(a, b)).toHaveLength(1);
      setRuleOverrides({ adultContent: false });
      pass();
      expect(pending(a, b)).toBeUndefined();
      expect(queued(a, b)).toHaveLength(0);
    });
  });

  describe('invitations that never get answered', () => {
    it('an unanswered invitation is dropped after ~3 game hours and the pair tries again tomorrow', () => {
      const { a, b } = lovers({ bOver: awayFromHome() });
      pass();
      expect(pending(a, b)).toBeDefined();
      db.insert(conversationQueue).values({
        participants: [a, b], tier: 'llm_deep', priority: RENDEZVOUS_QUEUE_PRIORITY, trigger_reason: 'rendezvous',
        topic: RENDEZVOUS_TOPIC, queued_at: 0, max_wait: 1000,
      }).run();

      // Just inside the window (22:59, 179 min later): still out, and still queued.
      pass(22, 59);
      expect(pending(a, b)?.since).toBe(NOW);
      expect(queued(a, b)).toHaveLength(1);

      // Past it: dropped, retry locked, queue cleaned. (It is still evening: it must not restart at once.)
      const at = gameMinutes({ ...TIME, hour: 21, minute: 0 });
      updatePairIntimacy(a, b, (p) => { p.pendingRendezvous = { initiatorId: a, since: at - RENDEZVOUS_PENDING_MINUTES - 1 }; });
      pass(21);
      expect(pending(a, b)).toBeUndefined();
      expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBe(at + RENDEZVOUS_EXPIRED_RETRY_MINUTES);
      expect(queued(a, b)).toHaveLength(0);
    });

    it('an agreed evening nobody acted on lapses ~6 game hours later; a fresh one stays', () => {
      const { a, b } = lovers();
      updatePairIntimacy(a, b, (p) => {
        p.pendingRendezvous = { initiatorId: a, since: NOW - 60, agreed: true, agreedAt: NOW - RENDEZVOUS_AGREED_MINUTES + 10 };
      });
      pass();
      expect(pending(a, b)?.agreed).toBe(true);
      updatePairIntimacy(a, b, (p) => {
        p.pendingRendezvous = { initiatorId: a, since: NOW - 60, agreed: true, agreedAt: NOW - RENDEZVOUS_AGREED_MINUTES - 1 };
      });
      pass();
      expect(pending(a, b)).toBeUndefined();
      expect(getPairIntimacy(a, b)?.rendezvousRetryAfter).toBeGreaterThan(NOW);
    });
  });

  describe('married couples at home', () => {
    it('skip the conversation: at home together in the evening they are marked agreed at their home', () => {
      const { a, b } = lovers({ tags: [KISSED_TAG, MARRIED_TAG], status: 'partners', longingA: 45, longingB: 10 });
      pass();
      expect(pending(a, b)).toEqual({ initiatorId: a, since: NOW, venueId: homeId, agreed: true, agreedAt: NOW });
      expect(queued(a, b)).toHaveLength(0);
    });

    it('still need the asker to ache (>= 40) and both to be awake', () => {
      const cold = lovers({ tags: [KISSED_TAG, MARRIED_TAG], status: 'partners', longingA: 39, longingB: 10 });
      const asleep = lovers({ tags: [KISSED_TAG, MARRIED_TAG], status: 'partners', longingA: 60, bOver: { current_action: { type: 'sleeping' } } });
      pass();
      expect(pending(cold.a, cold.b)).toBeUndefined();
      // Asleep: nobody is asked in bed and nothing is agreed (the seek waits, canSeekPartner).
      expect(pending(asleep.a, asleep.b)?.agreed).toBeUndefined();
    });

    it('married but not at home together: they ask like everyone else', () => {
      const away = lovers({ tags: [KISSED_TAG, MARRIED_TAG], status: 'partners', aOver: { current_location: squareId }, bOver: { current_location: squareId } });
      const apart = lovers({ tags: [KISSED_TAG, MARRIED_TAG], status: 'partners', bOver: awayFromHome() });
      pass();
      expect(pending(away.a, away.b)).toEqual({ initiatorId: away.a, since: NOW });
      expect(pending(apart.a, apart.b)).toEqual({ initiatorId: apart.a, since: NOW });
    });

    it('in somebody else\'s home (neither lives there) is not "at home"', () => {
      const { a, b } = lovers({
        tags: [KISSED_TAG, MARRIED_TAG], status: 'partners', aOver: { current_location: otherHomeId }, bOver: { current_location: otherHomeId },
      });
      pass();
      expect(pending(a, b)).toEqual({ initiatorId: a, since: NOW });
    });
  });

  describe('going to find them', () => {
    it('pendingRendezvousPartner is the asker\'s target only, and only while unanswered', () => {
      const { a, b } = lovers({ bOver: awayFromHome() });
      pass();
      expect(pendingRendezvousPartner(a)).toBe(b);
      expect(pendingRendezvousPartner(b)).toBeNull();
      expect(pendingRendezvousPartner(123_456)).toBeNull();
      updatePairIntimacy(a, b, (p) => { p.pendingRendezvous = { initiatorId: a, since: NOW, agreed: true, agreedAt: NOW }; });
      expect(pendingRendezvousPartner(a)).toBeNull();
    });

    it('queuePendingRendezvousNow seats the invitation once the two are together, and only once', () => {
      const { a, b } = lovers({ bOver: awayFromHome() });
      pass();
      expect(queuePendingRendezvousNow(a)).toBe(false); // apart
      expect(queued(a, b)).toHaveLength(0);
      db.update(agents).set({ current_location: homeId }).where(eq(agents.id, b)).run();
      expect(queuePendingRendezvousNow(a)).toBe(true);
      expect(queuePendingRendezvousNow(a)).toBe(true);
      expect(queued(a, b)).toHaveLength(1);
    });

    it('queuePendingRendezvousNow never seats it with the rule off or for a minor', () => {
      const { a, b } = lovers({ bOver: awayFromHome() });
      pass();
      db.update(agents).set({ current_location: homeId }).where(eq(agents.id, b)).run();
      setRuleOverrides({ adultContent: false });
      expect(queuePendingRendezvousNow(a)).toBe(false);
      setRuleOverrides({ adultContent: true });
      db.update(agents).set({ age: 17 }).where(eq(agents.id, b)).run();
      expect(queuePendingRendezvousNow(a)).toBe(false);
      expect(queued(a, b)).toHaveLength(0);
    });

    describe('rendezvousSeekDecision', () => {
      const all = () => db.select().from(locations).all();

      it('walks to wherever the other is, above the day plan and below a proposal', () => {
        const { a, b } = lovers({ bOver: awayFromHome() });
        const d = rendezvousSeekDecision(load(a), load(b), all(), 20, [], []);
        expect(d).toMatchObject({
          action: 'socializing', score: 6300, targetLocationId: otherHomeId, targetAgentId: b, source: 'rendezvous_seek',
        });
      });

      it('heads for the square when the other is out in the open', () => {
        const { a, b } = lovers();
        db.update(agents).set({ current_location: null, position: { x: 0, y: 0 } }).where(eq(agents.id, b)).run();
        expect(rendezvousSeekDecision(load(a), load(b), all(), 20, [], [])?.targetLocationId).toBe(squareId);
      });

      it('has the proposal\'s guards: not in bed hours, while asleep, on shift, or in a state that rules it out', () => {
        const { a, b } = lovers();
        expect(rendezvousSeekDecision(load(a), load(b), all(), 3, [], [])).toBeNull();
        expect(rendezvousSeekDecision(load(a), load(b), all(), 20, ['heartbroken'], [])).toBeNull();
        expect(rendezvousSeekDecision(load(a), load(b), all(), 20, [], ['sick'])).toBeNull();
        db.update(agents).set({ current_action: { type: 'sleeping' } }).where(eq(agents.id, b)).run();
        expect(rendezvousSeekDecision(load(a), load(b), all(), 20, [], [])).toBeNull();
        db.update(agents).set({ current_action: { type: 'idle' }, workplace: squareId }).where(eq(agents.id, b)).run();
        expect(rendezvousSeekDecision(load(a), load(b), all(), 12, [], [])).toBeNull();
      });

      it('is null with the adultContent rule off', () => {
        const { a, b } = lovers();
        setRuleOverrides({ adultContent: false });
        expect(rendezvousSeekDecision(load(a), load(b), all(), 20, [], [])).toBeNull();
      });
    });
  });
});
