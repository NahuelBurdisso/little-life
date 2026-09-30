import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agents, locations, worldEvents, worldState } from '../../db/schema';
import { startQueuedAction } from '../../engine/systems/movement';
import { emitter } from '../../engine/emitter';
import { logActivity } from '../activityLogger';
import { learnFact } from '../gossip';
import { fallbackInteriorTile, findAvailableZone, zoneSlotOffset } from '../interiorGrid';
import { MINUTES_PER_DAY, gameMinutes, type ClockTime } from '../gameClock';
import { affairInvolvesMarriage, affairSensitivity, isSpokenFor, spouseOf } from '../marriage';
import { inNoProposalState } from '../milestonesEngine';
import { simEvents } from '../simEvents';
import { applyTrystAftermath, type TrystCompletion } from './aftermath';
import { getAgentStates } from '../states';
import { distance } from '../utils';
import { isAdultContent } from '../worldRules';
import { gameMinutesNow } from '../worldClock';
import { isIntimacyEligible } from './eligibility';
import {
  clearStay, forEachPairIntimacy, forEachStay, getPairIntimacy, getStay, setStay, updatePairIntimacy, updateStay,
} from './state';
import { SNEAK_RANGE_PX, onlookersNear, withHiddenLoveBump } from './witnesses';

// ─── The tryst: where, when, and what the morning brings ─────────────────────
//
// The adult layer's private evening. Everything in this module runs only while
// the `adultContent` rule is on and only for two adults who are drawn to each
// other (`isIntimacyEligible`, the one age gate); every entry point re-checks
// both, and a pair that fails is cancelled. It happens OFF SCREEN and nothing
// here narrates it: the feed says two people "spent the evening together" and
// the morning after says somebody "saw X slipping out of Y's house at dawn". The
// canvas shows a hushed pose, nothing more (client, Task 19).
//
//   rendezvous.ts agrees an evening ({pendingRendezvous.agreed})
//        │  pickVenue: the asker's home if nobody else lives or is at it, else
//        │  the other's, else a barn or grove after dark and only in fair weather
//        ▼
//   both walk to the venue (decisions.ts, tier 6350: `trystStepFor` 'meet')
//        │  the pass sees them both there ─▶ beginTryst: both start
//        │  `{ type: 'idle', zoneActivity: 'tryst', partnerId }` for 60-90 game min
//        ▼
//   the night: at a home the guest sleeps there (`sleepTargetFor` overrides the
//        │  sleep target everywhere a bed is chosen); outdoors both go home
//        ▼
//   dawn: the guest wakes and walks home, `zoneActivity: 'sneak_home'`; anyone
//        awake at the house or within 96 px in the first 30 game minutes saw them
//        (`caught`: a `tryst_seen` secret, an `intimacy:caught` event, a feed row)
//
// An evening can also be walked in on: a housemate or spouse turning up at a home
// during it ends it (`caught`), and the betrayed spouse learns of the affair.
//
// State lives in intimacy/state.ts: `activeTryst` on the pair, a `Stay` per guest.

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** The evening lasts this long, whichever way it goes (game minutes). */
export const TRYST_MIN_MINUTES = 60;
export const TRYST_MAX_MINUTES = 90;
/**
 * Decision score of the walk to the venue and of the night after: above the day
 * plan (6000) and a rendezvous seek (6300), below a pending proposal (6400) and a
 * wedding (6500): the evening was already agreed, so it outranks the asking.
 */
export const TRYST_SEEK_SCORE = 6350;
/**
 * Before the pair is agreed again. Not tonight again: an unmarried pair waits
 * 18 game hours (the next evening, with longing to regrow: rendezvous.ts asks
 * again only from 19 h), a married couple 8 (they share a home and a bed, so
 * "tomorrow" is not a scandal, it is Tuesday).
 */
