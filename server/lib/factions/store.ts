/**
 * The feuds the town is living through: who fell out with whom, who has taken
 * which side, who is still making up their mind. See ./index.ts for the why.
 *
 * Pure: no DB. The wiring (./index.ts) reads people and writes effects; this
 * module is the store and its hard rules (how many feuds at once, cooldowns, the
 * caps that keep side-taking from snowballing).
 *
 * CLOCK: every stamp is GAME MINUTES.
 *
 * In memory, per world: cleared by worldCaches.ts on a world replace and
 * checkpointed to `sim_snapshots` (factionsSnapshotStore): a feud is days long,
 * and a restart in the middle must not forget who stands with whom.
 */
import { asNumber, asRecord, type SnapshotStore } from '../../engine/snapshotCodec';
import type { Side, Stance } from './decide';

const HOUR = 60;
const DAY = 24 * HOUR;

export const FACTIONS = {
  /** Feuds running at once: one per this many residents (at least 2). 13 residents → 2. */
  RESIDENTS_PER_FEUD: 6,
  MIN_ACTIVE: 2,
  /** People weighed per feud, closest first. */
  MAX_DECIDERS: 6,
  /** A person holds a side in at most this many feuds at once (the rest of the time they keep out). */
  MAX_SIDES_PER_PERSON: 1,
  /** Side-takers decide this long after the falling-out, plus up to DECIDE_SPREAD_MIN: over the following days. */
  DECIDE_AFTER_MIN: 4 * HOUR,
  DECIDE_SPREAD_MIN: 60 * HOUR,
  /** Friendship a side-taker loses toward the other principal, per decision... */
  SIDE_COOL: 5,
  /** ...and in all, ever, toward any one person through side-taking. */
  PAIR_COOL_CAP: 12,
  /** People on EACH side (besides the two who fell out) that make it a town feud: ≤16 residents → 2, more → 3. */
  TOWN_SIDE_MIN_SMALL: 2,
  TOWN_SIDE_MIN_LARGE: 3,
  SMALL_TOWN: 16,
  /** A feud with nothing new (no new clash, nobody taking sides) for this long has burned out. */
  QUIET_MIN: 6 * DAY,
  /** The same two cannot start another feud this soon after one ended. */
  PAIR_COOLDOWN_MIN: 7 * DAY,
  /** Slights (a skipped funeral, ingratitude) between a pair within this window... */
  SLIGHT_WINDOW_MIN: 14 * DAY,
  /** ...this many of them start one, or one when the pair was already cool. */
  SLIGHTS_TO_FEUD: 2,
  /** Side-takers' rows of one feud are gathered this long before one summary row goes out. */
  FLUSH_AFTER_MIN: 6 * HOUR,
  /** Opposite sides of a town feud avoid each other in free time (decisions/freeTime.ts via cliques.ts)... */
  TOWN_SOCIAL_PENALTY: -15,
  /** ...and a side-taker the principal they stood against, before it is a town feud. */
  SIDE_SOCIAL_PENALTY: -6,
} as const;

export interface Feud {
  id: number;
  /** The two who fell out. `a` is the aggrieved one when the cause has one (the lender, the mourner). */
  aId: number;
  bId: number;
  /** The relationship event type that started it ('fight', 'loan_unpaid', 'missed_funeral'...). */
  cause: string;
  /** "a public fight", "an unpaid loan": how the town speaks of it. Never a secret's content. */
  causeText: string;
  /** Who was in the wrong, when the cause says so (the borrower, the one who strayed), else null. */
  culprit: Side | null;
  /** Who knows who was in the wrong (a moral decider holds it against them). */
  culpritKnownBy: number[];
  /** The cause belongs to the adult layer (an affair): only adults are drawn in. */
  adultCause: boolean;
  startedAtMin: number;
  lastActivityMin: number;
  /** Everyone who has decided, and how. */
  stances: Map<number, Stance>;
  /** Friendship each side-taker lost toward the other principal in this feud (given back, half, on a reconciliation). */
  cooled: Map<number, number>;
  /** Still making up their mind: decider → when they decide. */
  pending: Map<number, number>;
  /** When it became a town feud (enough people on each side), or null. */
  townSinceMin: number | null;
  /** Newest last, at most LOG_MAX: the chronicle's beats. */
  log: Array<{ min: number; text: string }>;
  /** Decisions waiting for the summary row. */
  buffer: Array<{ id: number; stance: Stance; torn: boolean }>;
  flushAtMin: number | null;
}

