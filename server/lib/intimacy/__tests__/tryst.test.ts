import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  activityLog, agentStates, agents, locations, needs, relationshipEvents, relationships, shared_knowledge, worldState,
} from '../../../db/schema';
import {
  SNEAK_WATCH_MINUTES, STAY_MAX_MINUTES, STAY_SEND_HOME_GRACE_MINUTES, TRYST_MAX_MINUTES, TRYST_MIN_MINUTES, TRYST_RETRY_MARRIED_MINUTES,
  TRYST_RETRY_MINUTES, VENUE_RETRY_MINUTES, beginTryst, isDarkHour, isFoulWeather, pickVenue, sleepTargetFor,
  startSneakHome, trystDuration, trystPass, trystStepFor,
} from '../tryst';
import {
  clearIntimacy, ensureAgentIntimacy, getPairIntimacy, getStay, intimacySnapshotStore, setStay, updatePairIntimacy,
} from '../state';
import { MARRIED_TAG } from '../../marriage';
import { setRuleOverrides } from '../../worldRules';
import { gameMinutes } from '../../gameClock';
import { simEvents } from '../../simEvents';
import { renderMessage } from '../../activityMessage';
import { clearPerWorldCaches } from '../../../engine/worldCaches';

/**
 * The private evening: where, who is there, who sleeps where, and who saw. Nothing
 * here (or in the code) narrates the evening itself; what is pinned is the wiring:
 * the age gate and the rule at every entry, the venue rules, the guest's bed,
 * the dawn walk and the witnesses.
 */

// ─── Pure rules ──────────────────────────────────────────────────────────────

describe('the pure rules', () => {
  it('outdoors it is dark from 20 h to before 6 h', () => {
    expect([5, 6, 12, 19, 20, 23, 0].map(isDarkHour)).toEqual([true, false, false, false, true, true, true]);
  });

  it('rain, snow, storms and a storm event are foul; sun, cloud and wind are not', () => {
    expect(['rainy', 'stormy', 'snowy'].map((w) => isFoulWeather(w, false))).toEqual([true, true, true]);
    expect(['sunny', 'cloudy', 'windy'].map((w) => isFoulWeather(w, false))).toEqual([false, false, false]);
    expect(isFoulWeather('sunny', true)).toBe(true);
  });

  it('an evening is 60 to 90 game minutes', () => {
    expect(trystDuration(() => 0)).toBe(TRYST_MIN_MINUTES);
    expect(trystDuration(() => 0.999999)).toBe(TRYST_MAX_MINUTES);
    for (let i = 0; i < 200; i++) {
      const d = trystDuration();
      expect(d).toBeGreaterThanOrEqual(60);
      expect(d).toBeLessThanOrEqual(90);
      expect(Number.isInteger(d)).toBe(true);
    }
  });
});

// ─── Against the DB ──────────────────────────────────────────────────────────

const TIME = { day: 40, hour: 20, minute: 0, totalTicks: 57_600, seasonDay: 10, season: 'spring' };
const NOW = gameMinutes(TIME);
const DAY = 24 * 60;
/** The clock `minutes` game minutes after the tryst's evening began (20:00 of day 40). */
const at = (minutes: number) => {
  const total = NOW + minutes;
  const rem = total % DAY;
  return { ...TIME, day: Math.floor(total / DAY), hour: Math.floor(rem / 60), minute: rem % 60 };
};

const madeAgents: number[] = [];
const madeLocations: number[] = [];

function setClock(hour = TIME.hour, weather = 'sunny'): void {
  const time = { ...TIME, hour };
  const existing = db.select().from(worldState).get();
  if (existing) {
    db.update(worldState).set({ time, weather, tick_speed: 1 }).where(eq(worldState.id, existing.id)).run();
    return;
  }
  db.insert(worldState).values({
    time, day_phase: 'evening', weather, weather_duration: 120, tick_speed: 1,
    is_paused: true, last_tick_completed: 0, current_tick_phase: 0, tick_id: 'test',
    pending_transitions: [], tax_pool: 0, map_width: 40, map_height: 30, collision_grid: '',
  }).run();
}

function insertLocation(name: string, type: string, x = 0, y = 0): number {
  const id = db.insert(locations).values({
    name, type, position: { x, y, width: 96, height: 96 }, entry_point: { x, y: y + 96 },
    capacity: 20, current_occupants: [], services: [], description: 'test',
  }).returning({ id: locations.id }).get().id;
  madeLocations.push(id);
  return id;
}