export const TRYST_RETRY_MINUTES = 18 * 60;
export const TRYST_RETRY_MARRIED_MINUTES = 8 * 60;
/** A failed venue search tries again the next day. */
export const VENUE_RETRY_MINUTES = MINUTES_PER_DAY;
/** A guest's stay lapses on its own after this long (a night and a morning). */
export const STAY_MAX_MINUTES = 14 * 60;
/** How long after leaving at dawn somebody can still catch the guest on the way home. */
export const SNEAK_WATCH_MINUTES = 30;
/** Outdoors it is dark from this hour until the next morning's. */
export const DARK_FROM_HOUR = 20;
export const DARK_UNTIL_HOUR = 6;
/** Weather nobody spends an evening in a field in (`world_state.weather`). */
const FOUL_WEATHER: readonly string[] = ['rainy', 'stormy', 'snowy'];
/** Outdoor venues: the barn (a `farm`) and the groves (a `park`), see INTERIOR_ZONES. */
const OUTDOOR_VENUE_TYPES: readonly string[] = ['farm', 'park'];

// ─── Pure rules (exported for tests) ─────────────────────────────────────────

/** Whether it is dark enough outdoors (evening from 20 h to before 6 h). */
export function isDarkHour(hour: number): boolean {
  return hour >= DARK_FROM_HOUR || hour < DARK_UNTIL_HOUR;
}

/** Weather or a storm event that keeps a couple indoors. */
export function isFoulWeather(weather: string, stormEvent: boolean): boolean {
  return stormEvent || FOUL_WEATHER.includes(weather);
}

/** The evening's length, 60 to 90 game minutes; `rng` is injectable for tests. */
export function trystDuration(rng: () => number = Math.random): number {
  return TRYST_MIN_MINUTES + Math.floor(rng() * (TRYST_MAX_MINUTES - TRYST_MIN_MINUTES + 1));
}

type AgentRow = typeof agents.$inferSelect;
type LocationRow = typeof locations.$inferSelect;

export interface VenueChoice {
  locationId: number;
  /** A barn or grove: riskier, and its start is watched too. */
  outdoors: boolean;
}

export interface VenueCtx {
  /** Hour of the game day now (outdoor venues need the dark). */
  hour: number;
  /** Rain, snow or a storm: nobody goes outdoors. */
  foulWeather: boolean;
}

const locationRow = (id: number | null): LocationRow | undefined =>
  id == null ? undefined : db.select().from(locations).where(eq(locations.id, id)).get();

/**
 * A home where nobody but the pair lives or is: no other resident (they would be
 * home tonight, whether or not they are right now) and nobody else inside.
 */
function homeIsQuiet(homeId: number, pair: readonly number[]): boolean {
  return !db.select({ id: agents.id, home: agents.home, current_location: agents.current_location })
    .from(agents).where(eq(agents.is_active, true)).all()
    .some((a) => !pair.includes(a.id) && (a.home === homeId || a.current_location === homeId));
}

/**
 * Where two people can be alone, best first:
 *  1. the asker's own home, if nobody else lives or is in it;
 *  2. the other's home, the same test;
 *  3. outdoors, a barn or grove (whichever is nearest them), only in fair
 *     weather and only in the dark. Before dark that is `'wait'`: the evening
 *     is not lost (the agreed pending lapses on its own after six hours);
 *  4. otherwise `null`: nowhere. The caller drops the evening and the pair
 *     tries again tomorrow.
 * `initiator` first is what makes the asker's house the first choice.
 */
export function pickVenue(initiator: AgentRow, other: AgentRow, ctx: VenueCtx): VenueChoice | 'wait' | null {
  const pair = [initiator.id, other.id];
  for (const host of [initiator, other]) {
    const home = locationRow(host.home);
    if (home?.type === 'home' && homeIsQuiet(home.id, pair)) return { locationId: home.id, outdoors: false };
  }

  if (ctx.foulWeather) return null;
  const candidates = db.select().from(locations).all()
    .filter((l) => OUTDOOR_VENUE_TYPES.includes(l.type) && findAvailableZone(l.type, 'tryst', l.id) != null);
  if (candidates.length === 0) return null;
  if (!isDarkHour(ctx.hour)) return 'wait';

  const mid = {
    x: ((initiator.position as { x: number }).x + (other.position as { x: number }).x) / 2,
    y: ((initiator.position as { y: number }).y + (other.position as { y: number }).y) / 2,
  };
  candidates.sort((p, q) => distance(mid, p.entry_point) - distance(mid, q.entry_point) || p.id - q.id);
  return { locationId: candidates[0].id, outdoors: true };
}

// ─── The night after: where a guest sleeps ───────────────────────────────────

