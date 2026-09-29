/**
 * Population flow: people leave town and strangers move in, on their own.
 *
 * Why this exists. The cast never changed unless the player changed it: a
 * `new_arrival` only ever came from the New Resident dialog, nobody ever moved
 * away, and a death was the only way out. Over days 5-30 a town settled into
 * the same thirteen faces with the same feuds, and a resident whose life had
 * fallen apart — friendless, broke, estranged from their partner — could only
 * stay and be miserable forever. Real small towns breathe: people give up and
 * go, and someone new takes the empty house. Both are story.
 *
 * No LLM. Everything here is decided from state the sim already keeps.
 *
 * Leaving, in three beats spread over about two game days:
 *   1. Thinking of leaving. At a day change, one resident whose life here has
 *      gone wrong — low mood for days on end (moodMomentum's bad streak),
 *      estranged from the partner they live with, shunned (bottom reputation
 *      and not one friend), or broke for days (`in_debt`) — starts to think
 *      about going. A memory says so, and the Brewing tab shows it: the
 *      player gets a day's warning.
 *   2. The next day change decides. A friend's kind conversation, a player's
 *      nudge (money, a whispered thought, a stirred feeling, a talk) or a mood
 *      back up where it should be, and they stay — and remember why. Otherwise
 *      they make up their mind.
 *   3. That morning they say goodbye (a `departure` feed line, a memory for
 *      everyone close to them), walk out along the road to the town edge, and
 *      are retired (lib/residents.ts) when they get there.
 * At most one departure every few game days, never below a floor, and never
 * someone who just arrived or whose living spouse keeps them here.
 *
 * Arriving: when a house stands empty and the town is under its target size,
 * at most every few game days, a stranger walks in from the edge at mid-
 * morning — a period name, the trade the town is missing (no baker? a baker),
 * a template bio, the house named after them — and the town notices ("a new
 * face in town").
 *
 * The switch and the target are world rules (worldRules.ts, the Storyteller
 * section of the Autoplay panel). The timers live here and are checkpointed to
 * sim_snapshots (worldCaches.ts), so a restart neither forgets who was
 * packing nor lets two strangers arrive on consecutive days.
 *
 * Side-effect module: importing it registers the `conversation:ended`
 * listener that notices a friend's comfort (tick.ts imports it).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { agents, agentStates, economy, locations, needs, relationships, worldState } from '../db/schema';
import { CONFIG } from './constants';
import { getRules } from './worldRules';
import { POPULATION_TARGET_MAX, POPULATION_TARGET_MIN } from '../data/rulesCatalog';
import { JOBS, type JobKey } from '../data/jobs';
import { PERIOD_FAMILY_NAMES, PERIOD_FIRST_NAMES } from '../data/residentNames';
import {
  createResident, emptyHomes, feelingsToward, livingTiesOf, residentsByHome, retireResident, townEdgePoint,
} from './residents';
import { getMoodStreak } from './moodMomentum';
import { getReputation } from './reputationEngine';
import { spouseOf } from './marriage';
import { logActivity } from './activityLogger';
import { memoryService } from './memory/instance';
import { simEvents } from './simEvents';
import { gameMinutes, type ClockTime } from './gameClock';
import { makeRng, stringToSeed } from './worldgen/rng';
import { startWorldEvent } from '../engine/systems/events';
import { emitter } from '../engine/emitter';
import { asNumber, asRecord, type SnapshotStore } from '../engine/snapshotCodec';

// ─── Tuning ──────────────────────────────────────────────────────────────────

export const POPULATION_FLOW = {
  /** A resident thinks it over at least this long (it is decided at the next day change). */
  THINKING_MINUTES: 20 * 60,
  /** Game days between one departure and the next thought of leaving. */
  DEPARTURE_GAP_DAYS: 4,
  /** Game days between arrivals. */
  ARRIVAL_GAP_DAYS: 3,
  /** Leavers set off at this hour — after breakfast, when the town is up to see them go. */
  LEAVE_HOUR: 8,
  /** Newcomers walk in at this hour. */
  ARRIVE_HOUR: 10,
  /** A leaver who has not reached the edge after this long is gone anyway (stuck, detained by chats). */
  WALK_TIMEOUT_MINUTES: 4 * 60,
  /** Close enough to the edge to count as gone. */
  EDGE_REACHED_PX: 48,
  /** Bad days in a row (moodMomentum streak) that make someone think of leaving. */
  UNHAPPY_STREAK_DAYS: 3,
  /**
   * A thinker has cheered up enough to stay when their mood is at least this
   * AND has risen MOOD_LIFT since they started thinking of leaving — a broke
   * or shunned resident can be in fair spirits the whole time, and that is
   * not a change of heart.
   */
  RECOVERED_MOOD: 55,
  MOOD_LIFT: 10,
  /** Someone who decided to stay does not reconsider for this many game days. */
  STAY_GRACE_DAYS: 3,
  /** Reputation at or below which, with no friend at all, the town has shunned someone. */
  SHUNNED_REPUTATION: -30,
  /** Another resident's friendship toward someone above this makes them a friend. */
  FRIEND_THRESHOLD: 40,
  /** Game days in `in_debt` (itself three broke days in) before money trouble drives someone out. */
  BROKE_DEBT_DAYS: 2,
  /** A conversation this warm, with anyone, counts as being cared for. */
  CARING_SENTIMENT: 0.3,
  /** Newcomers get this many game days to settle in before they can be driven out. */
  NEWCOMER_GRACE_DAYS: 5,
  /** Never fewer residents than this, whatever the target. */
  MIN_FLOOR: 4,
  /** Departures stop at this share of the target. */
  FLOOR_RATIO: 0.75,
} as const;

