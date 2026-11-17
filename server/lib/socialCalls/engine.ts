/**
 * Social calls: residents going out of their way for someone because of what
 * happened to them.
 *
 * Why this exists. An audit found that when something happened to a resident
 * (an illness, a death in the family, a birthday, a new face in town) nobody
 * went to them: the only proactive "go and see them" in the sim was the
 * loneliness comfort visit (lonelinessEngine.ts). Everything else needed the two
 * to already be in the same room, so life events had no social consequence and
 * the town felt dead. This generalises the comfort visit:
 *
 *   producer (a simEvents listener, kinds.ts/listeners.ts) → `scheduleCall`
 *   → the decision phase walks the caller over (decisions/phases.ts `socialCallPhase`)
 *   → once together a 2-person conversation is queued (`trigger_reason: 'social_call:<kind>'`)
 *   → on `conversation:ended` the kind's consequence runs (items, mood, memories, one feed row).
 *
 * This module is the store and its rules, nothing else: which kinds exist and
 * what they do is the registry's (kinds.ts), so later passes add kinds without
 * touching it. Pure: no DB import; the kinds' callbacks do their own DB work.
 *
 * Balance lives here as hard rules, because a listener that fires for every
 * mourner of a death or every friend of a new mother could otherwise send half
 * the town walking at once: one pending call per caller, a cap of callers per
 * target and kind, a per-pair cooldown per kind. Producers add a per-target
 * cooldown and the stagger (`notBeforeMin`) on top.
 *
 * CLOCK: every stamp is GAME MINUTES.
 *
 * In memory, per world: cleared by worldCaches.ts on a world replace and
 * checkpointed to `sim_snapshots` (socialCallsSnapshotStore) so a restart does
 * not forget who promised to visit whom.
 */
import { asNumber, asRecord, type SnapshotStore } from '../../engine/snapshotCodec';
import type { CallOutcome, CallPayload, CallRecord, CallWatch, SocialCall, SocialCallKind } from './types';

const kinds = new Map<string, SocialCallKind>();
const pending = new Map<number, SocialCall>();
let history: CallRecord[] = [];
/** callerId → who they are staying with, and until when (a vigil at the bedside). */
const lingers = new Map<number, { targetId: number; untilMin: number; callId: number }>();
let watches: CallWatch[] = [];
let nextId = 1;
/** Per kind: how many calls were promised and how each ended (diagnostics: the soak prints it). */
const tally = new Map<string, Record<'scheduled' | CallOutcome, number>>();

function count(kind: string, what: 'scheduled' | CallOutcome): void {
  const t = tally.get(kind) ?? { scheduled: 0, made: 0, expired: 0, dropped: 0 };
  t[what]++;
  tally.set(kind, t);
}

/** Promised / made / expired / dropped per kind since the last clear (scripts/soak.ts). */
export function socialCallTally(): Record<string, Record<'scheduled' | CallOutcome, number>> {
  return Object.fromEntries([...tally].map(([k, v]) => [k, { ...v }]));
}

/** History older than this is forgotten: no cooldown or "who came" question looks further back. */
const HISTORY_KEEP_MIN = 30 * 24 * 60;
const HISTORY_MAX = 600;

// ─── The registry ────────────────────────────────────────────────────────────

/** Add (or replace) a kind. kinds.ts registers the built-in ones on import. */
export function registerSocialCallKind(def: SocialCallKind): void {
  kinds.set(def.id, def);
}