/**
 * Where this agent goes to bed tonight: their own home, except for a guest whose
 * night at the venue is still on (rule on, stay not lapsed, not already told to
 * leave or walking home). EVERY place a bed is chosen asks this and not
 * `agent.home` (decisions.ts: the energy emergency, the schedule, supper and the
 * "can only sleep at home" check), or the guest would be walked out of their
 * lover's bed the moment the schedule said bedtime.
 *
 * `now` is only read when a stay exists, so passing nothing costs no query on
 * the normal path.
 */
export function sleepTargetFor(agent: { id: number; home: number }, now?: number): number {
  const stay = getStay(agent.id);
  if (!stay || stay.leaving || stay.leftAt != null) return agent.home;
  if (!isAdultContent()) return agent.home;
  if ((now ?? gameMinutesNow()) >= stay.until) return agent.home;
  return stay.locationId;
}

// ─── What a party to a tryst does next (the decisions tier) ──────────────────

export type TrystStep =
  /** Walk to the venue and wait for the other. */
  | { kind: 'meet'; locationId: number; partnerId: number }
  /** The guest, awake before bedtime: stay put at the venue. */
  | { kind: 'stay'; locationId: number }
  /** Go to bed where they are. */
  | { kind: 'sleep'; locationId: number }
  /** Walk home hushed. `dawn`: leaving a stay (starts the witness watch). */
  | { kind: 'sneak_home'; locationId: number; dawn: boolean };

type TrystAgent = Pick<AgentRow, 'id' | 'home' | 'current_location' | 'current_action'>;

export interface TrystCtx {
  /** Outside the agent's own sleep window right now. */
  awake: boolean;
}

/** An agreed evening with a venue that this agent is a party to. */
function agreedFor(agentId: number): { partnerId: number; venueId: number } | null {
  let found: { partnerId: number; venueId: number } | null = null;
  forEachPairIntimacy((key, p) => {
    const rv = p.pendingRendezvous;
    if (found || !rv?.agreed || rv.venueId == null) return;
    const [x, y] = key.split('-').map(Number);
    if (x !== agentId && y !== agentId) return;
    found = { partnerId: x === agentId ? y : x, venueId: rv.venueId };
  });
  return found;
}

/**
 * What the tryst asks of this agent right now, or null (decide as usual). Pure
 * apart from reads. Adult layer only: the caller checks the rule; the age gate
 * is re-checked here for the walk to a venue.
 */
export function trystStepFor(agent: TrystAgent, ctx: TrystCtx): TrystStep | null {
  const last = agent.current_action as { type?: string; zoneActivity?: string } | null;
  const stay = getStay(agent.id);

  // A guest at the house they are staying at.
  if (stay && stay.leftAt == null && agent.current_location === stay.locationId) {
    // Dawn (awake again, after sleeping) or told to go: home, quietly.
    if (stay.leaving || (last?.type === 'sleeping' && ctx.awake)) {
      return { kind: 'sneak_home', locationId: agent.home, dawn: true };
    }
    if (!ctx.awake) return { kind: 'sleep', locationId: stay.locationId };
    return { kind: 'stay', locationId: stay.locationId };
  }

  // The evening just ended, and they have no stay: the host, or an outdoor pair.
  if (last?.zoneActivity === 'tryst' && agent.current_location != null) {
    const loc = locationRow(agent.current_location);
    if (loc?.type === 'home') return ctx.awake ? null : { kind: 'sleep', locationId: loc.id };
    return { kind: 'sneak_home', locationId: agent.home, dawn: false };
  }

  // An agreed evening, venue chosen: go there.
  const agreed = agreedFor(agent.id);
  if (agreed) {
    const rows = db.select().from(agents).where(inArray(agents.id, [agent.id, agreed.partnerId])).all();
    const me = rows.find((r) => r.id === agent.id);
    const them = rows.find((r) => r.id === agreed.partnerId);
    if (me && them && isIntimacyEligible(me, them)) {
      return { kind: 'meet', locationId: agreed.venueId, partnerId: agreed.partnerId };
    }
  }
  return null;
}

// ─── Being seen ──────────────────────────────────────────────────────────────

type Scene = 'dawn' | 'found' | 'outdoors';

