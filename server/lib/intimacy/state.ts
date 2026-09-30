import { asId, asNumber, asRecord, type SnapshotStore } from '../../engine/snapshotCodec';
import { clamp, pairKey } from '../utils';

// ─── In-memory intimacy state ────────────────────────────────────────────────
//
// What two people have shared (kisses, nights together, an invitation waiting
// for an answer) and what one person carries (longing, suspicion of a partner).
// The durable truth about a couple stays in the DB (the `kissed` / `lovers`
// relationship tags, feed rows, facts); this is the bookkeeping that would be
// wasteful or awkward as columns, shaped like lib/milestonesEngine.ts: a
// module-level Map keyed by `pairKey`, a snapshot store checkpointed to
// sim_snapshots, and a clear for world replace (both registered in
// engine/worldCaches.ts).
//
// All stamps are GAME MINUTES (`gameMinutes(time)`), never ticks.

export interface PairIntimacy {
  firstKissAt?: number;
  lastKissAt?: number;
  kisses: number;
  trysts: number;
  firstTrystAt?: number;
  lastTrystAt?: number;
  /**
   * An invitation waiting for its answer, then the evening it was made for
   * (lib/intimacy/rendezvous.ts writes it, tryst.ts consumes it).
   *
   * Two phases, told apart by `agreed`:
   * - asked (`agreed` absent): `initiatorId` invited the other at game minute
   *   `since`; the answer is still to come. Dropped after ~3 game hours.
   * - agreed (`agreed: true`): both said yes (or, for a married couple who are
   *   home together, both were willing and nobody had to ask). `agreedAt` is the
   *   game minute it was settled. `venueId` is set only when the couple are at
   *   their own home right now; otherwise tryst.ts's `pickVenue` chooses it.
   *   tryst.ts owns everything after this: it picks the venue, walks the pair
   *   there and clears the pending when the night begins. An agreed pending
   *   nobody acts on is dropped ~6 game hours after `agreedAt`.
   */
  pendingRendezvous?: { initiatorId: number; since: number; venueId?: number; agreed?: true; agreedAt?: number };
  /**
   * The evening in progress (tryst.ts): from the moment both are at the venue
   * until `endsAt`, when the pass ends it and calls `onTrystCompleted` (or
   * sooner, when somebody walks in). Kept here rather than read back from the
   * two agents' actions so the completion fires exactly once and the rendezvous
   * pass can see the pair is spoken for tonight.
   */
  activeTryst?: { venueId: number; startedAt: number; endsAt: number; secret: boolean };
  /** No new invitation for this pair before this game minute (after a refusal). */
  rendezvousRetryAfter?: number;
  /**
   * Nobody in town knows about their nights (yet). tryst.ts sets it when an evening
   * begins for a pair who must hide it (spoken for elsewhere, or same-sex in 1900) and
   * clears it the first time somebody sees them (`reportCaught`). Read by the
   * dialogue context (ai/intimacyContext.ts: "nobody may know").
   */
  secret: boolean;
}

export interface AgentIntimacy {
  /** 0..100; grows while the adult layer is on, forced to 0 while it is off. */
  longing: number;
  /** partnerId → 0..100, how sure they are their partner strayed. */
  suspicion: Record<number, number>;
  /**
   * The last night this person spent as a guest in somebody else's home (tryst.ts
   * writes it when the evening ends and the guest stays). Kept apart from the
   * `Stay` because a stay is cleared half an hour after the walk home, long
   * before the next morning's suspicion pass (suspicion.ts) reads it, and that
   * pass consumes it: one absence is counted once.
   */
  awayNight?: { since: number; hostId: number };
}

/**
 * A night spent at somebody else's home (tryst.ts). Only the GUEST has one: the
 * host sleeps in their own bed like any other night.
 */
export interface Stay {
  /** The home they are staying at. */
  locationId: number;
  /** The other half of the pair, whose home it is. */
  hostId: number;
  /** Game minute after which the stay lapses on its own (a stay nobody ended). */
  until: number;
  /** Set when they are told to go now (somebody walked in): the next decision is the walk home. */
  leaving?: boolean;
  /**
   * The guest has been seen asleep at the venue tonight. Dawn is "awake again after
   * having slept here", judged from this flag and not from the guest's current
   * action, which a higher-scoring decision (an emergency meal, say) may already
   * have replaced by the time the wake-up decision comes round.
   */
  slept?: true;
  /** A `caught` feed row was already written for this stay: later witnesses learn the fact silently. */
  caughtLogged?: true;
  /** Game minute the walk home began; the witness watch runs for a while after it. */
  leftAt?: number;
  /** Everyone who already saw them leave, so the same sighting is not reported twice. */
  seenBy: number[];
}

/** Keyed by `pairKey` (lower id first). */
const pairs = new Map<string, PairIntimacy>();
const agentsIntimacy = new Map<number, AgentIntimacy>();
/** Guest agent id -> where they sleep tonight. */
const stays = new Map<number, Stay>();