const DAY = 24 * 60;

export type DepartureReason = 'unhappy' | 'estranged' | 'shunned' | 'broke';

/** Third person, for the Brewing tab and the feed. */
export const REASON_PHRASES: Record<DepartureReason, string> = {
  unhappy: 'days of feeling low',
  estranged: 'a partnership turned bitter',
  shunned: 'a town that has turned its back on them',
  broke: 'no money and no way to make ends meet',
};

/** First person, for their own memory. */
const REASON_THOUGHTS: Record<DepartureReason, string> = {
  unhappy: "I've been miserable for days and nothing here seems to help",
  estranged: "I can't bear to keep living beside someone I'm estranged from",
  shunned: "Nobody here trusts me, and I haven't a friend left in town",
  broke: "I've been broke for days with no way to make ends meet",
};

// ─── State ───────────────────────────────────────────────────────────────────

export interface LeavingThought {
  agentId: number;
  /** Game minute they started thinking about it. */
  since: number;
  reasons: DepartureReason[];
  /** Their mood when the thought began: staying for a lift in spirits is measured from it. */
  moodAtStart: number;
  /** Someone showed they care (a friend's chat, a player's nudge) — who, in words. */
  caredBy: string | null;
}

export interface Departure {
  agentId: number;
  reasons: DepartureReason[];
  /** Game minute they set off. */
  leaveAt: number;
  /** Game minute they started walking; null until then. */
  walkingSince: number | null;
  edge: { x: number; y: number };
}

const state = {
  lastDepartureAt: null as number | null,
  lastArrivalAt: null as number | null,
  pendingArrivalAt: null as number | null,
  thinking: new Map<number, LeavingThought>(),
  departing: new Map<number, Departure>(),
  /** Game minute each flow newcomer arrived (their grace period). */
  arrivedAt: new Map<number, number>(),
  /** Game minute each resident last decided to stay (they don't reconsider at once). */
  stayedAt: new Map<number, number>(),
};

/** Forget everything (world replace: ids and the clock restart). */
export function clearPopulationFlow(): void {
  state.lastDepartureAt = null;
  state.lastArrivalAt = null;
  state.pendingArrivalAt = null;
  state.thinking.clear();
  state.departing.clear();
  state.arrivedAt.clear();
  state.stayedAt.clear();
}

/** Read-only view, for tests, diagnostics and the Brewing tab. */
export function getPopulationFlowState() {
  return {
    lastDepartureAt: state.lastDepartureAt,
    lastArrivalAt: state.lastArrivalAt,
    pendingArrivalAt: state.pendingArrivalAt,
    thinking: [...state.thinking.values()].map((t) => ({ ...t, reasons: [...t.reasons] })),
    departing: [...state.departing.values()].map((d) => ({ ...d, reasons: [...d.reasons], edge: { ...d.edge } })),
  };
}

const REASONS: readonly DepartureReason[] = ['unhappy', 'estranged', 'shunned', 'broke'];
const asReasons = (v: unknown): DepartureReason[] =>
  Array.isArray(v) ? v.filter((r): r is DepartureReason => REASONS.includes(r as DepartureReason)) : [];
const asPoint = (v: unknown): { x: number; y: number } | null => {
  const r = asRecord(v);
  const x = asNumber(r?.x);
  const y = asNumber(r?.y);
  return x !== null && y !== null ? { x, y } : null;
};

/**
 * Checkpoint (server/engine/simSnapshots.ts). Always an object, so an empty
 * town overwrites an older world's row.
 */