/**
 * Somebody saw. The secret is born (or gains knowers) as a `tryst_seen` fact
 * (sensitivity 3; 4 when either is married to a third person), one feed row
 * names the first witness, and an `intimacy:caught` per witness lets whatever
 * reacts to it do so (a same-sex pair's secret weighs one more, capped at 4:
 * `withHiddenLoveBump`). If a witness is the husband or wife of one of the two, the
 * affair is theirs to know too (an `affair` fact), which the existing discovery
 * path (reactToPartnerAffair, on their next talk with the straying spouse) turns
 * into a reckoning.
 *
 * `subject` is the one seen leaving (the guest), `other` whose house it was.
 */
function reportCaught(subject: AgentRow, other: AgentRow, witnessIds: number[], scene: Scene): void {
  if (witnessIds.length === 0) return;
  const sensitivity = withHiddenLoveBump(affairSensitivity(3, affairInvolvesMarriage(subject.id, other.id)), subject.id, other.id);
  learnFact('tryst_seen', subject.id, other.id, sensitivity, witnessIds, 'observed',
    scene === 'dawn' ? undefined : { detail: scene });

  for (const w of witnessIds) {
    for (const [straying, lover] of [[subject, other], [other, subject]] as const) {
      if (spouseOf(straying.id) === w && w !== lover.id) {
        learnFact('affair', straying.id, lover.id, 3, [subject.id, other.id, w], 'witnessed');
      }
    }
  }

  const first = db.select({ name: agents.name }).from(agents).where(eq(agents.id, witnessIds[0])).get();
  logActivity({
    type: 'caught',
    initiator: subject.id,
    target: other.id,
    agents: [subject.id, other.id, witnessIds[0]],
    ...(subject.current_location != null ? { location: subject.current_location } : {}),
    templateData: { agent1: subject.name, agent2: other.name, witness: first?.name ?? 'Someone', scene },
    metadata: { beat: 'caught' },
  });
  for (const w of witnessIds) simEvents.emit('intimacy:caught', { a: subject.id, b: other.id, witnessId: w });
}

// ─── Beginning ───────────────────────────────────────────────────────────────

/** The one who does not live at `venueId` (the guest), or null when both or neither do. */
function guestOf(a: AgentRow, b: AgentRow, venueId: number): AgentRow | null {
  const aLives = a.home === venueId;
  const bLives = b.home === venueId;
  if (aLives === bLives) return null;
  return aLives ? b : a;
}

/** Whether being found together would be a scandal: not married to each other, and not simply at home together. */
function isExposed(a: AgentRow, b: AgentRow, venueId: number): boolean {
  if (spouseOf(a.id) === b.id) return false;
  return !(a.home === venueId && b.home === venueId);
}

/** Put one partner into the evening: on the bed or the barn floor, `tryst` for `minutes`. */
function startTrystAction(agent: AgentRow, loc: LocationRow, partnerId: number, minutes: number, time: ClockTime): void {
  const zone = findAvailableZone(loc.type, 'tryst', loc.id, agent.id);
  const at = loc.position as { x: number; y: number; width: number; height: number };
  const slot = zoneSlotOffset(agent.id);
  const tile = zone ? zone.center : fallbackInteriorTile(loc.type, agent.id);
  if (tile) {
    db.update(agents)
      .set({ position: { x: at.x + tile[0] * 32 + 16 + slot.dx, y: at.y + tile[1] * 32 + 16 + slot.dy } })
      .where(eq(agents.id, agent.id)).run();
  }
  startQueuedAction(agent.id, loc.id, {
    type: 'idle',
    zoneActivity: 'tryst',
    partnerId,
    ...(zone ? { _arrivalZone: zone.id, _arrivalBuilding: loc.type } : {}),
    _duration: minutes,
  }, [], time);
}

/**
 * Both are at the venue: the evening begins. False (nothing changes) when the rule
 * is off or the pair may not be intimate (the gate is asked here even though the
 * pass asked it: this is the function the tests and any future caller reach).
 *
 * Consumes the agreed pending, counts the tryst, holds the pair back from being
 * agreed again for a while, gives the guest a bed at a home venue, writes the
 * feed row and emits `intimacy:tryst`. Outdoors, anyone awake there sees at once.
 */