function insertAgent(name: string, home: number, over: Partial<typeof agents.$inferInsert> = {}): number {
  const id = db.insert(agents).values({
    name, bio: 'test', traits: [], age: 30, gender: 'female', orientation: 'straight',
    personality: {
      honesty: 50, aggression: 30, warmth: 60, impulsiveness: 50, vanity: 40,
      curiosity: 50, loyalty: 60, morality: 60, sensuality: 50, neuroticism: 40,
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

const load = (id: number) => db.select().from(agents).where(eq(agents.id, id)).get()!;
const locOf = (id: number) => db.select().from(locations).where(eq(locations.id, id)).get()!;

function marry(x: number, y: number): void {
  db.insert(relationships).values({
    agent_a: Math.min(x, y), agent_b: Math.max(x, y), friendship_ab: 70, friendship_ba: 70,
    romance_ab: 80, romance_ba: 80, trust_ab: 70, trust_ba: 70, familiarity: 80, interaction_count: 40,
    last_interaction: 0, average_interaction_sentiment: 0.5, tags: [MARRIED_TAG], status: 'partners',
    created_at: 0, last_updated: 0,
  }).run();
}

/**
 * A woman (`a`) and a man (`b`), each in a home of their own, `a` in hers with
 * `b` (the guest) standing beside her. Everyone else is elsewhere.
 */
function lovers(over: { aOver?: Partial<typeof agents.$inferInsert>; bOver?: Partial<typeof agents.$inferInsert> } = {}) {
  const aHome = insertLocation(`Cottage ${madeLocations.length}`, 'home', 200);
  const bHome = insertLocation(`Farmhouse ${madeLocations.length}`, 'home', 400);
  const a = insertAgent(`Lover ${madeAgents.length}`, aHome, { gender: 'female', ...over.aOver });
  const b = insertAgent(`Beloved ${madeAgents.length}`, bHome, { gender: 'male', current_location: aHome, ...over.bOver });
  return { a, b, aHome, bHome };
}

const agree = (a: number, b: number, extra: { venueId?: number } = {}) =>
  updatePairIntimacy(a, b, (p) => {
    p.pendingRendezvous = { initiatorId: a, since: NOW - 10, agreed: true, agreedAt: NOW - 10, ...extra };
  });

function captureEvents<T>(name: string): { seen: T[]; stop: () => void } {
  const seen: T[] = [];
  const fn = (p: T) => { seen.push(p); };
  simEvents.on(name, fn);
  return { seen, stop: () => simEvents.off(name, fn) };
}

const factsOf = (subject: number) => db.select().from(shared_knowledge)
  .where(and(eq(shared_knowledge.subject_id, subject), eq(shared_knowledge.type, 'tryst_seen'))).all();
const rowsOf = (type: string, initiator: number) => db.select().from(activityLog)
  .where(and(eq(activityLog.type, type), eq(activityLog.initiator_id, initiator))).all();

describe('the tryst', () => {
  beforeAll(() => {
    setClock();
    setRuleOverrides({ adultContent: true });
  });

  beforeEach(() => {
    clearIntimacy();
    setRuleOverrides({ adultContent: true });
    setClock();
    // Everyone a previous test made is out of the world (the venue rules look at all residents).
    if (madeAgents.length) db.update(agents).set({ is_active: false }).where(inArray(agents.id, madeAgents)).run();
    // ...and so is every barn and grove (retyped: agents point at them), or an earlier test's would win "the nearest".
    const outdoors = db.select({ id: locations.id, type: locations.type }).from(locations).all()
      .filter((l) => madeLocations.includes(l.id) && (l.type === 'farm' || l.type === 'park'));
    if (outdoors.length) db.update(locations).set({ type: 'shed' }).where(inArray(locations.id, outdoors.map((l) => l.id))).run();
  });

  afterAll(() => {
    setRuleOverrides({ adultContent: false });
    db.delete(shared_knowledge).where(inArray(shared_knowledge.subject_id, madeAgents)).run();
    db.delete(activityLog).where(inArray(activityLog.initiator_id, madeAgents)).run();
    db.delete(agentStates).where(inArray(agentStates.agent_id, madeAgents)).run();
    db.delete(relationshipEvents).where(or(inArray(relationshipEvents.agent_a, madeAgents), inArray(relationshipEvents.agent_b, madeAgents))).run();
    db.delete(relationships).where(or(inArray(relationships.agent_a, madeAgents), inArray(relationships.agent_b, madeAgents))).run();
    db.delete(needs).where(inArray(needs.agent_id, madeAgents)).run();
    db.delete(agents).where(inArray(agents.id, madeAgents)).run();
    db.delete(locations).where(inArray(locations.id, madeLocations)).run();
    clearIntimacy();
  });

  // ─── Where ────────────────────────────────────────────────────────────────

  describe('pickVenue', () => {
    const fair = { hour: 21, foulWeather: false };

    it('the asker\'s own home when nobody else lives there or is there', () => {
      const { a, b, aHome } = lovers();
      expect(pickVenue(load(a), load(b), fair)).toEqual({ locationId: aHome, outdoors: false });
    });

    it('a spouse or housemate at the asker\'s home blocks it (they will be in tonight): the other\'s home instead', () => {
      const { a, b, aHome, bHome } = lovers();
      insertAgent(`Housemate ${madeAgents.length}`, aHome, { current_location: null, gender: 'male' });
      expect(pickVenue(load(a), load(b), fair)).toEqual({ locationId: bHome, outdoors: false });
    });

    it('somebody visiting a home (living elsewhere) blocks it too', () => {
      const { a, b, aHome, bHome } = lovers();
      const neighbourHome = insertLocation('Neighbour', 'home', 600);
      insertAgent(`Visitor ${madeAgents.length}`, neighbourHome, { current_location: aHome });
      expect(pickVenue(load(a), load(b), fair)).toEqual({ locationId: bHome, outdoors: false });
    });

    describe('with both homes taken', () => {
      function bothBlocked() {
        const l = lovers();
        insertAgent(`Mother ${madeAgents.length}`, l.aHome, { current_location: null });
        insertAgent(`Father ${madeAgents.length}`, l.bHome, { current_location: null });
        return l;
      }

      it('a barn or grove in the dark and fair weather', () => {
        const { a, b } = bothBlocked();
        const barn = insertLocation('Old Farm', 'farm', 500);
        expect(pickVenue(load(a), load(b), fair)).toEqual({ locationId: barn, outdoors: true });
      });

      it('the nearer of two outdoor places', () => {
        const { a, b } = bothBlocked();
        const far = insertLocation('Far Farm', 'farm', 5000);
        const near = insertLocation('Near Grove', 'park', 300);
        const choice = pickVenue(load(a), load(b), fair);
        expect(choice).toEqual({ locationId: near, outdoors: true });
        expect(choice).not.toMatchObject({ locationId: far });
      });

      it('rain, snow or a storm: nowhere (the evening is dropped)', () => {
        const { a, b } = bothBlocked();
        insertLocation('Rainy Farm', 'farm', 500);
        expect(pickVenue(load(a), load(b), { hour: 21, foulWeather: true })).toBeNull();
      });

      it('before dark it waits instead of failing', () => {
        const { a, b } = bothBlocked();
        insertLocation('Bright Farm', 'farm', 500);
        expect(pickVenue(load(a), load(b), { hour: 19, foulWeather: false })).toBe('wait');
      });

      it('no barn or grove in town: nowhere', () => {
        const { a, b } = bothBlocked();
        // Anything a previous test left standing is out of the way.
        const stray = db.select({ id: locations.id, type: locations.type }).from(locations).all()
          .filter((l) => l.type === 'farm' || l.type === 'park');
        expect(stray.every((l) => madeLocations.includes(l.id))).toBe(true);
        db.update(locations).set({ type: 'shed' }).where(inArray(locations.id, stray.map((l) => l.id))).run();
        expect(pickVenue(load(a), load(b), fair)).toBeNull();
      });
    });
  });

  // ─── Beginning ────────────────────────────────────────────────────────────

  describe('beginning', () => {
    it('both at the venue: both start the private evening, the pending is consumed, the pair is held back', () => {
      const { a, b, aHome } = lovers();
      agree(a, b, { venueId: aHome });
      const started = captureEvents<{ a: number; b: number; venueId: number; secret: boolean }>('intimacy:tryst');
      try {
        expect(beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0)).toBe(true);
      } finally { started.stop(); }

      for (const [id, partner] of [[a, b], [b, a]] as const) {
        const row = load(id);
        expect(row.current_action).toMatchObject({ type: 'idle', zoneActivity: 'tryst', partnerId: partner });
        expect(row.action_started).toBe(NOW);
        expect(row.action_duration).toBe(60);
        expect(row.current_destination).toBeNull();
      }
      const pair = getPairIntimacy(a, b)!;
      expect(pair.pendingRendezvous).toBeUndefined();
      expect(pair.trysts).toBe(1);
      expect(pair.firstTrystAt).toBe(NOW);
      expect(pair.lastTrystAt).toBe(NOW);
      expect(pair.rendezvousRetryAfter).toBe(NOW + TRYST_RETRY_MINUTES);
      expect(pair.activeTryst).toEqual({ venueId: aHome, startedAt: NOW, endsAt: NOW + 60, secret: false });
      expect(started.seen).toEqual([{ a, b, venueId: aHome, secret: false }]);

      // The feed says one discreet thing.
      const rows = rowsOf('tryst', a);
      expect(rows).toHaveLength(1);
      expect(rows[0].template_data).toMatchObject({ agent1: load(a).name, agent2: load(b).name, venue: locOf(aHome).name });
      expect(rows[0].metadata).toEqual({ beat: 'tryst' });
      expect(rows[0].location_id).toBe(aHome);
    });

    it('lasts 60 to 90 game minutes', () => {
      for (const [rng, minutes] of [[() => 0, 60], [() => 0.999999, 90]] as const) {
        const { a, b, aHome } = lovers();
        beginTryst(load(a), load(b), locOf(aHome), TIME, rng);
        expect(load(a).action_duration).toBe(minutes);
        expect(load(b).action_duration).toBe(minutes);
        expect(getPairIntimacy(a, b)!.activeTryst!.endsAt).toBe(NOW + minutes);
      }
    });

    it('the guest gets a bed at the host\'s house; the host does not need one', () => {
      const { a, b, aHome } = lovers();
      beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0);
      expect(getStay(b)).toEqual({ locationId: aHome, hostId: a, until: NOW + STAY_MAX_MINUTES, seenBy: [] });
      expect(getStay(a)).toBeUndefined();
    });

    it('a couple who both live at the venue need no stay', () => {
      const { a, b, aHome } = lovers({ bOver: {} });
      db.update(agents).set({ home: aHome }).where(eq(agents.id, b)).run();
      beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0);
      expect(getStay(a)).toBeUndefined();
      expect(getStay(b)).toBeUndefined();
    });

    it('a married couple may be together again sooner than an unmarried pair', () => {
      const { a, b, aHome } = lovers();
      db.update(agents).set({ home: aHome }).where(eq(agents.id, b)).run();
      marry(a, b);
      beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0);
      expect(getPairIntimacy(a, b)!.rendezvousRetryAfter).toBe(NOW + TRYST_RETRY_MARRIED_MINUTES);
      expect(TRYST_RETRY_MARRIED_MINUTES).toBeLessThan(TRYST_RETRY_MINUTES);
      expect(getPairIntimacy(a, b)!.secret).toBe(false);
    });

    it('the event says `secret` when either is spoken for to a third, or the pair is same-sex, and marks the pair', () => {
      // A married man (b) with a woman who is not his wife.
      const cheating = lovers();
      const wife = insertAgent(`Wife ${madeAgents.length}`, cheating.bHome, { gender: 'female', current_location: cheating.bHome });
      marry(cheating.b, wife);
      // Two men.
      const men = lovers({ aOver: { gender: 'male', orientation: 'gay' }, bOver: { gender: 'male', orientation: 'gay' } });
      const seen = captureEvents<{ a: number; b: number; secret: boolean }>('intimacy:tryst');
      try {
        beginTryst(load(cheating.a), load(cheating.b), locOf(cheating.aHome), TIME, () => 0);
        beginTryst(load(men.a), load(men.b), locOf(men.aHome), TIME, () => 0);
      } finally { seen.stop(); }
      expect(seen.seen.map((e) => e.secret)).toEqual([true, true]);
      expect(getPairIntimacy(cheating.a, cheating.b)!.secret).toBe(true);
      expect(getPairIntimacy(men.a, men.b)!.secret).toBe(true);
    });

    it('never with the adultContent rule off', () => {
      const { a, b, aHome } = lovers();
      agree(a, b, { venueId: aHome });
      setRuleOverrides({ adultContent: false });
      expect(beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0)).toBe(false);
      expect(getPairIntimacy(a, b)!.trysts).toBe(0);
      expect(load(a).current_action).toEqual({ type: 'idle' });
      expect(getStay(b)).toBeUndefined();
      expect(rowsOf('tryst', a)).toHaveLength(0);
    });

    it('never for anyone under 18, built directly with the most tempting inputs there are', () => {
      for (const age of [17, 16, 12, 0, -1]) {
        const { a, b, aHome } = lovers({ bOver: { age } });
        agree(a, b, { venueId: aHome });
        ensureAgentIntimacy(a).longing = 100;
        ensureAgentIntimacy(b).longing = 100;
        expect(beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0), `age ${age}`).toBe(false);
        expect(getPairIntimacy(a, b)!.trysts).toBe(0);
        expect(getPairIntimacy(a, b)!.activeTryst).toBeUndefined();
        expect(getStay(b)).toBeUndefined();
        expect(load(b).current_action).toEqual({ type: 'idle' });
        expect(rowsOf('tryst', a)).toHaveLength(0);
      }
    });

    it('never for a pair whose orientations do not meet', () => {
      const { a, b, aHome } = lovers({ bOver: { gender: 'female' } });
      expect(beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0)).toBe(false);
    });
  });

  // ─── The pass ─────────────────────────────────────────────────────────────

  describe('trystPass', () => {
    it('an agreed evening with no venue gets the asker\'s home, and starts once both are there', () => {
      const { a, b, aHome } = lovers();
      agree(a, b);
      trystPass(TIME, () => 0);
      const pair = getPairIntimacy(a, b)!;
      expect(pair.trysts).toBe(1);
      expect(pair.pendingRendezvous).toBeUndefined();
      expect(pair.activeTryst).toMatchObject({ venueId: aHome });
      expect(load(b).current_action).toMatchObject({ zoneActivity: 'tryst', partnerId: a });
    });

    it('picks the venue but waits while one of them has not arrived', () => {
      const { a, b, aHome, bHome } = lovers();
      db.update(agents).set({ current_location: bHome }).where(eq(agents.id, b)).run();
      agree(a, b);
      trystPass(TIME, () => 0);
      const pair = getPairIntimacy(a, b)!;
      expect(pair.pendingRendezvous).toMatchObject({ agreed: true, venueId: aHome });
      expect(pair.trysts).toBe(0);
      expect(load(a).current_action).toEqual({ type: 'idle' });
    });

    it('waits while one of them is talking, asleep or on the road', () => {
      for (const type of ['talking', 'sleeping', 'walking']) {
        const { a, b, aHome } = lovers();
        db.update(agents).set({ current_action: { type } }).where(eq(agents.id, b)).run();
        agree(a, b, { venueId: aHome });
        trystPass(TIME, () => 0);
        expect(getPairIntimacy(a, b)!.trysts, type).toBe(0);
      }
    });

    it('waits while one of them is in no state for it (sick, grieving...)', () => {
      const { a, b, aHome } = lovers();
      db.insert(agentStates).values({ agent_id: b, type: 'sick', severity: 1, started_at: NOW, duration: 600, source: 'test' }).run();
      agree(a, b, { venueId: aHome });
      trystPass(TIME, () => 0);
      expect(getPairIntimacy(a, b)!.trysts).toBe(0);
      expect(getPairIntimacy(a, b)!.pendingRendezvous).toBeDefined();
    });

    it('nowhere to be alone: the evening is dropped and the pair asks again tomorrow', () => {
      const { a, b, aHome, bHome } = lovers();
      insertAgent(`Mother ${madeAgents.length}`, aHome, { current_location: null });
      insertAgent(`Father ${madeAgents.length}`, bHome, { current_location: null });
      setClock(21, 'rainy');
      insertLocation('Rained-on Farm', 'farm', 500);
      agree(a, b);
      trystPass(at(60), () => 0);
      const pair = getPairIntimacy(a, b)!;
      expect(pair.pendingRendezvous).toBeUndefined();
      expect(pair.rendezvousRetryAfter).toBe(NOW + 60 + VENUE_RETRY_MINUTES);
      expect(pair.trysts).toBe(0);
    });

    it('a barn in the dark and fair weather: both walk there (decisions tier) and it starts when both are in it', () => {
      const { a, b, aHome, bHome } = lovers();
      insertAgent(`Mother ${madeAgents.length}`, aHome, { current_location: null });
      insertAgent(`Father ${madeAgents.length}`, bHome, { current_location: null });
      const barn = insertLocation('Dark Farm', 'farm', 500);
      agree(a, b);
      trystPass(TIME, () => 0);
      expect(getPairIntimacy(a, b)!.pendingRendezvous).toMatchObject({ agreed: true, venueId: barn });
      // Not there yet: nothing has started.
      expect(getPairIntimacy(a, b)!.trysts).toBe(0);
      db.update(agents).set({ current_location: barn }).where(inArray(agents.id, [a, b])).run();
      trystPass(TIME, () => 0);
      expect(getPairIntimacy(a, b)!.trysts).toBe(1);
      expect(getStay(a)).toBeUndefined();
      expect(getStay(b)).toBeUndefined();
    });

    it('a minor pair (built directly): the agreed evening is cancelled, not started', () => {
      const { a, b, aHome } = lovers({ bOver: { age: 16 } });
      agree(a, b, { venueId: aHome });
      trystPass(TIME, () => 0);
      const pair = getPairIntimacy(a, b)!;
      expect(pair.pendingRendezvous).toBeUndefined();
      expect(pair.trysts).toBe(0);
      expect(load(b).current_action).toEqual({ type: 'idle' });
    });

    it('with the rule off everything the layer had going is cancelled: evening, stay', () => {
      const { a, b, aHome } = lovers();
      beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0);
      expect(getPairIntimacy(a, b)!.activeTryst).toBeDefined();
      expect(getStay(b)).toBeDefined();
      setRuleOverrides({ adultContent: false });
      trystPass(TIME);
      expect(getPairIntimacy(a, b)!.activeTryst).toBeUndefined();
      expect(getStay(b)).toBeUndefined();
    });

    it('an evening ends when its time is up, once', () => {
      const { a, b, aHome } = lovers();
      beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0);
      trystPass(at(30), () => 0);
      expect(getPairIntimacy(a, b)!.activeTryst).toBeDefined();
      trystPass(at(60), () => 0);
      expect(getPairIntimacy(a, b)!.activeTryst).toBeUndefined();
      expect(getPairIntimacy(a, b)!.trysts).toBe(1);
    });
  });

  // ─── The night ────────────────────────────────────────────────────────────

  describe('the guest\'s bed', () => {
    const guestAtVenue = () => {
      const l = lovers();
      setStay(l.b, { locationId: l.aHome, hostId: l.a, until: NOW + STAY_MAX_MINUTES });
      return l;
    };

    it('sleepTargetFor is the venue tonight for the guest, their own home for everyone else', () => {
      const { a, b, aHome, bHome } = guestAtVenue();
      expect(sleepTargetFor(load(b), NOW)).toBe(aHome);
      expect(sleepTargetFor(load(a), NOW)).toBe(aHome);
      const other = lovers();
      expect(sleepTargetFor(load(other.b), NOW)).toBe(other.bHome);
      expect(bHome).not.toBe(aHome);
    });

    it('goes back to their own home once they are told to leave, have left, the stay lapses or the rule is off', () => {
      const { b, aHome, bHome } = guestAtVenue();
      const cases: Array<[string, () => void]> = [
        ['leaving', () => setStay(b, { locationId: aHome, hostId: 0, until: NOW + 999, leaving: true })],
        ['left', () => setStay(b, { locationId: aHome, hostId: 0, until: NOW + 999, leftAt: NOW })],
        ['lapsed', () => setStay(b, { locationId: aHome, hostId: 0, until: NOW - 1 })],
      ];
      for (const [name, arrange] of cases) {
        arrange();
        expect(sleepTargetFor(load(b), NOW), name).toBe(bHome);
      }
      setStay(b, { locationId: aHome, hostId: 0, until: NOW + 999 });
      expect(sleepTargetFor(load(b), NOW)).toBe(aHome);
      setRuleOverrides({ adultContent: false });
      expect(sleepTargetFor(load(b), NOW)).toBe(bHome);
    });

    it('after the evening: the guest stays awake at the house until bedtime, then sleeps there', () => {
      const { a, b, aHome } = guestAtVenue();
      const tryst = { type: 'idle', zoneActivity: 'tryst', partnerId: a };
      db.update(agents).set({ current_action: tryst }).where(inArray(agents.id, [a, b])).run();
      expect(trystStepFor(load(b), { awake: true })).toEqual({ kind: 'stay', locationId: aHome });
      expect(trystStepFor(load(b), { awake: false })).toEqual({ kind: 'sleep', locationId: aHome });
      // The host: bed at bedtime, otherwise the day as usual.
      expect(trystStepFor(load(a), { awake: false })).toEqual({ kind: 'sleep', locationId: aHome });
      expect(trystStepFor(load(a), { awake: true })).toBeNull();
    });

    it('an outdoor evening: both go home, hushed, and neither has a stay', () => {
      const { a, b, aHome, bHome } = lovers();
      const barn = insertLocation('Quiet Farm', 'farm', 500);
      db.update(agents).set({ current_location: barn, current_action: { type: 'idle', zoneActivity: 'tryst', partnerId: b } })
        .where(eq(agents.id, a)).run();
      db.update(agents).set({ current_location: barn, current_action: { type: 'idle', zoneActivity: 'tryst', partnerId: a } })
        .where(eq(agents.id, b)).run();
      expect(trystStepFor(load(a), { awake: false })).toEqual({ kind: 'sneak_home', locationId: aHome, dawn: false });
      expect(trystStepFor(load(b), { awake: true })).toEqual({ kind: 'sneak_home', locationId: bHome, dawn: false });
    });
  });

  // ─── Dawn ─────────────────────────────────────────────────────────────────

  describe('dawn', () => {
    /** The guest asleep at the host's house since the night. */
    function morningAfter(over: Parameters<typeof lovers>[0] = {}) {
      const l = lovers(over);
      setStay(l.b, { locationId: l.aHome, hostId: l.a, until: NOW + STAY_MAX_MINUTES });
      db.update(agents).set({ current_action: { type: 'sleeping' } }).where(inArray(agents.id, [l.a, l.b])).run();
      return l;
    }

    it('awake again, the guest\'s first move is the walk home; still inside their sleep window they sleep on', () => {
      const { b, bHome, aHome } = morningAfter();
      expect(trystStepFor(load(b), { awake: false })).toEqual({ kind: 'sleep', locationId: aHome });
      expect(trystStepFor(load(b), { awake: true })).toEqual({ kind: 'sneak_home', locationId: bHome, dawn: true });
    });

    it('a guest seen asleep still walks home at dawn when another tier took the wake-up decision', () => {
      const { b, bHome } = morningAfter();
      // The pass sees them asleep in the house at night...
      trystPass(at(60), () => 0);
      expect(getStay(b)!.slept).toBe(true);
      // ...and by morning a higher-scoring decision (a meal) has replaced 'sleeping'.
      db.update(agents).set({ current_action: { type: 'eating' } }).where(eq(agents.id, b)).run();
      expect(trystStepFor(load(b), { awake: true })).toEqual({ kind: 'sneak_home', locationId: bHome, dawn: true });
    });

    it('the tryst step itself remembers a guest it saw asleep, and an awake guest who never slept is not sent home', () => {
      const l = lovers();
      setStay(l.b, { locationId: l.aHome, hostId: l.a, until: NOW + STAY_MAX_MINUTES });
      db.update(agents).set({ current_action: { type: 'idle' } }).where(eq(agents.id, l.b)).run();
      expect(trystStepFor(load(l.b), { awake: true })).toEqual({ kind: 'stay', locationId: l.aHome });
      expect(getStay(l.b)!.slept).toBeUndefined();
      db.update(agents).set({ current_action: { type: 'sleeping' } }).where(eq(agents.id, l.b)).run();
      trystStepFor(load(l.b), { awake: false });
      expect(getStay(l.b)!.slept).toBe(true);
    });

    it('a stay that lapses with the guest still in the house sends them home instead of forgetting them', () => {
      const { b, bHome } = morningAfter();
      const past = at(STAY_MAX_MINUTES + 10);
      trystPass(past, () => 0);
      expect(getStay(b)!.leaving).toBe(true);
      expect(trystStepFor(load(b), { awake: true })).toEqual({ kind: 'sneak_home', locationId: bHome, dawn: true });
      // Nobody picks it up: after the grace window it is finally dropped.
      trystPass(at(STAY_MAX_MINUTES + 10 + STAY_SEND_HOME_GRACE_MINUTES + 10), () => 0);
      expect(getStay(b)).toBeUndefined();
    });

    it('starting the walk clears the sleepover (the bed is their own again) and stamps the time', () => {
      const { b, bHome } = morningAfter();
      startSneakHome(b, NOW + 600);
      expect(getStay(b)!.leftAt).toBe(NOW + 600);
      expect(sleepTargetFor(load(b), NOW + 600)).toBe(bHome);
      // It is not a second dawn: they are already on their way.
      expect(trystStepFor(load(b), { awake: true })).toBeNull();
    });

    it('somebody awake at the house sees them go: a tryst_seen secret, a caught row and event', () => {
      const { a, b, aHome } = morningAfter();
      const neighbourHome = insertLocation('Snoop Cottage', 'home', 700);
      const snoop = insertAgent(`Snoop ${madeAgents.length}`, neighbourHome, { current_location: aHome });
      const caught = captureEvents<{ a: number; b: number; witnessId: number }>('intimacy:caught');
      try {
        startSneakHome(b, NOW + 600);
      } finally { caught.stop(); }

      // The guest was seen (subject) leaving the host's house (target); the pair's own knowers are not in it.
      const facts = factsOf(b);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ target_id: a, sensitivity: 3, known_by: [snoop] });
      expect(facts[0].content).toContain('leaving');
      expect(facts[0].content).toContain('at dawn');
      const rows = rowsOf('caught', b);
      expect(rows).toHaveLength(1);
      expect(rows[0].target_id).toBe(a);
      expect(rows[0].template_data).toMatchObject({ witness: load(snoop).name, agent1: load(b).name, agent2: load(a).name });
      expect(rows[0].metadata).toEqual({ beat: 'caught' });
      expect(caught.seen).toEqual([{ a: b, b: a, witnessId: snoop }]);
    });

    it('once somebody has seen, the pair is no longer a secret', () => {
      const { a, b, aHome } = morningAfter();
      updatePairIntimacy(a, b, (p) => { p.secret = true; });
      startSneakHome(b, NOW + 600);
      // Nobody about: still hidden.
      expect(getPairIntimacy(a, b)!.secret).toBe(true);
      const neighbourHome = insertLocation('Telltale Cottage', 'home', 700);
      insertAgent(`Telltale ${madeAgents.length}`, neighbourHome, { current_location: aHome });
      trystPass(at(600 + 10), () => 0);
      expect(getPairIntimacy(a, b)!.secret).toBe(false);
    });

    it('a betrayed marriage makes it sensitivity 4', () => {
      const { a, b, aHome, bHome } = morningAfter();
      const spouse = insertAgent(`Spouse ${madeAgents.length}`, bHome, { current_location: bHome });
      marry(b, spouse);
      const neighbourHome = insertLocation('Snoop House', 'home', 700);
      insertAgent(`Snoop ${madeAgents.length}`, neighbourHome, { current_location: aHome });
      startSneakHome(b, NOW + 600);
      expect(factsOf(b)[0]).toMatchObject({ target_id: a, sensitivity: 4 });
    });

    it('a same-sex pair\'s secret weighs one more (their bond is hidden in 1900), capped at 4', () => {
      const { a, b, aHome } = morningAfter({ aOver: { gender: 'female', orientation: 'gay' }, bOver: { gender: 'female', orientation: 'gay' } });
      const neighbourHome = insertLocation('Gossip Cottage', 'home', 700);
      insertAgent(`Snoop ${madeAgents.length}`, neighbourHome, { current_location: aHome });
      startSneakHome(b, NOW + 600);
      expect(factsOf(b)[0]).toMatchObject({ target_id: a, sensitivity: 4 });
    });

    it('nobody awake, nobody told: an asleep neighbour sees nothing', () => {
      const { b, aHome } = morningAfter();
      const neighbourHome = insertLocation('Sleepy Cottage', 'home', 700);
      insertAgent(`Sleeper ${madeAgents.length}`, neighbourHome, { current_location: aHome, current_action: { type: 'sleeping' } });
      startSneakHome(b, NOW + 600);
      expect(factsOf(b)).toHaveLength(0);
      expect(rowsOf('caught', b)).toHaveLength(0);
    });

    it('on the road in the first half hour: anyone outdoors within 96 px sees them, each only once', () => {
      const { a, b } = morningAfter();
      startSneakHome(b, NOW + 600);
      // The guest is out on the street now.
      db.update(agents).set({ current_location: null, position: { x: 1000, y: 1000 }, current_action: { type: 'walking' } })
        .where(eq(agents.id, b)).run();
      const home = insertLocation('Baker House', 'home', 900);
      const near = insertAgent(`Baker ${madeAgents.length}`, home, { current_location: null, position: { x: 1050, y: 1050 } });
      const far = insertAgent(`Miller ${madeAgents.length}`, home, { current_location: null, position: { x: 1300, y: 1000 } });
      const indoors = insertAgent(`Cook ${madeAgents.length}`, home, { current_location: home, position: { x: 1000, y: 1000 } });

      trystPass(at(600 + 10), () => 0);
      const facts = factsOf(b);
      expect(facts).toHaveLength(1);
      expect(facts[0].known_by).toEqual([near]);
      expect(facts[0].known_by).not.toContain(far);
      expect(facts[0].known_by).not.toContain(indoors);
      expect(facts[0]).toMatchObject({ target_id: a });
      expect(rowsOf('caught', b)).toHaveLength(1);

      // The same baker does not see them twice.
      trystPass(at(600 + 20), () => 0);
      expect(rowsOf('caught', b)).toHaveLength(1);
    });

    it('a second witness on the road learns it silently: one caught row for the whole dawn', () => {
      const { b } = morningAfter();
      const homeA = insertLocation('Row House A', 'home', 900);
      const first = insertAgent(`Early ${madeAgents.length}`, homeA, { current_location: null, position: { x: 1050, y: 1050 } });
      db.update(agents).set({ current_location: null, position: { x: 1000, y: 1000 } }).where(eq(agents.id, b)).run();
      startSneakHome(b, NOW + 600);
      expect(rowsOf('caught', b)).toHaveLength(1);
      const homeB = insertLocation('Row House B', 'home', 950);
      const second = insertAgent(`Later ${madeAgents.length}`, homeB, { current_location: null, position: { x: 1020, y: 1000 } });
      const caught = captureEvents<{ witnessId: number }>('intimacy:caught');
      try {
        trystPass(at(600 + 10), () => 0);
      } finally { caught.stop(); }
      // They know (the fact, the event), but the feed does not repeat the scene.
      expect(factsOf(b)[0].known_by).toEqual(expect.arrayContaining([first, second]));
      expect(caught.seen.map((e) => e.witnessId)).toEqual([second]);
      expect(rowsOf('caught', b)).toHaveLength(1);
    });

    it('after half an hour the watch is over: nobody sees them any more', () => {
      const { b } = morningAfter();
      startSneakHome(b, NOW);
      db.update(agents).set({ current_location: null, position: { x: 1000, y: 1000 } }).where(eq(agents.id, b)).run();
      const home = insertLocation('Late House', 'home', 900);
      insertAgent(`Latecomer ${madeAgents.length}`, home, { current_location: null, position: { x: 1010, y: 1000 } });
      trystPass(at(SNEAK_WATCH_MINUTES + 10), () => 0);
      expect(getStay(b)).toBeUndefined();
      expect(factsOf(b)).toHaveLength(0);
    });

    it('once they are indoors at their own home the watch ends (nobody sees a front door they are behind)', () => {
      const { b, bHome } = morningAfter();
      startSneakHome(b, NOW);
      db.update(agents).set({ current_location: bHome }).where(eq(agents.id, b)).run();
      insertAgent(`Housemate ${madeAgents.length}`, bHome, { current_location: bHome });
      trystPass(at(10), () => 0);
      expect(getStay(b)).toBeUndefined();
      expect(factsOf(b)).toHaveLength(0);
    });
  });

  describe('a failed start leaves nothing half-begun', () => {
    it('if the writes throw, the invitation is still pending and no evening or stay exists', () => {
      const { a, b, aHome } = lovers();
      agree(a, b, { venueId: aHome });
      const broken = { ...locOf(aHome), position: null } as unknown as ReturnType<typeof locOf>;
      expect(() => beginTryst(load(a), load(b), broken, TIME, () => 0)).toThrow();
      const p = getPairIntimacy(a, b)!;
      expect(p.pendingRendezvous?.agreed).toBe(true);
      expect(p.activeTryst).toBeUndefined();
      expect(p.trysts).toBe(0);
      expect(getStay(b)).toBeUndefined();
    });
  });

  // ─── Walked in on ─────────────────────────────────────────────────────────

  describe('interruption', () => {
    function eveningAtHome() {
      const l = lovers();
      beginTryst(load(l.a), load(l.b), locOf(l.aHome), TIME, () => 0);
      return l;
    }

    it('a housemate turning up at the house ends the evening: caught, the guest leaves at once', () => {
      const { a, b, aHome } = eveningAtHome();
      const family = insertLocation('Family Cottage', 'home', 800);
      const sister = insertAgent(`Sister ${madeAgents.length}`, family, { current_location: aHome });
      const caught = captureEvents<{ a: number; b: number; witnessId: number }>('intimacy:caught');
      try {
        trystPass(at(20), () => 0);
      } finally { caught.stop(); }

      expect(getPairIntimacy(a, b)!.activeTryst).toBeUndefined();
      expect(caught.seen).toEqual([{ a: b, b: a, witnessId: sister }]);
      const rows = rowsOf('caught', b);
      expect(rows).toHaveLength(1);
      expect(rows[0].template_data).toMatchObject({ witness: load(sister).name, scene: 'found' });
      expect(factsOf(b)[0]).toMatchObject({ target_id: a, known_by: [sister] });
      // Both are out of the evening now, and the guest's next move is the walk home.
      expect(load(b).current_action).toEqual({ type: 'idle' });
      expect(load(b).action_duration).toBe(0);
      expect(getStay(b)!.leaving).toBe(true);
      expect(sleepTargetFor(load(b), NOW + 20)).toBe(load(b).home);
      expect(trystStepFor(load(b), { awake: false })).toEqual({ kind: 'sneak_home', locationId: load(b).home, dawn: true });
    });

    it('the betrayed spouse arriving learns of the affair (the existing discovery path takes it from there)', () => {
      const { a, b, aHome, bHome } = eveningAtHome();
      const spouse = insertAgent(`Husband ${madeAgents.length}`, bHome, { gender: 'female', current_location: aHome });
      marry(b, spouse);
      trystPass(at(20), () => 0);

      const affair = db.select().from(shared_knowledge)
        .where(and(eq(shared_knowledge.type, 'affair'), eq(shared_knowledge.subject_id, b))).all();
      expect(affair).toHaveLength(1);
      expect(affair[0]).toMatchObject({ target_id: a });
      expect(affair[0].known_by).toContain(spouse);
      expect(getPairIntimacy(a, b)!.activeTryst).toBeUndefined();
      db.delete(shared_knowledge).where(eq(shared_knowledge.subject_id, b)).run();
    });

    it('somebody asleep in the house does not interrupt', () => {
      const { a, b, aHome } = eveningAtHome();
      const family = insertLocation('Quiet Family', 'home', 800);
      insertAgent(`Sleeper ${madeAgents.length}`, family, { current_location: aHome, current_action: { type: 'sleeping' } });
      trystPass(at(20), () => 0);
      expect(getPairIntimacy(a, b)!.activeTryst).toBeDefined();
      expect(rowsOf('caught', b)).toHaveLength(0);
    });

    it('a married couple at home are not caught by their own family', () => {
      const { a, b, aHome } = lovers();
      db.update(agents).set({ home: aHome }).where(eq(agents.id, b)).run();
      marry(a, b);
      beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0);
      const family = insertLocation('Married Family', 'home', 800);
      insertAgent(`Child ${madeAgents.length}`, family, { current_location: aHome });
      trystPass(at(20), () => 0);
      expect(getPairIntimacy(a, b)!.activeTryst).toBeDefined();
      expect(rowsOf('caught', b)).toHaveLength(0);
    });

    it('a barn or grove is open to whoever is about, at the start', () => {
      const { a, b, aHome, bHome } = lovers();
      insertAgent(`Mother ${madeAgents.length}`, aHome, { current_location: null });
      insertAgent(`Father ${madeAgents.length}`, bHome, { current_location: null });
      const barn = insertLocation('Watched Farm', 'farm', 500);
      const farmerHome = insertLocation('Farmer House', 'home', 900);
      const farmer = insertAgent(`Farmer ${madeAgents.length}`, farmerHome, { current_location: barn });
      db.update(agents).set({ current_location: barn }).where(inArray(agents.id, [a, b])).run();
      agree(a, b, { venueId: barn });
      trystPass(TIME, () => 0);
      expect(getPairIntimacy(a, b)!.trysts).toBe(1);
      const rows = rowsOf('caught', a);
      expect(rows).toHaveLength(1);
      expect(rows[0].template_data).toMatchObject({ witness: load(farmer).name, scene: 'outdoors' });
      expect(factsOf(a)[0].content).toContain('after dark');
    });
  });

  // ─── Checkpoint ───────────────────────────────────────────────────────────

  describe('checkpoint and world replace', () => {
    it('a stay and an evening in progress survive a snapshot round trip', () => {
      const { a, b, aHome } = lovers();
      beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0);
      setStay(b, { locationId: aHome, hostId: a, until: NOW + 500, leaving: true, slept: true, leftAt: NOW + 5, seenBy: [7, 8] });
      const blob = JSON.parse(JSON.stringify(intimacySnapshotStore.serialize()));

      clearIntimacy();
      expect(getStay(b)).toBeUndefined();
      intimacySnapshotStore.restore(blob);
      expect(getStay(b)).toEqual({ locationId: aHome, hostId: a, until: NOW + 500, leaving: true, slept: true, leftAt: NOW + 5, seenBy: [7, 8] });
      expect(getPairIntimacy(a, b)!.activeTryst).toEqual({ venueId: aHome, startedAt: NOW, endsAt: NOW + 60, secret: false });
    });

    it('an older checkpoint without stays restores as none, and junk entries are dropped', () => {
      setStay(5, { locationId: 1, hostId: 2, until: 3 });
      intimacySnapshotStore.restore({ pairs: {}, agents: {}, longingAt: null });
      expect(getStay(5)).toBeUndefined();
      intimacySnapshotStore.restore({ stays: { '9': { locationId: 'x' }, '10': { locationId: 4, hostId: 5, until: 6 }, nope: {} } });
      expect(getStay(9)).toBeUndefined();
      expect(getStay(10)).toEqual({ locationId: 4, hostId: 5, until: 6, seenBy: [] });
    });

    it('a world replace clears stays and evenings', () => {
      const { a, b, aHome } = lovers();
      beginTryst(load(a), load(b), locOf(aHome), TIME, () => 0);
      expect(getStay(b)).toBeDefined();
      clearPerWorldCaches();
      expect(getStay(b)).toBeUndefined();
      expect(getPairIntimacy(a, b)).toBeUndefined();
    });
  });
});

describe('how a night reads in the feed', () => {
  const names = { agent1: 'Ada', agent2: 'Bruno', venue: 'Ada Cottage' };
  const at = (type: string, data: Record<string, string | number> = {}) =>
    renderMessage({ type, template_data: { ...names, ...data }, timestamp: 0 });

  it('says two people slipped away together, and no more (the row is written when the evening begins)', () => {
    expect(at('tryst')).toBe('Ada and Bruno slipped away together to Ada Cottage.');
    expect(renderMessage({ type: 'tryst', template_data: { agent1: 'Ada', agent2: 'Bruno' }, timestamp: 0 }))
      .toBe('Ada and Bruno slipped away together.');
  });

  it('says who saw whom slipping out at dawn (or found them, or saw them go off after dark)', () => {
    expect(at('caught', { witness: 'Cora' })).toBe("Cora saw Ada slipping out of Bruno's house at dawn.");
    expect(at('caught', { witness: 'Cora', scene: 'found' })).toBe('Cora found Ada and Bruno together.');
    expect(at('caught', { witness: 'Cora', scene: 'outdoors' })).toBe('Cora saw Ada and Bruno slipping away together after dark.');
  });
});