/**
 * Game minute up to which longing has been applied (null before the first
 * pass). Kept next to the state so a world replace resets it with the rest:
 * the new world's clock starts over and a stale stamp would sit in the future.
 */
let longingProcessedAt: number | null = null;

/**
 * Game day the morning suspicion pass last ran for (null before the first). Same
 * rationale as `longingProcessedAt`: it lives here so a world replace resets it.
 */
let suspicionProcessedDay: number | null = null;

export function getSuspicionProcessedDay(): number | null {
  return suspicionProcessedDay;
}

export function setSuspicionProcessedDay(day: number | null): void {
  suspicionProcessedDay = day;
}

export function getLongingProcessedAt(): number | null {
  return longingProcessedAt;
}

export function setLongingProcessedAt(minute: number | null): void {
  longingProcessedAt = minute;
}

const blankPair = (): PairIntimacy => ({ kisses: 0, trysts: 0, secret: false });
const blankAgent = (): AgentIntimacy => ({ longing: 0, suspicion: {} });

/** Read-only view for tests and diagnostics; `undefined` when nothing happened yet. */
export function getPairIntimacy(a: number, b: number): Readonly<PairIntimacy> | undefined {
  return pairs.get(pairKey(a, b));
}

export function ensurePairIntimacy(a: number, b: number): PairIntimacy {
  const key = pairKey(a, b);
  let p = pairs.get(key);
  if (!p) {
    p = blankPair();
    pairs.set(key, p);
  }
  return p;
}

/** Patch a pair's state in place (creating it on first touch). */
export function updatePairIntimacy(a: number, b: number, patch: (p: PairIntimacy) => void): PairIntimacy {
  const p = ensurePairIntimacy(a, b);
  patch(p);
  return p;
}

export function getAgentIntimacy(id: number): Readonly<AgentIntimacy> | undefined {
  return agentsIntimacy.get(id);
}

export function ensureAgentIntimacy(id: number): AgentIntimacy {
  let a = agentsIntimacy.get(id);
  if (!a) {
    a = blankAgent();
    agentsIntimacy.set(id, a);
  }
  return a;
}

export function updateAgentIntimacy(id: number, patch: (a: AgentIntimacy) => void): AgentIntimacy {
  const a = ensureAgentIntimacy(id);
  patch(a);
  return a;
}

/** Visit every pair that has state (`key` is the `pairKey`); the passes patch values in place. */
export function forEachPairIntimacy(fn: (key: string, p: PairIntimacy) => void): void {
  for (const [k, p] of pairs) fn(k, p);
}

/** Visit every agent that has state; the passes only patch values, never add or remove entries. */
export function forEachAgentIntimacy(fn: (id: number, a: AgentIntimacy) => void): void {
  for (const [id, a] of agentsIntimacy) fn(id, a);
}

export function getStay(agentId: number): Readonly<Stay> | undefined {
  return stays.get(agentId);
}

/** Start (or replace) a guest's stay. */
export function setStay(agentId: number, stay: Omit<Stay, 'seenBy'> & { seenBy?: number[] }): Stay {
  const s: Stay = { ...stay, seenBy: [...(stay.seenBy ?? [])] };
  stays.set(agentId, s);
  return s;
}

/** Patch a stay in place; a no-op when there is none. */
export function updateStay(agentId: number, patch: (s: Stay) => void): void {
  const s = stays.get(agentId);
  if (s) patch(s);
}

export function clearStay(agentId: number): void {
  stays.delete(agentId);
}

/** Visit every stay (`agentId` is the guest); collect first if the visit removes entries. */
export function forEachStay(fn: (agentId: number, s: Stay) => void): void {
  for (const [id, s] of stays) fn(id, s);
}

/** Drop everything (world replace: agent ids are reused and the clock restarts). */
export function clearIntimacy(): void {
  pairs.clear();
  agentsIntimacy.clear();
  stays.clear();
  longingProcessedAt = null;
  suspicionProcessedDay = null;
}

// ─── Checkpoint ──────────────────────────────────────────────────────────────

const asCount = (v: unknown): number => Math.max(0, Math.floor(asNumber(v) ?? 0));