export function beginTryst(
  a: AgentRow,
  b: AgentRow,
  venue: LocationRow,
  time: ClockTime,
  rng: () => number = Math.random,
): boolean {
  if (!isAdultContent()) return false;
  if (!isIntimacyEligible(a, b)) return false;
  const now = gameMinutes(time);
  const minutes = trystDuration(rng);
  const secret = isSpokenFor(a.id, b.id) || isSpokenFor(b.id, a.id) || a.gender === b.gender;
  const married = spouseOf(a.id) === b.id;
  const initiatorId = getPairIntimacy(a.id, b.id)?.pendingRendezvous?.initiatorId ?? a.id;

  updatePairIntimacy(a.id, b.id, (p) => {
    delete p.pendingRendezvous;
    p.trysts += 1;
    p.lastTrystAt = now;
    if (p.firstTrystAt == null) p.firstTrystAt = now;
    p.rendezvousRetryAfter = now + (married ? TRYST_RETRY_MARRIED_MINUTES : TRYST_RETRY_MINUTES);
    p.activeTryst = { venueId: venue.id, startedAt: now, endsAt: now + minutes, secret };
    // Hidden whenever either is spoken for elsewhere or the pair is same-sex (1900).
    if (secret) p.secret = true;
  });

  startTrystAction(a, venue, b.id, minutes, time);
  startTrystAction(b, venue, a.id, minutes, time);

  // At somebody else's home the guest stays the night. Where both live, nobody does.
  if (venue.type === 'home') {
    const guest = guestOf(a, b, venue.id);
    if (guest) setStay(guest.id, { locationId: venue.id, hostId: guest.id === a.id ? b.id : a.id, until: now + STAY_MAX_MINUTES });
  }

  const [first, second] = initiatorId === b.id ? [b, a] : [a, b];
  logActivity({
    type: 'tryst',
    initiator: first.id,
    target: second.id,
    location: venue.id,
    templateData: { agent1: first.name, agent2: second.name, venue: venue.name },
    metadata: { beat: 'tryst' },
  });
  simEvents.emit('intimacy:tryst', { a: a.id, b: b.id, venueId: venue.id, secret });

  // A barn or a grove is open to whoever is about.
  if (venue.type !== 'home' && isExposed(a, b, venue.id)) {
    reportCaught(first, second, onlookersNear({ current_location: venue.id, position: a.position }, [a.id, b.id]), 'outdoors');
  }
  return true;
}

// ─── Ending ──────────────────────────────────────────────────────────────────

/**
 * The evening is over (its time ran out, or somebody walked in). Fires exactly
 * once per tryst, from `trystPass`, after `activeTryst` is cleared. What a night
 * leaves behind (the `lovers` tag, the relationship events, longing eased, the
 * afterglow or the guilt, memories, the `affair` fact born from the act) is
 * aftermath.ts's; a failure there must not stop the pass from ending the others.
 */
function onTrystCompleted(tryst: TrystCompletion): void {
  try {
    applyTrystAftermath(tryst);
  } catch (err) {
    console.warn('[intimacy] tryst aftermath failed:', (err as Error).message);
  }
}

function completeTryst(x: number, y: number, interrupted: boolean, now: number): void {
  const p = getPairIntimacy(x, y);
  const t = p?.activeTryst;
  if (!p || !t) return;
  updatePairIntimacy(x, y, (s) => { delete s.activeTryst; });
  onTrystCompleted({
    a: x, b: y, venueId: t.venueId, secret: t.secret, first: p.firstTrystAt === t.startedAt, interrupted, now,
  });
}

/** Both are told the evening is over: their actions end now and the decision tier takes it from there. */
function endActions(ids: number[], now: number): void {
  db.update(agents)
    .set({ current_action: { type: 'idle' }, action_started: now, action_duration: 0, action_queue: [], current_destination: null, current_path: null })
    .where(inArray(agents.id, ids)).run();
}

/** Somebody walked in on an evening at a home. */
function interrupt(a: AgentRow, b: AgentRow, venue: LocationRow, witnessIds: number[], now: number): void {
  const guest = guestOf(a, b, venue.id);
  const [subject, other] = guest ? [guest, guest.id === a.id ? b : a] : [a, b];
  reportCaught(subject, other, witnessIds, 'found');
  endActions([a.id, b.id], now);
  if (guest) updateStay(guest.id, (s) => { s.leaving = true; });
  completeTryst(a.id, b.id, true, now);
}

