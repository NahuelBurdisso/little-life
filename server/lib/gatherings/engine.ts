/**
 * Gatherings: several residents converging on one place for a shared reason —
 * a funeral, a wake, a send-off, market day, a fire, a wedding's guests.
 *
 * Why this exists. Social calls (lib/socialCalls) made pairs react to what
 * happened to one of them, but the town still never did anything TOGETHER: an
 * audit found a funeral was a world event with no place and no pull (nobody
 * went), market day pulled nobody, a fire said "townspeople rush to help" and
 * nobody moved, a leaver walked out with no goodbye. A gathering is:
 *
 *   a kind (the registry, kinds/) → `scheduleGathering` (a venue, a window, a host)
 *   → invitations at three levels (types.ts `InviteLevel`) when the window nears
 *   → the decision phase pulls the invited there and holds them (decisions/gathering.ts)
 *   → chats between people present get the gathering's topic (decisions/gathering.ts encounters)
 *   → the kind's moment(s) for everyone present (the eulogy, the toast, the fire put out)
 *   → at the end, who came and who didn't is judged and ONE feed row says it.
 *
 * Conversations stay strictly two-person: a gathering is people in one place
 * for a window, never a group chat.
 *
 * This module is the store and its rules. Pure: no DB import; the periodic pass
 * is handed what it needs (index.ts loads it), and the kinds' callbacks do their
 * own DB work.
 *
 * CLOCK: every stamp is GAME MINUTES.
 *
 * In memory, per world: cleared by worldCaches.ts on a world replace and
 * checkpointed to `sim_snapshots` (gatheringsSnapshotStore) so a restart does
 * not forget a funeral set for tomorrow.
 */
import { asNumber, asRecord, type SnapshotStore } from '../../engine/snapshotCodec';
import type {
  Attendance, Gathering, GatheringKind, GatheringPayload, GatheringRecord, Invite, InviteLevel,
} from './types';

const kinds = new Map<string, GatheringKind>();
const live = new Map<number, Gathering>();
let history: GatheringRecord[] = [];
let nextId = 1;

/** Per kind: held, invitations, who came (the soak prints it). */
export interface GatheringTally {
  scheduled: number;
  held: number;
  cancelled: number;
  /** Invited at `must`/`should` over every held gathering, and of them who came. */
  invited: number;
  invitedCame: number;
  /** Everyone who came, invited or not. */
  attended: number;
}
const tally = new Map<string, GatheringTally>();

function tallyOf(kind: string): GatheringTally {
  let t = tally.get(kind);
  if (!t) {
    t = { scheduled: 0, held: 0, cancelled: 0, invited: 0, invitedCame: 0, attended: 0 };
    tally.set(kind, t);
  }
  return t;
}

/** Per kind since the last clear (scripts/soak.ts). */
export function gatheringTally(): Record<string, GatheringTally> {
  return Object.fromEntries([...tally].map(([k, v]) => [k, { ...v }]));
}

const HISTORY_KEEP_MIN = 30 * 24 * 60;
const HISTORY_MAX = 300;
const DEFAULT_LEAD_MIN = 45;
/** A storm can put a gathering off at most this many times; then it goes ahead in the rain. */
const MAX_POSTPONE = 2;

// ─── The registry ────────────────────────────────────────────────────────────

export function registerGatheringKind(def: GatheringKind): void {
  kinds.set(def.id, def);
}

export function gatheringKind(id: string): GatheringKind | null {
  return kinds.get(id) ?? null;
}