const LOG_MAX = 8;

export type FeudEnd = 'reconciled' | 'gone' | 'faded';

export interface FactionTally {
  started: number;
  sided: number;
  neutral: number;
  torn: number;
  mediationsTried: number;
  mediationsSucceeded: number;
  townStarted: number;
  townEnded: number;
  ended: Record<FeudEnd, number>;
}

const feuds = new Map<number, Feud>();
const endedAt = new Map<string, number>();
const slights = new Map<string, number[]>();
/** `${who}>${toward}` → friendship lost through side-taking, ever (PAIR_COOL_CAP). */
const lifetimeCooled = new Map<string, number>();
/** Friendship given back after a reconciliation, a little at a time. */
let thaws: Array<{ fromId: number; toId: number; amount: number; dueMin: number }> = [];
let nextId = 1;
let tally: FactionTally = freshTally();

function freshTally(): FactionTally {
  return {
    started: 0, sided: 0, neutral: 0, torn: 0, mediationsTried: 0, mediationsSucceeded: 0,
    townStarted: 0, townEnded: 0, ended: { reconciled: 0, gone: 0, faded: 0 },
  };
}

export function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/** Since the last clear (scripts/soak.ts). */
export function factionTally(): FactionTally {
  return { ...tally, ended: { ...tally.ended } };
}