// ─── Dawn ────────────────────────────────────────────────────────────────────

/**
 * The guest has woken (or been sent off) and is about to walk home: from here
 * `sleepTargetFor` is their own home again, anyone awake at the house sees them
 * go, and `trystPass` watches the road for the first half hour.
 */
export function startSneakHome(guestId: number, now: number): void {
  const stay = getStay(guestId);
  if (!stay || stay.leftAt != null) return;
  updateStay(guestId, (s) => { s.leftAt = now; });

  const rows = db.select().from(agents).where(inArray(agents.id, [guestId, stay.hostId])).all();
  const guest = rows.find((r) => r.id === guestId);
  const host = rows.find((r) => r.id === stay.hostId);
  if (!guest || !host) return;
  witnessLeaving(guest, host);
}

/** Report whoever, awake at `spot`, has not yet seen the guest leave. */
function witnessLeaving(guest: AgentRow, host: AgentRow): void {
  const stay = getStay(guest.id);
  if (!stay) return;
  const spot = { current_location: guest.current_location, position: guest.position };
  const fresh = onlookersNear(spot, [guest.id, host.id], SNEAK_RANGE_PX).filter((id) => !stay.seenBy.includes(id));
  if (fresh.length === 0) return;
  updateStay(guest.id, (s) => { s.seenBy.push(...fresh); });
  reportCaught(guest, host, fresh, 'dawn');
}

// ─── The periodic pass ───────────────────────────────────────────────────────

/** Whether a storm event is running (it keeps a couple indoors like foul weather). */
function stormEventActive(): boolean {
  return db.select({ type: worldEvents.type }).from(worldEvents)
    .where(and(eq(worldEvents.is_active, true), eq(worldEvents.type, 'storm'))).limit(1).get() !== undefined;
}

/** Every agreed evening, every evening in progress, every stay: the rule going off cancels the lot. */
function cancelEverything(): boolean {
  let changed = false;
  const keys: Array<[number, number]> = [];
  forEachPairIntimacy((key, p) => {
    if (p.activeTryst) {
      const [x, y] = key.split('-').map(Number);
      keys.push([x, y]);
    }
  });
  for (const [x, y] of keys) { updatePairIntimacy(x, y, (p) => { delete p.activeTryst; }); changed = true; }
  const guests: number[] = [];
  forEachStay((id) => guests.push(id));
  for (const id of guests) { clearStay(id); changed = true; }
  return changed;
}

/** An agent who cannot be pulled into the evening right now: talking, asleep, dead or on the road. */
function isFree(a: AgentRow): boolean {
  const t = (a.current_action as { type?: string } | null)?.type ?? 'idle';
  return t !== 'talking' && t !== 'sleeping' && t !== 'dead' && t !== 'walking';
}

/** One agreed evening: pick its venue, and start it once both are there. True when anything changed. */
function settleAgreed(key: string, time: ClockTime, rng: () => number): boolean {
  const now = gameMinutes(time);
  const [x, y] = key.split('-').map(Number);
  const rv = getPairIntimacy(x, y)?.pendingRendezvous;
  if (!rv?.agreed) return false;

  const rows = db.select().from(agents).where(inArray(agents.id, [x, y])).all();
  const a = rows.find((r) => r.id === x);
  const b = rows.find((r) => r.id === y);
  // Whoever it is, they may not be intimate any more (a minor, someone gone): no evening.
  if (!a || !b || !isIntimacyEligible(a, b)) {
    updatePairIntimacy(x, y, (p) => { delete p.pendingRendezvous; });
    return true;
  }
  // Somebody is in no state for it (sick, grieving, heartbroken...): it waits, and lapses on its own.
  if (inNoProposalState(getAgentStates(a.id)) || inNoProposalState(getAgentStates(b.id))) return false;

  let venueId = rv.venueId;
  if (venueId == null) {
    const initiator = rv.initiatorId === b.id ? b : a;
    const other = initiator === a ? b : a;
    const weather = db.select({ weather: worldState.weather }).from(worldState).limit(1).get()?.weather ?? 'sunny';
    const choice = pickVenue(initiator, other, { hour: time.hour, foulWeather: isFoulWeather(weather, stormEventActive()) });
    if (choice === 'wait') return false;
    if (!choice) {
      // Nowhere to be alone tonight: the pair asks again tomorrow.
      updatePairIntimacy(x, y, (p) => { delete p.pendingRendezvous; p.rendezvousRetryAfter = now + VENUE_RETRY_MINUTES; });
      return true;
    }
    venueId = choice.locationId;
    updatePairIntimacy(x, y, (p) => { if (p.pendingRendezvous) p.pendingRendezvous.venueId = choice.locationId; });
  }

  const venue = locationRow(venueId);
  if (!venue) {
    updatePairIntimacy(x, y, (p) => { delete p.pendingRendezvous; });
    return true;
  }
  const here = a.current_location === venue.id && b.current_location === venue.id;
  if (!here || !isFree(a) || !isFree(b)) return venueId !== rv.venueId;
  // A home venue with somebody else awake in it (an unexpected arrival) waits: they may leave.
  if (venue.type === 'home' && onlookersNear({ current_location: venue.id, position: a.position }, [a.id, b.id]).length > 0
    && isExposed(a, b, venue.id)) return venueId !== rv.venueId;
  return beginTryst(a, b, venue, time, rng) || venueId !== rv.venueId;
}

