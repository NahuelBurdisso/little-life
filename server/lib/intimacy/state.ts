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
  /** An invitation waiting for its answer / the evening it was made for. */
  pendingRendezvous?: { initiatorId: number; since: number; venueId?: number };
  /** No new invitation for this pair before this game minute (after a refusal). */
  rendezvousRetryAfter?: number;
  /** Nobody in town knows (yet). Flips false when it gets out. */
  secret: boolean;
}

export interface AgentIntimacy {
  /** 0..100; grows while the adult layer is on, forced to 0 while it is off. */
  longing: number;
  /** Game minute of the last kiss or night together. */
  lastTouchedAt?: number;
  /** partnerId → 0..100, how sure they are their partner strayed. */
  suspicion: Record<number, number>;
}

/** Keyed by `pairKey` (lower id first). */
const pairs = new Map<string, PairIntimacy>();
const agentsIntimacy = new Map<number, AgentIntimacy>();

/**
 * Game minute up to which longing has been applied (null before the first
 * pass). Kept next to the state so a world replace resets it with the rest:
 * the new world's clock starts over and a stale stamp would sit in the future.
 */
let longingProcessedAt: number | null = null;

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

/** Visit every agent that has state; the passes only patch values, never add or remove entries. */
export function forEachAgentIntimacy(fn: (id: number, a: AgentIntimacy) => void): void {
  for (const [id, a] of agentsIntimacy) fn(id, a);
}

/** Drop everything (world replace: agent ids are reused and the clock restarts). */
export function clearIntimacy(): void {
  pairs.clear();
  agentsIntimacy.clear();
  longingProcessedAt = null;
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
    p.pendingRendezvous = venueId !== null ? { initiatorId, since, venueId } : { initiatorId, since };
  }
  return p;
}

function restoreAgent(raw: unknown): AgentIntimacy | null {
  const r = asRecord(raw);
  if (!r) return null;
  const a = blankAgent();
  a.longing = clamp(asNumber(r.longing) ?? 0, 0, 100);
  const touched = asNumber(r.lastTouchedAt);
  if (touched !== null) a.lastTouchedAt = touched;
  for (const [k, v] of Object.entries(asRecord(r.suspicion) ?? {})) {
    const partner = asId(k);
    const level = asNumber(v);
    if (partner !== null && level !== null) a.suspicion[partner] = clamp(level, 0, 100);
  }
  return a;
}

/**
 * Checkpoint: { pairs: {[pairKey]: PairIntimacy}, agents: {[id]: AgentIntimacy},
 * longingAt }. Always an object (never undefined), so an empty town still
 * overwrites an older world's row.
 */
export const intimacySnapshotStore: SnapshotStore = {
  key: 'intimacy',
  version: 1,
  serialize: () => {
    const outPairs: Record<string, PairIntimacy> = {};
    for (const [k, v] of pairs) {
      outPairs[k] = { ...v, ...(v.pendingRendezvous ? { pendingRendezvous: { ...v.pendingRendezvous } } : {}) };
    }
    const outAgents: Record<string, AgentIntimacy> = {};
    for (const [k, v] of agentsIntimacy) outAgents[String(k)] = { ...v, suspicion: { ...v.suspicion } };
    return { pairs: outPairs, agents: outAgents, longingAt: longingProcessedAt };
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
    longingProcessedAt = asNumber(root.longingAt);
  },
};