export const populationFlowSnapshotStore: SnapshotStore = {
  key: 'populationFlow',
  version: 1,
  serialize: () => ({
    lastDepartureAt: state.lastDepartureAt,
    lastArrivalAt: state.lastArrivalAt,
    pendingArrivalAt: state.pendingArrivalAt,
    thinking: [...state.thinking.values()],
    departing: [...state.departing.values()],
    arrivedAt: Object.fromEntries(state.arrivedAt),
    stayedAt: Object.fromEntries(state.stayedAt),
  }),
  restore: (data) => {
    clearPopulationFlow();
    const r = asRecord(data);
    if (!r) return;
    state.lastDepartureAt = asNumber(r.lastDepartureAt);
    state.lastArrivalAt = asNumber(r.lastArrivalAt);
    state.pendingArrivalAt = asNumber(r.pendingArrivalAt);
    for (const raw of Array.isArray(r.thinking) ? r.thinking : []) {
      const t = asRecord(raw);
      const agentId = asNumber(t?.agentId);
      const since = asNumber(t?.since);
      if (agentId === null || since === null) continue;
      state.thinking.set(agentId, {
        agentId, since, reasons: asReasons(t?.reasons),
        moodAtStart: asNumber(t?.moodAtStart) ?? 0,
        caredBy: typeof t?.caredBy === 'string' ? t.caredBy : null,
      });
    }
    for (const raw of Array.isArray(r.departing) ? r.departing : []) {
      const d = asRecord(raw);
      const agentId = asNumber(d?.agentId);
      const leaveAt = asNumber(d?.leaveAt);
      const edge = asPoint(d?.edge);
      if (agentId === null || leaveAt === null || !edge) continue;
      state.departing.set(agentId, {
        agentId, leaveAt, edge, reasons: asReasons(d?.reasons), walkingSince: asNumber(d?.walkingSince),
      });
    }
    for (const [key, map] of [['arrivedAt', state.arrivedAt], ['stayedAt', state.stayedAt]] as const) {
      for (const [k, v] of Object.entries(asRecord(r[key]) ?? {})) {
        const id = Number(k);
        const at = asNumber(v);
        if (Number.isInteger(id) && at !== null) map.set(id, at);
      }
    }
  },
};

// ─── Pure rules (exported for tests) ─────────────────────────────────────────

/** What the sim knows about how someone's life here is going. */
export interface DepartureSignals {
  agentId: number;
  mood: number;
  /** moodMomentum streak: negative = bad days in a row. */
  moodStreak: number;
  /** Estranged from someone they live with or were in love with. */
  estrangedFromPartner: boolean;
  reputation: number;
  /** Living residents whose friendship toward them is above FRIEND_THRESHOLD. */
  friendCount: number;
  /** Game days in the `in_debt` state (0 when not in debt). */
  debtDays: number;
  /** Anything that rules leaving out for now: jailed, a living spouse they are not estranged from, just arrived. */
  heldBack: boolean;
}

/** Why this resident might leave town; empty when their life here is bearable. */
export function departureReasons(s: DepartureSignals): DepartureReason[] {
  const out: DepartureReason[] = [];
  if (s.moodStreak <= -POPULATION_FLOW.UNHAPPY_STREAK_DAYS) out.push('unhappy');
  if (s.estrangedFromPartner) out.push('estranged');
  if (s.reputation <= POPULATION_FLOW.SHUNNED_REPUTATION && s.friendCount === 0) out.push('shunned');
  if (s.debtDays >= POPULATION_FLOW.BROKE_DEBT_DAYS) out.push('broke');
  return out;
}

/** The one resident who starts thinking of leaving: most reasons, then the unhappiest, then the lowest id. */
export function pickLeaver(signals: readonly DepartureSignals[]): { agentId: number; reasons: DepartureReason[] } | null {
  let best: { s: DepartureSignals; reasons: DepartureReason[] } | null = null;
  for (const s of signals) {
    if (s.heldBack) continue;
    const reasons = departureReasons(s);
    if (reasons.length === 0) continue;
    if (!best
      || reasons.length > best.reasons.length
      || (reasons.length === best.reasons.length && (s.mood < best.s.mood || (s.mood === best.s.mood && s.agentId < best.s.agentId)))) {
      best = { s, reasons };
    }
  }
  return best ? { agentId: best.s.agentId, reasons: best.reasons } : null;
}

/** Whether a thinker stays: someone reached them, they cheered up, or what drove them is gone. */
export function decidesToStay(t: Pick<LeavingThought, 'caredBy' | 'moodAtStart'>, now: DepartureSignals): boolean {
  if (t.caredBy) return true;
  if (now.mood >= POPULATION_FLOW.RECOVERED_MOOD && now.mood - t.moodAtStart >= POPULATION_FLOW.MOOD_LIFT) return true;
  return departureReasons(now).length === 0;
}