function restorePair(raw: unknown): PairIntimacy | null {
  const r = asRecord(raw);
  if (!r) return null;
  const p = blankPair();
  p.kisses = asCount(r.kisses);
  p.trysts = asCount(r.trysts);
  p.secret = r.secret === true;
  for (const k of ['firstKissAt', 'lastKissAt', 'firstTrystAt', 'lastTrystAt', 'rendezvousRetryAfter'] as const) {
    const n = asNumber(r[k]);
    if (n !== null) p[k] = n;
  }
  const rv = asRecord(r.pendingRendezvous);
  const initiatorId = rv ? asNumber(rv.initiatorId) : null;
  const since = rv ? asNumber(rv.since) : null;
  if (rv && initiatorId !== null && since !== null) {
    const venueId = asNumber(rv.venueId);
    const agreedAt = asNumber(rv.agreedAt);
    p.pendingRendezvous = { initiatorId, since };
    if (venueId !== null) p.pendingRendezvous.venueId = venueId;
    if (rv.agreed === true) {
      p.pendingRendezvous.agreed = true;
      if (agreedAt !== null) p.pendingRendezvous.agreedAt = agreedAt;
    }
  }
  const at = asRecord(r.activeTryst);
  const venueId = at ? asNumber(at.venueId) : null;
  const startedAt = at ? asNumber(at.startedAt) : null;
  const endsAt = at ? asNumber(at.endsAt) : null;
  if (at && venueId !== null && startedAt !== null && endsAt !== null) {
    p.activeTryst = { venueId, startedAt, endsAt, secret: at.secret === true };
  }
  return p;
}

function restoreStay(raw: unknown): Stay | null {
  const r = asRecord(raw);
  if (!r) return null;
  const locationId = asNumber(r.locationId);
  const hostId = asNumber(r.hostId);
  const until = asNumber(r.until);
  if (locationId === null || hostId === null || until === null) return null;
  const stay: Stay = { locationId, hostId, until, seenBy: [] };
  if (r.leaving === true) stay.leaving = true;
  if (r.slept === true) stay.slept = true;
  if (r.caughtLogged === true) stay.caughtLogged = true;
  const leftAt = asNumber(r.leftAt);
  if (leftAt !== null) stay.leftAt = leftAt;
  if (Array.isArray(r.seenBy)) {
    for (const v of r.seenBy) {
      const id = asNumber(v);
      if (id !== null) stay.seenBy.push(id);
    }
  }
  return stay;
}

function restoreAgent(raw: unknown): AgentIntimacy | null {
  const r = asRecord(raw);
  if (!r) return null;
  const a = blankAgent();
  a.longing = clamp(asNumber(r.longing) ?? 0, 0, 100);
  for (const [k, v] of Object.entries(asRecord(r.suspicion) ?? {})) {
    const partner = asId(k);
    const level = asNumber(v);
    if (partner !== null && level !== null) a.suspicion[partner] = clamp(level, 0, 100);
  }
  const away = asRecord(r.awayNight);
  const since = away ? asNumber(away.since) : null;
  const hostId = away ? asNumber(away.hostId) : null;
  if (since !== null && hostId !== null) a.awayNight = { since, hostId };
  return a;
}

/**
 * Checkpoint: { pairs: {[pairKey]: PairIntimacy}, agents: {[id]: AgentIntimacy},
 * stays: {[guestId]: Stay}, longingAt, suspicionDay }. `stays` is absent from checkpoints
 * written before the tryst existed (restore reads it as empty). Always an object (never undefined), so an empty town still
 * overwrites an older world's row.
 */
export const intimacySnapshotStore: SnapshotStore = {
  key: 'intimacy',
  version: 1,
  serialize: () => {
    const outPairs: Record<string, PairIntimacy> = {};
    for (const [k, v] of pairs) {
      outPairs[k] = {
        ...v,
        ...(v.pendingRendezvous ? { pendingRendezvous: { ...v.pendingRendezvous } } : {}),
        ...(v.activeTryst ? { activeTryst: { ...v.activeTryst } } : {}),
      };
    }
    const outAgents: Record<string, AgentIntimacy> = {};
    for (const [k, v] of agentsIntimacy) {
      outAgents[String(k)] = { ...v, suspicion: { ...v.suspicion }, ...(v.awayNight ? { awayNight: { ...v.awayNight } } : {}) };
    }
    const outStays: Record<string, Stay> = {};
    for (const [k, v] of stays) outStays[String(k)] = { ...v, seenBy: [...v.seenBy] };
    return {
      pairs: outPairs, agents: outAgents, stays: outStays,
      longingAt: longingProcessedAt, suspicionDay: suspicionProcessedDay,
    };
  },
  restore: (data) => {
    clearIntimacy();
    const root = asRecord(data);
    if (!root) return;
    for (const [k, raw] of Object.entries(asRecord(root.pairs) ?? {})) {
      if (!/^\d+-\d+$/.test(k)) continue;
      const p = restorePair(raw);
      if (p) pairs.set(k, p);
    }
    for (const [k, raw] of Object.entries(asRecord(root.agents) ?? {})) {
      const id = asId(k);
      if (id === null) continue;
      const a = restoreAgent(raw);
      if (a) agentsIntimacy.set(id, a);
    }
    for (const [k, raw] of Object.entries(asRecord(root.stays) ?? {})) {
      const id = asId(k);
      if (id === null) continue;
      const stay = restoreStay(raw);
      if (stay) stays.set(id, stay);
    }
    longingProcessedAt = asNumber(root.longingAt);
    suspicionProcessedDay = asNumber(root.suspicionDay);
  },
};