export function countTally(what: Exclude<keyof FactionTally, 'ended'>): void {
  tally[what]++;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function activeFeuds(): Feud[] {
  return [...feuds.values()];
}

export function feudById(id: number): Feud | null {
  return feuds.get(id) ?? null;
}

export function feudBetween(a: number, b: number): Feud | null {
  for (const f of feuds.values()) if (pairKey(f.aId, f.bId) === pairKey(a, b)) return f;
  return null;
}

/** Where `id` stands in `f`: a principal is on their own side. Null when they have no part in it. */
export function stanceIn(f: Feud, id: number): Stance | null {
  if (id === f.aId) return 'a';
  if (id === f.bId) return 'b';
  return f.stances.get(id) ?? null;
}

/** The side `id` holds in `f` ('a'/'b'), or null (neutral, a peacemaker, or no part). */
export function sideIn(f: Feud, id: number): Side | null {
  const s = stanceIn(f, id);
  return s === 'a' || s === 'b' ? s : null;
}

/** Feuds in which `id` has taken a side (not counting their own). */
export function sidesHeldBy(id: number): Feud[] {
  return activeFeuds().filter((f) => f.aId !== id && f.bId !== id && sideIn(f, id) != null);
}

/** People on each side, principals excluded. */
export function sideCounts(f: Feud): { a: number[]; b: number[] } {
  const a: number[] = [], b: number[] = [];
  for (const [id, s] of f.stances) {
    if (s === 'a') a.push(id);
    else if (s === 'b') b.push(id);
  }
  return { a, b };
}

/**
 * Two people on opposite sides of a live feud: the free-time penalty between
 * them (0 when they aren't). A town feud splits everyone on it; before that only
 * a side-taker and the principal they stood against keep apart. The principals
 * themselves are left to the feelings they already have.
 */
export function feudSocialPenalty(x: number, y: number): number {
  let worst = 0;
  for (const f of feuds.values()) {
    const sx = sideIn(f, x), sy = sideIn(f, y);
    if (sx == null || sy == null || sx === sy) continue;
    const principals = [f.aId, f.bId];
    if (principals.includes(x) && principals.includes(y)) continue;
    const pen = f.townSinceMin != null ? FACTIONS.TOWN_SOCIAL_PENALTY
      : principals.includes(x) || principals.includes(y) ? FACTIONS.SIDE_SOCIAL_PENALTY : 0;
    worst = Math.min(worst, pen);
  }
  return worst;
}

/** On opposite sides of a TOWN feud (they don't sit together at a gathering). */
export function opposedInTownFeud(x: number, y: number): boolean {
  for (const f of feuds.values()) {
    if (f.townSinceMin == null) continue;
    const sx = sideIn(f, x), sy = sideIn(f, y);
    if (sx != null && sy != null && sx !== sy) return true;
  }
  return false;
}

/** Each town feud's two camps, principals included (the election reads them). */
export function townCamps(): Array<{ a: number[]; b: number[] }> {
  return activeFeuds().filter((f) => f.townSinceMin != null).map((f) => {
    const c = sideCounts(f);
    return { a: [f.aId, ...c.a], b: [f.bId, ...c.b] };
  });
}

export function maxActiveFeuds(population: number): number {
  return Math.max(FACTIONS.MIN_ACTIVE, Math.floor(population / FACTIONS.RESIDENTS_PER_FEUD));
}

export function townSideMin(population: number): number {
  return population <= FACTIONS.SMALL_TOWN ? FACTIONS.TOWN_SIDE_MIN_SMALL : FACTIONS.TOWN_SIDE_MIN_LARGE;
}

// ─── Starting and ending ─────────────────────────────────────────────────────

export interface StartFeudRequest {
  aId: number;
  bId: number;
  cause: string;
  causeText: string;
  culprit: Side | null;
  culpritKnownBy: number[];
  adultCause: boolean;
  nowMin: number;
  population: number;
}

/**
 * A falling-out that may split the town. Null when the pair is already feuding
 * (the clash only freshens it), cooling off after the last one, or the town
 * already has as many feuds as it can carry.
 */
export function startFeud(req: StartFeudRequest): Feud | null {
  if (req.aId === req.bId) return null;
  const live = feudBetween(req.aId, req.bId);
  if (live) {
    live.lastActivityMin = req.nowMin;
    return null;
  }
  const ended = endedAt.get(pairKey(req.aId, req.bId));
  if (ended != null && req.nowMin - ended < FACTIONS.PAIR_COOLDOWN_MIN) return null;
  if (feuds.size >= maxActiveFeuds(req.population)) return null;
  const f: Feud = {
    id: nextId++,
    aId: req.aId, bId: req.bId,
    cause: req.cause, causeText: req.causeText,
    culprit: req.culprit, culpritKnownBy: [...req.culpritKnownBy],
    adultCause: req.adultCause,
    startedAtMin: req.nowMin, lastActivityMin: req.nowMin,
    stances: new Map(), cooled: new Map(), pending: new Map(),
    townSinceMin: null, log: [], buffer: [], flushAtMin: null,
  };
  feuds.set(f.id, f);
  tally.started++;
  return f;
}

export function addLog(f: Feud, min: number, text: string): void {
  f.log.push({ min, text });
  if (f.log.length > LOG_MAX) f.log = f.log.slice(-LOG_MAX);
}

/** The feud is over: forgotten (its pair cools off for a while). */
export function endFeud(f: Feud, reason: FeudEnd, nowMin: number): void {
  feuds.delete(f.id);
  endedAt.set(pairKey(f.aId, f.bId), nowMin);
  tally.ended[reason]++;
  if (f.townSinceMin != null) tally.townEnded++;
}

/** A slight between the pair (a skipped funeral, ingratitude): how many in the window, this one included. */
export function noteSlight(a: number, b: number, nowMin: number): number {
  const key = pairKey(a, b);
  const recent = (slights.get(key) ?? []).filter((m) => m > nowMin - FACTIONS.SLIGHT_WINDOW_MIN);
  recent.push(nowMin);
  slights.set(key, recent);
  return recent.length;
}

/** Friendship `who` may still lose toward `toward` through side-taking (PAIR_COOL_CAP), at most `want`. */
export function coolAllowance(who: number, toward: number, want: number): number {
  const lost = lifetimeCooled.get(`${who}>${toward}`) ?? 0;
  return Math.max(0, Math.min(want, FACTIONS.PAIR_COOL_CAP - lost));
}

export function noteCooled(who: number, toward: number, amount: number): void {
  const key = `${who}>${toward}`;
  lifetimeCooled.set(key, Math.max(0, (lifetimeCooled.get(key) ?? 0) + amount));
}

export function addThaw(fromId: number, toId: number, amount: number, dueMin: number): void {
  thaws.push({ fromId, toId, amount, dueMin });
}

/** Thaws come due (and are dropped from the list). */
export function takeDueThaws(nowMin: number): Array<{ fromId: number; toId: number; amount: number }> {
  const due = thaws.filter((t) => t.dueMin <= nowMin);
  if (due.length > 0) thaws = thaws.filter((t) => t.dueMin > nowMin);
  return due;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function clearFactions(): void {
  feuds.clear();
  endedAt.clear();
  slights.clear();
  lifetimeCooled.clear();
  thaws = [];
  nextId = 1;
  tally = freshTally();
}

const STANCES: ReadonlySet<string> = new Set(['a', 'b', 'neutral', 'mediator']);

function readIdMap<T>(v: unknown, read: (x: unknown) => T | null): Map<number, T> {
  const out = new Map<number, T>();
  for (const raw of Array.isArray(v) ? v : []) {
    if (!Array.isArray(raw)) continue;
    const id = asNumber(raw[0]);
    const val = read(raw[1]);
    if (id !== null && val !== null) out.set(id, val);
  }
  return out;
}

function readFeud(v: unknown): Feud | null {
  const r = asRecord(v);
  if (!r) return null;
  const id = asNumber(r.id), aId = asNumber(r.aId), bId = asNumber(r.bId);
  const startedAtMin = asNumber(r.startedAtMin), lastActivityMin = asNumber(r.lastActivityMin);
  if (id === null || aId === null || bId === null || startedAtMin === null || lastActivityMin === null) return null;
  const culprit = r.culprit === 'a' || r.culprit === 'b' ? r.culprit : null;
  return {
    id, aId, bId,
    cause: typeof r.cause === 'string' ? r.cause : 'quarrel',
    causeText: typeof r.causeText === 'string' ? r.causeText : 'a falling-out',
    culprit,
    culpritKnownBy: (Array.isArray(r.culpritKnownBy) ? r.culpritKnownBy : []).map(asNumber).filter((x): x is number => x !== null),
    adultCause: r.adultCause === true,
    startedAtMin, lastActivityMin,
    stances: readIdMap(r.stances, (x) => (typeof x === 'string' && STANCES.has(x) ? x as Stance : null)),
    cooled: readIdMap(r.cooled, asNumber),
    pending: readIdMap(r.pending, asNumber),
    townSinceMin: asNumber(r.townSinceMin),
    log: (Array.isArray(r.log) ? r.log : []).map((x) => {
      const e = asRecord(x);
      const min = asNumber(e?.min);
      return e && min !== null && typeof e.text === 'string' ? { min, text: e.text } : null;
    }).filter((x): x is { min: number; text: string } => x !== null),
    buffer: (Array.isArray(r.buffer) ? r.buffer : []).map((x) => {
      const e = asRecord(x);
      const bid = asNumber(e?.id);
      return e && bid !== null && typeof e.stance === 'string' && STANCES.has(e.stance)
        ? { id: bid, stance: e.stance as Stance, torn: e.torn === true } : null;
    }).filter((x): x is { id: number; stance: Stance; torn: boolean } => x !== null),
    flushAtMin: asNumber(r.flushAtMin),
  };
}

function readNumberMap(v: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, x] of Object.entries(asRecord(v) ?? {})) {
    const n = asNumber(x);
    if (n !== null) out.set(k, n);
  }
  return out;
}