/** Departures stop here: a share of the target, never below MIN_FLOOR. */
export function populationFloor(target: number): number {
  return Math.max(POPULATION_FLOW.MIN_FLOOR, Math.round(target * POPULATION_FLOW.FLOOR_RATIO));
}

/** Whether a departure may be set in motion now. */
export function departureAllowed(p: { living: number; leaving: number; target: number; lastDepartureAt: number | null; now: number }): boolean {
  if (p.living - p.leaving - 1 < populationFloor(p.target)) return false;
  return p.lastDepartureAt == null || p.now - p.lastDepartureAt >= POPULATION_FLOW.DEPARTURE_GAP_DAYS * DAY;
}

/** Whether a newcomer may be scheduled now. */
export function arrivalAllowed(p: {
  living: number; leaving: number; target: number; emptyHomes: number; lastArrivalAt: number | null; now: number;
}): boolean {
  if (p.emptyHomes <= 0) return false;
  if (p.living >= CONFIG.MAX_AGENTS) return false;
  if (p.living - p.leaving >= p.target) return false;
  return p.lastArrivalAt == null || p.now - p.lastArrivalAt >= POPULATION_FLOW.ARRIVAL_GAP_DAYS * DAY;
}

/**
 * Trades a town can't do without, in the order a gap hurts: nobody to treat
 * the sick, bake, grow food, sell it, pour a drink, keep the peace, run the
 * town. Only trades whose building exists count.
 */
const ESSENTIAL_JOBS: readonly JobKey[] = ['doctor', 'baker', 'farmer', 'shopkeeper', 'bartender', 'constable', 'mayor'];
/** A town with every trade covered gets a pair of hands. */
const HELPER_JOBS: readonly JobKey[] = ['farmhand', 'shop_assistant', 'medical_assistant', 'handyperson', 'musician'];

/** The newcomer's trade: the first missing essential one, else a helper the town has a workplace for. */
export function pickArrivalJob(livingJobs: readonly string[], locationTypes: readonly string[], rng: { pick<T>(a: readonly T[]): T }): string {
  const types = new Set(locationTypes);
  const held = new Set(livingJobs);
  const hasPlace = (job: JobKey) => {
    const t = JOBS[job].workplaceType;
    return t != null && types.has(t);
  };
  const missing = ESSENTIAL_JOBS.find((j) => hasPlace(j) && !held.has(j));
  if (missing) return missing;
  const helpers = HELPER_JOBS.filter(hasPlace);
  return helpers.length > 0 ? rng.pick(helpers) : 'unemployed';
}

/** A period name nobody in town has (first name included — two Ednas confuse every prompt). */
export function pickArrivalName(
  takenNames: readonly string[],
  rng: { pick<T>(a: readonly T[]): T; next(): number },
): { name: string; gender: 'female' | 'male' } {
  const takenFull = new Set(takenNames.map((n) => n.toLowerCase()));
  const takenFirst = new Set(takenNames.map((n) => n.trim().split(/\s+/).filter((w) => !/^(dr|mr|mrs|ms|miss)\.?$/i.test(w))[0]?.toLowerCase()));
  for (let attempt = 0; attempt < 60; attempt++) {
    const gender: 'female' | 'male' = rng.next() < 0.5 ? 'female' : 'male';
    const first = rng.pick(PERIOD_FIRST_NAMES[gender]);
    const family = rng.pick(PERIOD_FAMILY_NAMES);
    const name = `${first} ${family}`;
    if (takenFirst.has(first.toLowerCase()) || takenFull.has(name.toLowerCase())) continue;
    return { name, gender };
  }
  // Sixty collisions means a huge town; any unused full name will do.
  const gender: 'female' | 'male' = 'female';
  for (const first of PERIOD_FIRST_NAMES[gender]) {
    for (const family of PERIOD_FAMILY_NAMES) {
      const name = `${first} ${family}`;
      if (!takenFull.has(name.toLowerCase())) return { name, gender };
    }
  }
  return { name: `Newcomer ${takenNames.length + 1}`, gender };
}