export function socialCallKind(id: string): SocialCallKind | null {
  return kinds.get(id) ?? null;
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

export interface ScheduleRequest {
  kind: string;
  callerId: number;
  targetId: number;
  nowMin: number;
  /** Default: now. */
  notBeforeMin?: number;
  /** Default: notBefore + the kind's window. */
  expiresAtMin?: number;
  payload?: CallPayload;
}

/**
 * Promise a call, or null when the rules refuse it: the kind is unknown, the
 * caller would call on themselves, already promised this one, is on another
 * call (an urgent call replaces a non-urgent one), the target already has the
 * kind's cap of callers coming, or this caller made this kind of call to this
 * target inside the kind's cooldown.
 */
export function scheduleCall(req: ScheduleRequest): SocialCall | null {
  const def = kinds.get(req.kind);
  if (!def || req.callerId === req.targetId) return null;
  const all = [...pending.values()];
  if (all.some((c) => c.kind === req.kind && c.callerId === req.callerId && c.targetId === req.targetId)) return null;
  if (all.filter((c) => c.kind === req.kind && c.targetId === req.targetId).length >= def.maxPendingPerTarget) return null;
  const since = req.nowMin - def.pairCooldownMin;
  if (history.some((r) => r.kind === req.kind && r.callerId === req.callerId && r.targetId === req.targetId
    && r.outcome === 'made' && r.atMin > since)) return null;

  const current = all.find((c) => c.callerId === req.callerId);
  if (current) {
    // One call at a time: a vigil at a deathbed is the exception that bumps a
    // birthday wish, never the other way round.
    if (!def.urgent || current.urgent) return null;
    finish(current, 'dropped', req.nowMin, null);
  }

  const notBeforeMin = req.notBeforeMin ?? req.nowMin;
  const call: SocialCall = {
    id: nextId++,
    kind: req.kind,
    callerId: req.callerId,
    targetId: req.targetId,
    createdAtMin: req.nowMin,
    notBeforeMin,
    expiresAtMin: req.expiresAtMin ?? notBeforeMin + def.windowMin,
    urgent: def.urgent === true,
    payload: { ...(req.payload ?? {}) },
    seatedAtMin: null,
  };
  pending.set(call.id, call);
  count(call.kind, 'scheduled');
  return call;
}

/** Calls on their way to `targetId` (optionally of one kind). */
export function pendingCallsFor(targetId: number, kind?: string): SocialCall[] {
  return [...pending.values()].filter((c) => c.targetId === targetId && (kind == null || c.kind === kind));
}

/** The call `callerId` has promised, if any, due or not. */
export function callOf(callerId: number): SocialCall | null {
  for (const c of pending.values()) if (c.callerId === callerId) return c;
  return null;
}

/** Every pending call (the hourly sweep, diagnostics). */
export function allPendingCalls(): SocialCall[] {
  return [...pending.values()];
}

/**
 * Calls actually made to `targetId` since `sinceMin` (optionally of one kind).
 * "Who came" — a vigil kept, a birthday remembered — is read from here.
 */
export function callsMadeTo(targetId: number, kind?: string, sinceMin = Number.NEGATIVE_INFINITY): CallRecord[] {
  return history.filter((r) => r.targetId === targetId && r.outcome === 'made'
    && (kind == null || r.kind === kind) && r.atMin >= sinceMin);
}

/** Every record about `targetId` since `sinceMin` (made, expired, dropped). */
export function callRecordsFor(targetId: number, kind?: string, sinceMin = Number.NEGATIVE_INFINITY): CallRecord[] {
  return history.filter((r) => r.targetId === targetId && (kind == null || r.kind === kind) && r.atMin >= sinceMin);
}

/** The conversation for this call has been seated: the caller is with the target. */
export function markSeated(callId: number, nowMin: number): void {
  const c = pending.get(callId);
  if (c && c.seatedAtMin == null) c.seatedAtMin = nowMin;
}

/**
 * The call is over. `made` runs nothing here (the caller ran the consequence);
 * `expired` runs the kind's `onMissed` (the caller never came); `dropped` is
 * silent (someone died, left or went to jail, or an urgent call took its place).
 */
export function finishCall(callId: number, outcome: CallOutcome, nowMin: number, good: boolean | null = null): void {
  const c = pending.get(callId);
  if (c) finish(c, outcome, nowMin, good);
}

function finish(c: SocialCall, outcome: CallOutcome, nowMin: number, good: boolean | null): void {
  pending.delete(c.id);
  count(c.kind, outcome);
  history.push({ id: c.id, kind: c.kind, callerId: c.callerId, targetId: c.targetId, atMin: nowMin, outcome, good, payload: c.payload });
  pruneHistory(nowMin);
  if (outcome === 'expired') kinds.get(c.kind)?.onMissed?.(c, nowMin);
}

function pruneHistory(nowMin: number): void {
  const cutoff = nowMin - HISTORY_KEEP_MIN;
  if (history.length > HISTORY_MAX || (history[0] && history[0].atMin < cutoff)) {
    history = history.filter((r) => r.atMin >= cutoff).slice(-HISTORY_MAX);
  }
}

/**
 * Drop every call to or from someone who is gone (dead, departed, jailed for a
 * term): nobody walks to an empty house, and a dead man keeps no promises.
 */
export function dropCallsInvolving(agentId: number, nowMin: number): void {
  for (const c of [...pending.values()]) {
    if (c.callerId === agentId || c.targetId === agentId) finish(c, 'dropped', nowMin, null);
  }
  lingers.delete(agentId);
  for (const [callerId, l] of lingers) if (l.targetId === agentId) lingers.delete(callerId);
}

// ─── Staying a while ─────────────────────────────────────────────────────────

/** The caller stays at the target's side until `untilMin` (kinds with `lingerMin`). */
export function startLinger(callerId: number, targetId: number, untilMin: number, callId: number): void {
  lingers.set(callerId, { targetId, untilMin, callId });
}

/** Who the caller is staying with now, or null (an expired stay is forgotten here). */
export function lingerOf(callerId: number, nowMin: number): { targetId: number; untilMin: number; callId: number } | null {
  const l = lingers.get(callerId);
  if (!l) return null;
  if (nowMin >= l.untilMin) {
    lingers.delete(callerId);
    return null;
  }
  return l;
}

export function endLinger(callerId: number): void {
  lingers.delete(callerId);
}

// ─── Watches ─────────────────────────────────────────────────────────────────

/** Ask for `onWatchDue` at `dueMin` (one watch per kind and target; a newer one replaces it). */
export function addWatch(w: CallWatch): void {
  watches = watches.filter((x) => !(x.kind === w.kind && x.targetId === w.targetId));
  watches.push({ ...w });
}

/** Hand every due watch to its kind, once. Run from the hourly sweep. */
export function runDueWatches(nowMin: number): void {
  const due = watches.filter((w) => w.dueMin <= nowMin);
  if (due.length === 0) return;
  watches = watches.filter((w) => w.dueMin > nowMin);
  for (const w of due) kinds.get(w.kind)?.onWatchDue?.(w, nowMin);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** Forget everything: a world replace (agent ids and the clock restart). Kinds stay registered. */
export function clearSocialCalls(): void {
  pending.clear();
  history = [];
  lingers.clear();
  watches = [];
  nextId = 1;
  tally.clear();
}

function readPayload(v: unknown): CallPayload {
  const out: CallPayload = {};
  for (const [k, x] of Object.entries(asRecord(v) ?? {})) {
    if (x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[k] = x;
  }
  return out;
}

function readCall(v: unknown): SocialCall | null {
  const r = asRecord(v);
  if (!r || typeof r.kind !== 'string') return null;
  const id = asNumber(r.id), callerId = asNumber(r.callerId), targetId = asNumber(r.targetId);
  const createdAtMin = asNumber(r.createdAtMin), notBeforeMin = asNumber(r.notBeforeMin), expiresAtMin = asNumber(r.expiresAtMin);
  if (id === null || callerId === null || targetId === null || createdAtMin === null || notBeforeMin === null || expiresAtMin === null) return null;
  return {
    id, kind: r.kind, callerId, targetId, createdAtMin, notBeforeMin, expiresAtMin,
    urgent: r.urgent === true,
    payload: readPayload(r.payload),
    seatedAtMin: asNumber(r.seatedAtMin),
  };
}

function readRecord(v: unknown): CallRecord | null {
  const r = asRecord(v);
  if (!r || typeof r.kind !== 'string') return null;
  const id = asNumber(r.id), callerId = asNumber(r.callerId), targetId = asNumber(r.targetId), atMin = asNumber(r.atMin);
  const outcome = r.outcome === 'made' || r.outcome === 'expired' || r.outcome === 'dropped' ? r.outcome : null;
  if (id === null || callerId === null || targetId === null || atMin === null || outcome === null) return null;
  return { id, kind: r.kind, callerId, targetId, atMin, outcome, good: typeof r.good === 'boolean' ? r.good : null, payload: readPayload(r.payload) };
}

/**
 * Checkpoint (server/engine/simSnapshots.ts). Pending calls are promises a
 * player can see someone walking to keep; losing them on a restart would leave
 * a vigil unkept and a birthday "forgotten" by people who meant to come.
 */
export const socialCallsSnapshotStore: SnapshotStore = {
  key: 'socialCalls',
  version: 1,
  serialize() {
    return {
      nextId,
      pending: [...pending.values()],
      history,
      lingers: [...lingers].map(([callerId, l]) => ({ callerId, ...l })),
      watches,
    };
  },
  restore(data) {
    clearSocialCalls();
    const r = asRecord(data);
    if (!r) return;
    for (const raw of Array.isArray(r.pending) ? r.pending : []) {
      const c = readCall(raw);
      if (c) pending.set(c.id, c);
    }
    history = (Array.isArray(r.history) ? r.history : []).map(readRecord).filter((x): x is CallRecord => x !== null);
    for (const raw of Array.isArray(r.lingers) ? r.lingers : []) {
      const l = asRecord(raw);
      const callerId = asNumber(l?.callerId), targetId = asNumber(l?.targetId), untilMin = asNumber(l?.untilMin), callId = asNumber(l?.callId);
      if (callerId !== null && targetId !== null && untilMin !== null && callId !== null) lingers.set(callerId, { targetId, untilMin, callId });
    }
    for (const raw of Array.isArray(r.watches) ? r.watches : []) {
      const w = asRecord(raw);
      const targetId = asNumber(w?.targetId), sinceMin = asNumber(w?.sinceMin), dueMin = asNumber(w?.dueMin);
      if (w && typeof w.kind === 'string' && targetId !== null && sinceMin !== null && dueMin !== null) {
        watches.push({ kind: w.kind, targetId, sinceMin, dueMin });
      }
    }
    const maxSeen = Math.max(0, ...[...pending.keys()], ...history.map((h) => h.id));
    nextId = Math.max(asNumber(r.nextId) ?? 1, maxSeen + 1);
  },
};