export function leadOf(def: GatheringKind): number {
  return def.leadMin ?? DEFAULT_LEAD_MIN;
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

export interface ScheduleGatheringRequest {
  kind: string;
  venueLocationId: number;
  startMin: number;
  endMin: number;
  hostIds?: number[];
  subjectId?: number | null;
  eventId?: number | null;
  payload?: GatheringPayload;
}

/**
 * Put a gathering on the calendar, or null when the kind is unknown, the window
 * is empty, or the same kind is already on for the same subject/hosts (a death
 * gets one funeral, however many listeners hear of it).
 */
export function scheduleGathering(req: ScheduleGatheringRequest): Gathering | null {
  const def = kinds.get(req.kind);
  // An empty window is allowed: a round of drinks is over the moment it is bought.
  if (!def || req.endMin < req.startMin) return null;
  const hostIds = [...new Set(req.hostIds ?? [])];
  const subjectId = req.subjectId ?? null;
  const key = sameKey(req.kind, hostIds, subjectId, req.eventId ?? null);
  for (const g of live.values()) {
    if (sameKey(g.kind, g.hostIds, g.subjectId, g.eventId) === key && key !== null) return null;
  }
  const g: Gathering = {
    id: nextId++,
    kind: req.kind,
    venueLocationId: req.venueLocationId,
    startMin: req.startMin,
    endMin: req.endMin,
    hostIds,
    subjectId,
    status: 'scheduled',
    invited: new Map(),
    attended: new Set(),
    eventId: req.eventId ?? null,
    momentsDone: [],
    postponed: 0,
    payload: { ...(req.payload ?? {}) },
  };
  live.set(g.id, g);
  tallyOf(g.kind).scheduled++;
  return g;
}

/** What makes two gatherings "the same one": kind + subject, else kind + event, else kind + hosts. Null = never deduped. */
function sameKey(kind: string, hostIds: number[], subjectId: number | null, eventId: number | null): string | null {
  if (subjectId != null) return `${kind}|s${subjectId}`;
  if (eventId != null) return `${kind}|e${eventId}`;
  if (hostIds.length > 0) return `${kind}|h${[...hostIds].sort((a, b) => a - b).join(',')}`;
  return null;
}

/** Ask someone (a later, stronger ask replaces a weaker one; an arrival is kept). */
export function invite(g: Gathering, agentId: number, level: InviteLevel, notBeforeMin = g.startMin - 30): void {
  const rank: Record<InviteLevel, number> = { must: 3, should: 2, may: 1 };
  const cur = g.invited.get(agentId);
  if (cur && rank[cur.level] >= rank[level]) return;
  g.invited.set(agentId, {
    level,
    notBeforeMin,
    arrivedAtMin: cur?.arrivedAtMin ?? null,
    doneAtMin: null,
  });
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Every gathering not yet closed (diagnostics, the hourly sweep). */
export function allGatherings(): Gathering[] {
  return [...live.values()];
}

/** The open gathering at this venue, if one is on now. */
export function gatheringAt(locationId: number, nowMin: number): Gathering | null {
  for (const g of live.values()) {
    if (g.status === 'open' && g.venueLocationId === locationId && nowMin >= g.startMin - leadOfKind(g.kind) && nowMin < g.endMin) return g;
  }
  return null;
}

function leadOfKind(kind: string): number {
  const def = kinds.get(kind);
  return def ? leadOf(def) : DEFAULT_LEAD_MIN;
}

/**
 * The open gathering this resident is asked to and has not yet finished with,
 * the strongest ask first (a widow at her husband's funeral is not drawn off by
 * market day).
 */
export function gatheringFor(agentId: number, nowMin: number): { g: Gathering; inv: Invite } | null {
  const rank: Record<InviteLevel, number> = { must: 3, should: 2, may: 1 };
  let best: { g: Gathering; inv: Invite } | null = null;
  for (const g of live.values()) {
    if (g.status !== 'open' || nowMin >= g.endMin) continue;
    const inv = g.invited.get(agentId);
    if (!inv || inv.doneAtMin != null) continue;
    if (!best || rank[inv.level] > rank[best.inv.level]) best = { g, inv };
  }
  return best;
}

/** Who was asked and who came, for a live or a closed gathering. Null when it is long forgotten. */
export function attendanceOf(gatheringId: number): Attendance | null {
  const g = live.get(gatheringId);
  if (g) return attendanceFrom(new Map([...g.invited].map(([id, i]) => [id, i.level])), g.attended);
  const r = history.find((h) => h.id === gatheringId);
  if (!r) return null;
  return attendanceFrom(new Map(r.invited), new Set(r.attended));
}

function attendanceFrom(invited: Map<number, InviteLevel>, attended: Set<number>): Attendance {
  const absent = [...invited].filter(([id, lvl]) => lvl !== 'may' && !attended.has(id)).map(([id]) => id);
  return { invited, attended: new Set(attended), absent };
}

/** Closed gatherings (optionally of one kind) since `sinceMin`. */
export function gatheringRecords(kind?: string, sinceMin = Number.NEGATIVE_INFINITY): GatheringRecord[] {
  return history.filter((r) => (kind == null || r.kind === kind) && r.endMin >= sinceMin);
}

// ─── The periodic pass ───────────────────────────────────────────────────────

export interface PassAgent {
  id: number;
  current_location: number | null;
  position: { x: number; y: number };
  action: string;
}

export interface PassInput {
  nowMin: number;
  agents: readonly PassAgent[];
  /** Venue id → its door (open areas and buildings alike). */
  venueDoor: (locationId: number) => { x: number; y: number } | null;
  /** A storm is on (gatherings with `stormDelayMin` wait it out). */
  storm: boolean;
}

/** Standing this close to a building's door counts as being there (helpers at a fire stand outside). */
export const NEAR_VENUE_PX = 96;

/** Residents at the venue now: inside it, or standing at its door. */
export function presentAt(g: Gathering, agents: readonly PassAgent[], venueDoor: PassInput['venueDoor']): number[] {
  const door = venueDoor(g.venueLocationId);
  return agents.filter((a) => {
    if (a.action === 'dead' || a.action === 'sleeping') return false;
    if (a.current_location === g.venueLocationId) return true;
    return door != null && a.action !== 'walking' && Math.hypot(a.position.x - door.x, a.position.y - door.y) <= NEAR_VENUE_PX;
  }).map((a) => a.id);
}

/**
 * Every 10 game minutes (engine/tick.ts, in a transaction): send invitations
 * for gatherings about to start (or put one off for a storm), note who is at
 * each venue, run the moments that are due, and close the gatherings whose
 * window is over.
 */
export function gatheringsPass(input: PassInput): void {
  const { nowMin } = input;
  for (const g of [...live.values()]) {
    const def = kinds.get(g.kind);
    if (!def) {
      cancel(g);
      continue;
    }
    if (def.stillRelevant && !def.stillRelevant(g)) {
      cancel(g);
      continue;
    }
    if (g.status === 'scheduled' && nowMin >= g.startMin - leadOf(def)) {
      if (def.stormDelayMin && input.storm && g.postponed < MAX_POSTPONE) {
        g.startMin += def.stormDelayMin;
        g.endMin += def.stormDelayMin;
        g.postponed++;
        continue;
      }
      g.status = 'open';
      def.invite(g, nowMin);
      def.onOpen?.(g, nowMin);
    }
    if (g.status !== 'open') continue;

    if (nowMin >= g.startMin) {
      const present = presentAt(g, input.agents, input.venueDoor);
      markPresent(g, present, nowMin);
      // Holds that ran their course: free again for the rest of the day.
      for (const [id, inv] of g.invited) {
        const stay = def.stayMin?.[inv.level];
        if (inv.doneAtMin == null && inv.arrivedAtMin != null && stay != null && nowMin >= inv.arrivedAtMin + stay) inv.doneAtMin = nowMin;
        if (inv.doneAtMin == null && inv.arrivedAtMin == null && !present.includes(id) && nowMin >= g.endMin) inv.doneAtMin = nowMin;
      }
      const moments = def.momentsAt ?? [];
      moments.forEach((offset, index) => {
        if (g.momentsDone.includes(offset) || nowMin < g.startMin + offset || nowMin >= g.endMin + 10) return;
        g.momentsDone.push(offset);
        def.moment?.(g, present, nowMin, index);
      });
    }
    if (nowMin >= g.endMin) close(g, def, nowMin);
  }
}

/** Note who is at the venue (the pass, and the decision phase on arrival). */
export function markPresent(g: Gathering, ids: readonly number[], nowMin: number): void {
  for (const id of ids) {
    g.attended.add(id);
    const inv = g.invited.get(id);
    if (inv && inv.arrivedAtMin == null) inv.arrivedAtMin = nowMin;
  }
}

/** Close a gathering now (a kind that is over in an instant — a round of drinks — closes itself). */
export function closeGathering(gatheringId: number, nowMin: number): void {
  const g = live.get(gatheringId);
  const def = g ? kinds.get(g.kind) : null;
  if (g && def) close(g, def, nowMin);
}

function close(g: Gathering, def: GatheringKind, nowMin: number): void {
  live.delete(g.id);
  g.status = 'closed';
  const att = attendanceOf(g.id) ?? attendanceFrom(new Map([...g.invited].map(([id, i]) => [id, i.level])), g.attended);
  const t = tallyOf(g.kind);
  t.held++;
  t.attended += g.attended.size;
  for (const [id, lvl] of att.invited) {
    if (lvl === 'may') continue;
    t.invited++;
    if (g.attended.has(id)) t.invitedCame++;
  }
  history.push(recordOf(g));
  pruneHistory(nowMin);
  def.onClose(g, attendanceFrom(new Map([...g.invited].map(([id, i]) => [id, i.level])), g.attended), nowMin);
}

function cancel(g: Gathering): void {
  live.delete(g.id);
  g.status = 'closed';
  tallyOf(g.kind).cancelled++;
}

/** Drop the dead or departed from every live gathering's invitations (a host gone cancels it via `stillRelevant`). */
export function forgetInvitee(agentId: number): void {
  for (const g of live.values()) g.invited.delete(agentId);
}

function recordOf(g: Gathering): GatheringRecord {
  return {
    id: g.id, kind: g.kind, venueLocationId: g.venueLocationId, startMin: g.startMin, endMin: g.endMin,
    hostIds: [...g.hostIds], subjectId: g.subjectId,
    invited: [...g.invited].map(([id, i]) => [id, i.level]),
    attended: [...g.attended],
    payload: { ...g.payload },
  };
}

function pruneHistory(nowMin: number): void {
  const cutoff = nowMin - HISTORY_KEEP_MIN;
  if (history.length > HISTORY_MAX || (history[0] && history[0].endMin < cutoff)) {
    history = history.filter((r) => r.endMin >= cutoff).slice(-HISTORY_MAX);
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** Forget everything: a world replace. Kinds stay registered. */
export function clearGatherings(): void {
  live.clear();
  history = [];
  nextId = 1;
  tally.clear();
}

function readPayload(v: unknown): GatheringPayload {
  const out: GatheringPayload = {};
  for (const [k, x] of Object.entries(asRecord(v) ?? {})) {
    if (x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[k] = x;
    else if (Array.isArray(x) && x.every((e) => typeof e === 'number')) out[k] = x as number[];
    else if (Array.isArray(x) && x.every((e) => typeof e === 'string')) out[k] = x as string[];
  }
  return out;
}

function readIds(v: unknown): number[] {
  return Array.isArray(v) ? v.map(asNumber).filter((x): x is number => x !== null) : [];
}

const LEVELS: ReadonlySet<string> = new Set(['must', 'should', 'may']);

function readGathering(v: unknown): Gathering | null {
  const r = asRecord(v);
  if (!r || typeof r.kind !== 'string') return null;
  const id = asNumber(r.id), venue = asNumber(r.venueLocationId), startMin = asNumber(r.startMin), endMin = asNumber(r.endMin);
  if (id === null || venue === null || startMin === null || endMin === null) return null;
  const invited = new Map<number, Invite>();
  for (const raw of Array.isArray(r.invited) ? r.invited : []) {
    const i = asRecord(raw);
    const agentId = asNumber(i?.agentId), notBeforeMin = asNumber(i?.notBeforeMin);
    if (!i || agentId === null || notBeforeMin === null || typeof i.level !== 'string' || !LEVELS.has(i.level)) continue;
    invited.set(agentId, {
      level: i.level as InviteLevel, notBeforeMin,
      arrivedAtMin: asNumber(i.arrivedAtMin), doneAtMin: asNumber(i.doneAtMin),
    });
  }
  return {
    id, kind: r.kind, venueLocationId: venue, startMin, endMin,
    hostIds: readIds(r.hostIds),
    subjectId: asNumber(r.subjectId),
    status: r.status === 'open' ? 'open' : 'scheduled',
    invited,
    attended: new Set(readIds(r.attended)),
    eventId: asNumber(r.eventId),
    momentsDone: readIds(r.momentsDone),
    postponed: asNumber(r.postponed) ?? 0,
    payload: readPayload(r.payload),
  };
}

function readRecord(v: unknown): GatheringRecord | null {
  const r = asRecord(v);
  if (!r || typeof r.kind !== 'string') return null;
  const id = asNumber(r.id), venue = asNumber(r.venueLocationId), startMin = asNumber(r.startMin), endMin = asNumber(r.endMin);
  if (id === null || venue === null || startMin === null || endMin === null) return null;
  const invited: Array<[number, InviteLevel]> = [];
  for (const raw of Array.isArray(r.invited) ? r.invited : []) {
    if (!Array.isArray(raw)) continue;
    const agentId = asNumber(raw[0]);
    if (agentId !== null && typeof raw[1] === 'string' && LEVELS.has(raw[1])) invited.push([agentId, raw[1] as InviteLevel]);
  }
  return {
    id, kind: r.kind, venueLocationId: venue, startMin, endMin,
    hostIds: readIds(r.hostIds), subjectId: asNumber(r.subjectId),
    invited, attended: readIds(r.attended), payload: readPayload(r.payload),
  };
}

/**
 * Checkpoint (server/engine/simSnapshots.ts). A funeral is set for tomorrow and
 * a send-off for dawn; a restart in between must not lose them, nor forget who
 * stayed away from the last one.
 */
export const gatheringsSnapshotStore: SnapshotStore = {
  key: 'gatherings',
  version: 1,
  serialize() {
    return {
      nextId,
      live: [...live.values()].map((g) => ({
        ...g,
        invited: [...g.invited].map(([agentId, i]) => ({ agentId, ...i })),
        attended: [...g.attended],
      })),
      history,
    };
  },
  restore(data) {
    clearGatherings();
    const r = asRecord(data);
    if (!r) return;
    for (const raw of Array.isArray(r.live) ? r.live : []) {
      const g = readGathering(raw);
      if (g) live.set(g.id, g);
    }
    history = (Array.isArray(r.history) ? r.history : []).map(readRecord).filter((x): x is GatheringRecord => x !== null);
    const maxSeen = Math.max(0, ...[...live.keys()], ...history.map((h) => h.id));
    nextId = Math.max(asNumber(r.nextId) ?? 1, maxSeen + 1);
  },
};