/**
 * Every 10 game minutes (intimacy/index.ts): settle agreed evenings, end the ones
 * in progress (their time is up, or somebody walked in), and watch the road home.
 * With the rule off, everything the layer had going is cancelled.
 */
export function trystPass(time: ClockTime, rng: () => number = Math.random): void {
  const now = gameMinutes(time);
  if (!isAdultContent()) {
    if (cancelEverything()) emitter.markDirty('agents.all');
    return;
  }
  let dirty = false;

  // --- Agreed evenings ---
  const agreed: string[] = [];
  forEachPairIntimacy((key, p) => { if (p.pendingRendezvous?.agreed) agreed.push(key); });
  for (const key of agreed) if (settleAgreed(key, time, rng)) dirty = true;

  // --- Evenings in progress ---
  const active: string[] = [];
  forEachPairIntimacy((key, p) => { if (p.activeTryst) active.push(key); });
  for (const key of active) {
    const [x, y] = key.split('-').map(Number);
    const t = getPairIntimacy(x, y)?.activeTryst;
    if (!t) continue;
    const rows = db.select().from(agents).where(inArray(agents.id, [x, y])).all();
    const a = rows.find((r) => r.id === x);
    const b = rows.find((r) => r.id === y);
    const venue = locationRow(t.venueId);
    if (!a || !b || !venue || !isIntimacyEligible(a, b)) { completeTryst(x, y, false, now); dirty = true; continue; }

    // Somebody awake turned up at a home: the housemate, the spouse.
    if (venue.type === 'home' && isExposed(a, b, venue.id)) {
      const arrivals = onlookersNear({ current_location: venue.id, position: a.position }, [a.id, b.id]);
      if (arrivals.length > 0) { interrupt(a, b, venue, arrivals, now); dirty = true; continue; }
    }
    if (now >= t.endsAt) { completeTryst(x, y, false, now); dirty = true; }
  }

  // --- Stays: lapse, or watch the road ---
  const guests: Array<[number, ReturnType<typeof getStay>]> = [];
  forEachStay((id, s) => guests.push([id, s]));
  for (const [guestId, stay] of guests) {
    if (!stay) continue;
    if (stay.leftAt == null) {
      if (now >= stay.until) { clearStay(guestId); dirty = true; }
      continue;
    }
    const rows = db.select().from(agents).where(inArray(agents.id, [guestId, stay.hostId])).all();
    const guest = rows.find((r) => r.id === guestId);
    const host = rows.find((r) => r.id === stay.hostId);
    // Time is up, or they are indoors somewhere else (home again): nobody sees a front door they are behind.
    const home = guest != null && guest.current_location != null && guest.current_location !== stay.locationId;
    if (!guest || !host || now - stay.leftAt > SNEAK_WATCH_MINUTES || home) { clearStay(guestId); dirty = true; continue; }
    witnessLeaving(guest, host);
  }

  if (dirty) emitter.markDirty('agents.all');
}