function joinReasons(reasons: readonly DepartureReason[]): string {
  const parts = reasons.map((r) => REASON_PHRASES[r]);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ─── Reading the town ────────────────────────────────────────────────────────

/** The town's size and the bounds the flow keeps it in. */
export function populationTargets(): { living: number; target: number; floor: number; cap: number; flowOn: boolean } {
  const rules = getRules();
  const living = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all().length;
  const target = rules.populationTarget ?? baselinePopulation();
  const clamped = Math.max(POPULATION_TARGET_MIN, Math.min(POPULATION_TARGET_MAX, CONFIG.MAX_AGENTS, target));
  return { living, target: clamped, floor: populationFloor(clamped), cap: CONFIG.MAX_AGENTS, flowOn: rules.populationFlow };
}

/**
 * The size the town started at: the wizard's cast, or — for the default seed
 * and pre-wizard saves — everyone created at world build (created_at 0; a
 * mid-game arrival is stamped with the tick it came).
 */
function baselinePopulation(): number {
  const row = db.select({ setup_config: worldState.setup_config }).from(worldState).limit(1).get();
  const cast = (row?.setup_config as { agents?: unknown[] } | null)?.agents;
  if (Array.isArray(cast) && cast.length > 0) return cast.length;
  const founders = db.select({ id: agents.id }).from(agents).where(eq(agents.created_at, 0)).all().length;
  return founders > 0 ? founders : CONFIG.STARTING_AGENTS;
}

/** Signals for every living resident, from the DB and the in-memory trackers. */
function readSignals(nowMinutes: number): DepartureSignals[] {
  const living = db.select().from(agents).where(eq(agents.is_active, true)).all();
  if (living.length === 0) return [];
  const ids = living.map((a) => a.id);
  const homeOf = new Map(living.map((a) => [a.id, a.home]));
  const moodOf = new Map(db.select({ agent_id: needs.agent_id, mood: needs.mood }).from(needs)
    .where(inArray(needs.agent_id, ids)).all().map((n) => [n.agent_id, n.mood]));
  const states = db.select().from(agentStates).where(inArray(agentStates.agent_id, ids)).all();
  const rels = db.select().from(relationships).all();

  return living.map((a) => {
    let friendCount = 0;
    let estranged = false;
    for (const rel of rels) {
      if (rel.agent_a !== a.id && rel.agent_b !== a.id) continue;
      const { theirs, otherId } = feelingsToward(rel, a.id);
      if (!homeOf.has(otherId)) continue; // not a living resident
      if (theirs > POPULATION_FLOW.FRIEND_THRESHOLD) friendCount++;
      if (rel.tags.includes('estranged')
        && (homeOf.get(otherId) === a.home || Math.max(rel.romance_ab, rel.romance_ba) > 30)) {
        estranged = true;
      }
    }
    const mine = states.filter((s) => s.agent_id === a.id);
    const debt = mine.find((s) => s.type === 'in_debt');
    const jailed = mine.some((s) => s.type === 'arrested');
    const spouse = spouseOf(a.id);
    const arrived = state.arrivedAt.get(a.id);
    const settling = arrived != null && nowMinutes - arrived < POPULATION_FLOW.NEWCOMER_GRACE_DAYS * DAY;
    const stayed = state.stayedAt.get(a.id);
    const reconciled = stayed != null && nowMinutes - stayed < POPULATION_FLOW.STAY_GRACE_DAYS * DAY;
    return {
      agentId: a.id,
      mood: moodOf.get(a.id) ?? 50,
      moodStreak: getMoodStreak(a.id),
      estrangedFromPartner: estranged,
      reputation: getReputation(a.id),
      friendCount,
      debtDays: debt ? Math.max(0, (nowMinutes - debt.started_at) / DAY) : 0,
      // A marriage holds someone here unless it is the thing they are fleeing.
      heldBack: jailed || settling || reconciled || (spouse != null && !estranged),
    };
  });
}

function nameOf(id: number): string {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? `Agent#${id}`;
}

function firstName(name: string): string {
  return name.split(' ')[0];
}

// ─── The daily pass ──────────────────────────────────────────────────────────

/**
 * At each day change (engine/tick.ts, after mood momentum has judged the day
 * that ended): resolve yesterday's thoughts of leaving, maybe start a new one,
 * maybe schedule a newcomer for mid-morning.
 */
export function populationFlowDaily(time: ClockTime, nowMinutes: number): void {
  const rules = getRules();
  if (!rules.populationFlow) {
    // Switched off: nobody is halfway out the door and nobody is on the road
    // in. Someone already walking out finishes the walk (populationFlowTick).
    state.thinking.clear();
    state.pendingArrivalAt = null;
    for (const [id, d] of state.departing) if (d.walkingSince == null) state.departing.delete(id);
    return;
  }

  const dayStart = gameMinutes({ day: time.day, hour: 0, minute: 0 });
  const { living, target } = populationTargets();
  const signals = readSignals(nowMinutes);
  const byId = new Map(signals.map((s) => [s.agentId, s]));
  let changed = false;

  // Grace periods that have run out.
  for (const [id, at] of state.arrivedAt) {
    if (nowMinutes - at >= POPULATION_FLOW.NEWCOMER_GRACE_DAYS * DAY) state.arrivedAt.delete(id);
  }
  for (const [id, at] of state.stayedAt) {
    if (nowMinutes - at >= POPULATION_FLOW.STAY_GRACE_DAYS * DAY) state.stayedAt.delete(id);
  }

  // 1. Yesterday's thoughts.
  for (const t of [...state.thinking.values()]) {
    const now = byId.get(t.agentId);
    if (!now) { state.thinking.delete(t.agentId); continue; }
    if (nowMinutes - t.since < POPULATION_FLOW.THINKING_MINUTES) continue;
    // Jailed (or otherwise held) since: nothing is decided until they are free.
    if (now.heldBack && !t.caredBy) continue;
    if (decidesToStay(t, now)) {
      state.thinking.delete(t.agentId);
      state.stayedAt.set(t.agentId, nowMinutes);
      stays(t);
      changed = true;
      continue;
    }
    if (!departureAllowed({ living, leaving: state.departing.size, target, lastDepartureAt: state.lastDepartureAt, now: nowMinutes })) {
      // The town is at its floor: they linger, unhappy, until it isn't.
      continue;
    }
    state.thinking.delete(t.agentId);
    const reasons = departureReasons(now);
    const leaveAt = dayStart + POPULATION_FLOW.LEAVE_HOUR * 60;
    const world = db.select({ map_width: worldState.map_width, map_height: worldState.map_height, road_tiles: worldState.road_tiles })
      .from(worldState).limit(1).get();
    state.departing.set(t.agentId, {
      agentId: t.agentId,
      reasons: reasons.length > 0 ? reasons : t.reasons,
      leaveAt,
      walkingSince: null,
      edge: world ? townEdgePoint(world) : { x: 0, y: 0 },
    });
    // The slot is taken from the moment they decide.
    state.lastDepartureAt = leaveAt;
    memoryService.record(t.agentId, 'reflection',
      "I've made up my mind: I'm leaving this town. Tomorrow morning I'll pack what I can carry and go.",
      { subtype: 'leaving_town' }, -0.5, 8);
    changed = true;
  }

  // 2. A new thought of leaving — one at a time, and not while someone is going.
  if (state.thinking.size === 0 && state.departing.size === 0
    && departureAllowed({ living, leaving: 0, target, lastDepartureAt: state.lastDepartureAt, now: nowMinutes })) {
    // Not someone who decided to stay a moment ago (the signals were read before that).
    const pick = pickLeaver(signals.filter((sig) => !state.stayedAt.has(sig.agentId)));
    if (pick) {
      state.thinking.set(pick.agentId, {
        agentId: pick.agentId, since: nowMinutes, reasons: pick.reasons,
        moodAtStart: byId.get(pick.agentId)?.mood ?? 0, caredBy: null,
      });
      const why = pick.reasons.map((r) => REASON_THOUGHTS[r]).join('. ');
      memoryService.record(pick.agentId, 'reflection',
        `${why}. I've started to think about leaving town for good — somewhere else, a fresh start.`,
        { subtype: 'thinking_of_leaving', reasons: pick.reasons }, -0.6, 7);
      changed = true;
    }
  }

  // 3. A newcomer for mid-morning.
  if (state.pendingArrivalAt == null) {
    const living_ = db.select({ home: agents.home }).from(agents).where(eq(agents.is_active, true)).all();
    const empty = emptyHomes(db.select().from(locations).all(), residentsByHome(living_)).length;
    if (arrivalAllowed({ living, leaving: state.departing.size, target, emptyHomes: empty, lastArrivalAt: state.lastArrivalAt, now: nowMinutes })) {
      state.pendingArrivalAt = dayStart + POPULATION_FLOW.ARRIVE_HOUR * 60;
    }
  }

  if (changed) emitter.markDirty('agents.all');
}

function stays(t: LeavingThought): void {
  const why = t.caredBy === PLAYER_CARE
    ? 'something happened that made me feel this place still wants me'
    : t.caredBy
      ? `${t.caredBy} reminded me I'm not alone here`
      : 'things have started to look up';
  memoryService.record(t.agentId, 'reflection',
    `I came close to leaving town, but I'm staying — ${why}.`,
    { subtype: 'decided_to_stay' }, 0.5, 7);
  logActivity({
    type: 'drama',
    initiator: t.agentId,
    templateData: { description: `${nameOf(t.agentId)} had been thinking of leaving town, but has decided to stay.` },
  });
}

// ─── The 10-minute pass ──────────────────────────────────────────────────────

/**
 * Every 10 game minutes (engine/tick.ts): walk a newcomer in when one is due,
 * send leavers off when their morning comes, and retire them at the edge.
 */
export function populationFlowTick(time: ClockTime, nowMinutes: number): void {
  if (state.pendingArrivalAt != null && nowMinutes >= state.pendingArrivalAt) {
    state.pendingArrivalAt = null;
    if (getRules().populationFlow) runArrival(time, nowMinutes);
  }
  if (state.departing.size === 0) return;
  for (const d of [...state.departing.values()]) {
    const agent = db.select().from(agents).where(eq(agents.id, d.agentId)).get();
    if (!agent || !agent.is_active) { state.departing.delete(d.agentId); continue; }
    if (nowMinutes < d.leaveAt) continue;
    const action = agent.current_action as { type?: string; reason?: string } | null;
    if (d.walkingSince == null) {
      // Mid-conversation: let them finish it, then go.
      if (action?.type === 'talking') continue;
      sayGoodbye(agent, d);
      walkToEdge(agent.id, d.edge, nowMinutes);
      d.walkingSince = nowMinutes;
      continue;
    }
    const pos = agent.position as { x: number; y: number };
    const there = Math.hypot(pos.x - d.edge.x, pos.y - d.edge.y) <= POPULATION_FLOW.EDGE_REACHED_PX;
    if (there || nowMinutes - d.walkingSince >= POPULATION_FLOW.WALK_TIMEOUT_MINUTES) {
      state.departing.delete(d.agentId);
      state.arrivedAt.delete(d.agentId);
      retireResident(d.agentId, 'left');
      continue;
    }
    // Something turned them around (a chat, a nudge): once free, set off again.
    if (action?.type !== 'talking' && action?.reason !== LEAVING_REASON) walkToEdge(agent.id, d.edge, nowMinutes);
  }
}

const LEAVING_REASON = 'leaving_town';

function walkToEdge(agentId: number, edge: { x: number; y: number }, nowMinutes: number): void {
  db.update(agents).set({
    current_action: { type: 'walking', to: { x: edge.x, y: edge.y }, reason: LEAVING_REASON },
    current_destination: { x: edge.x, y: edge.y },
    current_path: null,
    action_started: nowMinutes,
    action_duration: null,
    // On arrival movement.ts starts this: they wait at the road's end (the
    // decisions phase leaves a timed action alone) until the next pass retires them.
    action_queue: [{ type: 'idle', reason: LEAVING_REASON, _duration: 600 }],
  }).where(eq(agents.id, agentId)).run();
  emitter.markDirty('agents.all');
}

function sayGoodbye(agent: typeof agents.$inferSelect, d: Departure): void {
  const why = d.reasons.length > 0 ? ` — worn down by ${joinReasons(d.reasons)}` : '';
  logActivity({
    type: 'drama',
    initiator: agent.id,
    ...(agent.current_location != null ? { location: agent.current_location } : {}),
    templateData: { description: `${agent.name} has packed a bag and is leaving town for good${why}.` },
    metadata: { beat: 'departure' },
  });
  // Everyone close to them remembers the goodbye; the rest of the town hears
  // it through the feed and gossip like any news.
  for (const rel of livingTiesOf(agent.id)) {
    const { theirs, otherId } = feelingsToward(rel, agent.id);
    if (theirs <= POPULATION_FLOW.FRIEND_THRESHOLD) continue;
    const close = theirs > 70 || rel.status === 'partners';
    memoryService.record(otherId, 'observation',
      close
        ? `${agent.name} left town today for good. I can't believe they're gone — I'll miss them terribly.`
        : `${agent.name} packed up and left town today. I'll miss seeing them around.`,
      { subtype: 'life_event', related_agents: [agent.id] }, close ? -0.7 : -0.4, close ? 8 : 6);
  }
}

function runArrival(time: ClockTime, nowMinutes: number): void {
  const living = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const allLocations = db.select().from(locations).all();
  const world = db.select({ setup_config: worldState.setup_config }).from(worldState).limit(1).get();
  const seed = (world?.setup_config as { worldgen?: { seed?: unknown } } | null)?.worldgen?.seed ?? 'world';
  const rng = makeRng(stringToSeed(`arrival|${String(seed)}|${time.day}|${living.length}`));

  const livingJobs = economyJobsOf(living.map((a) => a.id));
  const job = pickArrivalJob(livingJobs, allLocations.map((l) => l.type), rng);
  const allNames = db.select({ name: agents.name }).from(agents).all().map((r) => r.name);
  const { name, gender } = pickArrivalName(allNames, rng);

  const created = createResident({ name, job, gender, arriveAt: 'edge', emptyHomeOnly: true, source: 'town' });
  if (!created.ok) return;
  state.lastArrivalAt = nowMinutes;
  state.arrivedAt.set(created.agentId, nowMinutes);

  const title = created.jobTitle.toLowerCase();
  const trade = job === 'unemployed' ? 'looking for work' : job === 'retired' ? 'come to retire' : `${/^[aeiou]/.test(title) ? 'an' : 'a'} ${title}`;
  logActivity({
    type: 'drama',
    initiator: created.agentId,
    location: created.homeId,
    templateData: { description: `A stranger has come up the road: ${name}, ${trade}, is moving into ${created.homeName}.` },
    metadata: { beat: 'arrival' },
  });
  // The decor and sound a player-introduced newcomer gets; the feed line above is the announcement.
  startWorldEvent('new_arrival', {
    triggeredBy: 'town',
    description: `${name} has moved to town!`,
    locationId: created.homeId,
    enforceLimits: false,
    announce: false,
  });
  for (const other of living) {
    memoryService.record(other.id, 'observation',
      `There's a new face in town: ${name} has just moved into ${created.homeName}${job === 'unemployed' || job === 'retired' ? '' : ` to work as ${/^[aeiou]/.test(title) ? 'an' : 'a'} ${title}`}.`,
      { subtype: 'new_arrival', related_agents: [created.agentId] }, 0.1, 3);
  }
  emitter.markDirty('agents.all');
}

/** Jobs held by these residents (economy rows). */
function economyJobsOf(ids: number[]): string[] {
  if (ids.length === 0) return [];
  return db.select({ job: economy.job }).from(economy).where(inArray(economy.agent_id, ids)).all().map((r) => r.job);
}

// ─── Being cared for ─────────────────────────────────────────────────────────

/**
 * The player reached out to these residents (money, a whispered thought, a
 * stirred feeling, a talk they arranged — routers/nudge.ts). Anyone among them
 * thinking of leaving stays: the player noticed, and that is the point of the
 * day's warning.
 */
/** `caredBy` of a thinker the player reached (not a resident's name). */
const PLAYER_CARE = '@player';

export function notePlayerCare(agentIds: readonly number[]): void {
  for (const id of agentIds) {
    const t = state.thinking.get(id);
    if (t && !t.caredBy) t.caredBy = PLAYER_CARE;
  }
}

interface ConversationEndedPayload {
  agentId: number;
  perpetratorId?: number | null;
  sentiment?: number;
}

/**
 * A conversation with a friend (their friendship toward the thinker above
 * FRIEND_THRESHOLD), or a warm one with anybody, is someone showing they care.
 * `conversation:ended` fires once per participant; the thinker's own event is
 * the one that counts.
 */
export function onConversationEnded(p: ConversationEndedPayload): void {
  const t = state.thinking.get(p.agentId);
  if (!t || t.caredBy || p.perpetratorId == null || p.perpetratorId === p.agentId) return;
  const lo = Math.min(p.agentId, p.perpetratorId);
  const hi = Math.max(p.agentId, p.perpetratorId);
  const rel = db.select().from(relationships)
    .where(and(eq(relationships.agent_a, lo), eq(relationships.agent_b, hi))).get();
  const theirs = rel ? feelingsToward(rel, p.agentId).theirs : 0;
  if (theirs > POPULATION_FLOW.FRIEND_THRESHOLD || (p.sentiment ?? 0) >= POPULATION_FLOW.CARING_SENTIMENT) {
    t.caredBy = firstName(nameOf(p.perpetratorId));
  }
}

/** Residents thinking of leaving or about to go, for the Brewing tab (lib/brewing.ts). */
export function leavingThoughts(): Array<{ agentId: number; reasons: DepartureReason[]; decided: boolean }> {
  return [
    ...[...state.thinking.values()].map((t) => ({ agentId: t.agentId, reasons: [...t.reasons], decided: false })),
    ...[...state.departing.values()].filter((d) => d.walkingSince == null)
      .map((d) => ({ agentId: d.agentId, reasons: [...d.reasons], decided: true })),
  ];
}

// ─── Registration ────────────────────────────────────────────────────────────

let initialized = false;

function initPopulationFlow(): void {
  if (initialized) return;
  initialized = true;
  simEvents.on('conversation:ended', (p: ConversationEndedPayload) => {
    try {
      onConversationEnded(p);
    } catch (err) {
      // A listener runs inside the emitting phase: never let this take the
      // conversation's own bookkeeping down with it.
      console.warn('[populationFlow] comfort check failed:', (err as Error).message);
    }
  });
}

// Auto-initialize on import
initPopulationFlow();