/** Checkpoint (server/engine/simSnapshots.ts). */
export const factionsSnapshotStore: SnapshotStore = {
  key: 'factions',
  version: 1,
  serialize() {
    return {
      nextId,
      feuds: [...feuds.values()].map((f) => ({
        ...f,
        stances: [...f.stances], cooled: [...f.cooled], pending: [...f.pending],
      })),
      endedAt: Object.fromEntries(endedAt),
      slights: Object.fromEntries(slights),
      lifetimeCooled: Object.fromEntries(lifetimeCooled),
      thaws,
    };
  },
  restore(data) {
    clearFactions();
    const r = asRecord(data);
    if (!r) return;
    for (const raw of Array.isArray(r.feuds) ? r.feuds : []) {
      const f = readFeud(raw);
      if (f) feuds.set(f.id, f);
    }
    for (const [k, n] of readNumberMap(r.endedAt)) endedAt.set(k, n);
    for (const [k, n] of readNumberMap(r.lifetimeCooled)) lifetimeCooled.set(k, n);
    for (const [k, v] of Object.entries(asRecord(r.slights) ?? {})) {
      if (Array.isArray(v)) slights.set(k, v.map(asNumber).filter((x): x is number => x !== null));
    }
    thaws = (Array.isArray(r.thaws) ? r.thaws : []).map((x) => {
      const t = asRecord(x);
      const fromId = asNumber(t?.fromId), toId = asNumber(t?.toId), amount = asNumber(t?.amount), dueMin = asNumber(t?.dueMin);
      return fromId !== null && toId !== null && amount !== null && dueMin !== null ? { fromId, toId, amount, dueMin } : null;
    }).filter((x): x is { fromId: number; toId: number; amount: number; dueMin: number } => x !== null);
    nextId = Math.max(asNumber(r.nextId) ?? 1, Math.max(0, ...feuds.keys()) + 1);
  },
};
