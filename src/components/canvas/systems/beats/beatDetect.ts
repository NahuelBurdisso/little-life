/**
 * Story-beat detection: turns two consecutive client snapshots (activity rows, agents,
 * relationships, world events, sprites the pool just dropped) into the handful of moments
 * the canvas should dramatise — a fight, a gift, a kiss, an arrest...
 *
 * Pure (no PixiJS, no clock of its own) so it can be unit tested with fixtures copied from
 * the server's real log wording. The state object is mutated by `detectBeats`; the caller
 * keeps one per canvas.
 *
 * Why this is text matching: the server logs every `drama` row with no subtype, so the
 * description is the only discriminator. The phrasings below are the ones in
 * server/lib/confrontationEngine.ts, engine/systems/conversations.ts, lib/cascade/
 * SnapResolver.ts, lib/secretSharing.ts, engine/systems/gossipEngine.ts, lib/gossip.ts,
 * engine/systems/decisions.ts, lib/lifeEventsEngine.ts, lib/agingEngine.ts and
 * engine/systems/relationships.ts — beatDetect.test.ts holds them as fixtures, so a reworded
 * template shows up as a failing test rather than a silently missing animation.
 */

import { weddingCouple } from '../townEvents/eventDecor';

export type BeatKind =
  | 'fight' | 'gift' | 'romance' | 'heartbreak' | 'arrest'
  | 'secret' | 'levelup' | 'birthday' | 'death';

export interface Beat {
  kind: BeatKind;
  /**
   * The agents involved. Order matters for `gift` (giver, receiver) and `arrest`
   * (arrested, constable); for the rest it is the log order.
   */
  agentIds: number[];
  /** World position, only for a death (the sprite is gone by the time the FX plays). */
  at?: { x: number; y: number };
}

export interface ActivityRow {
  id: number;
  type: string;
  initiator_id?: number | null;
  target_id?: number | null;
  agent_ids?: number[] | null;
  template_data?: { description?: string; status?: string; [k: string]: unknown } | null;
  real_timestamp?: number;
}

export interface AgentLite {
  id: number;
  position?: { x: number; y: number };
  age?: number;
  hobbies?: Array<{ hobby: string; level: number }>;
  activeStates?: Array<{ type: string; target_agent_id?: number | null }>;
}

export interface RelLite { id?: number; agent_a: number; agent_b: number; status?: string }
export interface EventLite { id: number; type?: string; triggered_by?: string }

export interface BeatSnapshot {
  /** Newest first, as `activity.getRecent` returns it. */
  activity: ActivityRow[];
  agents: AgentLite[];
  relationships: RelLite[];
  events: EventLite[];
  /** `SpritePool.recentlyRemoved`: ids are strings there. */
  removed: Array<{ id: string | number; x: number; y: number }>;
}

/** Same (kind, agents) at most once per this many ms. */
export const DEDUPE_MS = 20_000;
/** Rows older than this (wall clock) are history, not news: a backgrounded tab must not replay. */
export const MAX_ROW_AGE_MS = 60_000;
/** How long one half of a death (row / sprite removal) waits for the other. */
export const DEATH_WAIT_MS = 60_000;
/**
 * While a couple's wedding runs, hearts rise over the newlyweds this often. Longer than
 * DEDUPE_MS so every round actually plays.
 */
export const WEDDING_HEARTS_EVERY_MS = 25_000;

export interface DetectorState {
  /** Newest activity id already handled; null until the first non-empty poll. */
  watermark: number | null;
  prevAgents: Map<number, { age: number | undefined; hobbies: Map<string, number>; arrested: boolean }> | null;
  prevRelStatus: Map<string, string> | null;
  lastPos: Map<number, { x: number; y: number }>;
  seenDeathEvents: Set<number> | null;
  pendingDeaths: Map<number, number>;
  removedRecently: Map<number, { x: number; y: number; at: number }>;
  deadIds: Set<number>;
  lastFired: Map<string, number>;
  /** Wedding event id → when its couple last got hearts. */
  weddingHeartsAt: Map<number, number>;
}

export function createDetectorState(): DetectorState {
  return {
    watermark: null,
    prevAgents: null,
    prevRelStatus: null,
    lastPos: new Map(),
    seenDeathEvents: null,
    pendingDeaths: new Map(),
    removedRecently: new Map(),
    deadIds: new Set(),
    lastFired: new Map(),
    weddingHeartsAt: new Map(),
  };
}

// ── Classification ──────────────────────────────────────────────────────────────────────────

/**
 * Gossip and secret rows splice arbitrary fact content after the lead ("Ana told Bo that Cy
 * got into a fight."), so they are recognised by their lead first and never fall through to the
 * keyword tests below. `thatSentence` yields "<lead> that <fact>" or `<lead>: "<question>"`.
 * "The whole town now knows…" has no pair to animate and is left out on purpose.
 */
const GOSSIP_LEAD = /^[^.!?:"]{1,80}? (?:learned|overheard|discovered|told [^.!?:"]{1,40}?)(?: that\b|:)/;
const CONFIDED = /^[^.!?]{1,80}? (?:confided a personal secret to|confessed a secret to) /;

const DEATH = /^.{1,60}? has died\./;
const BIRTHDAY = /^Happy birthday to /;
const ARREST = /^[^!]{1,80}? arrested [^!]{1,60}?!/;
const HEARTBREAK = / and broke up!|are estranged for good/;
const FIGHT = /got into a physical fight|started a fight with|had a public shouting match|insulted .{1,60}? during a heated argument|snapped and (?:confronted someone|lashed out)/;
const ROMANCE = / are on a date$| flirted with .{1,60}? after their conversation| (?:have )?reconciled\.?$|managed to clear the air$/;

function pairOf(row: ActivityRow): number[] {
  const ids: number[] = [];
  for (const v of [row.initiator_id, row.target_id]) {
    if (typeof v === 'number' && !ids.includes(v)) ids.push(v);
  }
  if (ids.length > 0) return ids;
  return (row.agent_ids ?? []).filter((v, i, a) => typeof v === 'number' && a.indexOf(v) === i).slice(0, 2);
}

/** What story beat, if any, one activity row tells. Exported for the fixture tests. */
export function classifyActivity(row: ActivityRow): { kind: BeatKind; agentIds: number[] } | null {
  // Life milestones (server/lib/milestonesEngine.ts) log typed rows, so no wording to match:
  // a yes and a wedding are hearts, a refused proposal a broken heart.
  if (row.type === 'engagement' || row.type === 'wedding' || row.type === 'rejection') {
    const ids = pairOf(row);
    if (ids.length === 0) return null;
    return { kind: row.type === 'rejection' ? 'heartbreak' : 'romance', agentIds: ids };
  }
  if (row.type === 'gift') {
    const ids = pairOf(row);
    return ids.length > 0 ? { kind: 'gift', agentIds: ids } : null;
  }
  if (row.type === 'relationship_status_change') {
    const status = row.template_data?.status;
    const ids = (row.agent_ids ?? []).slice(0, 2);
    if (ids.length === 0) return null;
    if (status === 'partners' || status === 'romantic_interest') return { kind: 'romance', agentIds: ids };
    if (status === 'estranged') return { kind: 'heartbreak', agentIds: ids };
    return null;
  }
  if (row.type !== 'drama') return null;

  const d = row.template_data?.description;
  if (typeof d !== 'string' || d.length === 0) return null;
  const ids = pairOf(row);

  if (GOSSIP_LEAD.test(d) || CONFIDED.test(d)) return ids.length > 0 ? { kind: 'secret', agentIds: ids } : null;
  if (DEATH.test(d)) return ids.length > 0 ? { kind: 'death', agentIds: ids.slice(0, 1) } : null;
  if (BIRTHDAY.test(d)) return ids.length > 0 ? { kind: 'birthday', agentIds: ids.slice(0, 1) } : null;
  if (ARREST.test(d)) {
    // Logged as (constable → arrested); the beat lists the arrested one first.
    return ids.length === 2 ? { kind: 'arrest', agentIds: [ids[1], ids[0]] } : null;
  }
  if (HEARTBREAK.test(d)) return ids.length > 0 ? { kind: 'heartbreak', agentIds: ids } : null;
  if (FIGHT.test(d)) return ids.length > 0 ? { kind: 'fight', agentIds: ids } : null;
  if (ROMANCE.test(d)) return ids.length > 0 ? { kind: 'romance', agentIds: ids } : null;
  return null;
}

// ── Detection ───────────────────────────────────────────────────────────────────────────────

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function fire(state: DetectorState, out: Beat[], beat: Beat, nowMs: number): void {
  const key = `${beat.kind}|${[...beat.agentIds].sort((x, y) => x - y).join(',')}`;
  const last = state.lastFired.get(key);
  if (last !== undefined && nowMs - last < DEDUPE_MS) return;
  state.lastFired.set(key, nowMs);
  out.push(beat);
}

/**
 * Feed the newest snapshot; get the beats that happened since the previous call.
 * The first calls only seed the baselines (watermark, agent/relationship diffs, funerals
 * already running) so opening the page never replays history.
 */
export function detectBeats(state: DetectorState, snap: BeatSnapshot, nowMs: number): Beat[] {
  const out: Beat[] = [];

  // ── Removed sprites and last positions (death needs both halves) ──
  for (const r of snap.removed) {
    const id = Number(r.id);
    if (!Number.isNaN(id)) state.removedRecently.set(id, { x: r.x, y: r.y, at: nowMs });
  }
  const present = new Set<number>();
  for (const a of snap.agents) {
    present.add(a.id);
    if (a.position) {
      const p = state.lastPos.get(a.id);
      if (p) { p.x = a.position.x; p.y = a.position.y; } else state.lastPos.set(a.id, { x: a.position.x, y: a.position.y });
    }
  }

  // ── Funeral events as a second death signal ──
  if (state.seenDeathEvents === null) {
    state.seenDeathEvents = new Set();
    for (const e of snap.events) if (e.triggered_by?.startsWith('death:')) state.seenDeathEvents.add(e.id);
  } else {
    for (const e of snap.events) {
      if (!e.triggered_by?.startsWith('death:') || state.seenDeathEvents.has(e.id)) continue;
      state.seenDeathEvents.add(e.id);
      const id = Number(e.triggered_by.slice('death:'.length));
      if (!Number.isNaN(id) && !state.deadIds.has(id) && !state.pendingDeaths.has(id)) state.pendingDeaths.set(id, nowMs);
    }
  }

  // ── Weddings: hearts over the couple while their ceremony runs ──
  // The couple comes from `triggered_by` (`wedding:<a>-<b>`, see townEvents/eventDecor.ts);
  // a wedding without one (an old random roll) has nobody to point at. Not baselined like the
  // funerals: a wedding in progress when the page opens is a scene, not history.
  const liveWeddings = new Set<number>();
  for (const e of snap.events) {
    const couple = e.type === 'wedding' ? weddingCouple(e) : null;
    if (!couple) continue;
    liveWeddings.add(e.id);
    const last = state.weddingHeartsAt.get(e.id);
    if (last !== undefined && nowMs - last < WEDDING_HEARTS_EVERY_MS) continue;
    state.weddingHeartsAt.set(e.id, nowMs);
    fire(state, out, { kind: 'romance', agentIds: couple }, nowMs);
  }
  for (const id of state.weddingHeartsAt.keys()) if (!liveWeddings.has(id)) state.weddingHeartsAt.delete(id);

  // ── Activity rows ──
  if (state.watermark === null) {
    // First non-empty poll is history. An empty one may just be the query still loading.
    if (snap.activity.length > 0) {
      let max = 0;
      for (const r of snap.activity) if (r.id > max) max = r.id;
      state.watermark = max;
    }
  } else {
    let max = state.watermark;
    // Oldest first, so a chain of beats plays in story order.
    for (let i = snap.activity.length - 1; i >= 0; i--) {
      const r = snap.activity[i];
      if (r.id <= state.watermark) continue;
      if (r.id > max) max = r.id;
      if (r.real_timestamp !== undefined && nowMs - r.real_timestamp > MAX_ROW_AGE_MS) continue;
      const c = classifyActivity(r);
      if (!c) continue;
      if (c.kind === 'death') {
        const id = c.agentIds[0];
        if (!state.deadIds.has(id) && !state.pendingDeaths.has(id)) state.pendingDeaths.set(id, nowMs);
        continue;
      }
      fire(state, out, { kind: c.kind, agentIds: c.agentIds }, nowMs);
    }
    state.watermark = max;
  }

  // ── Agent diffs: level-ups, birthdays, arrests ──
  const nextAgents: NonNullable<DetectorState['prevAgents']> = new Map();
  for (const a of snap.agents) {
    const hobbies = new Map<string, number>();
    for (const h of a.hobbies ?? []) hobbies.set(h.hobby, h.level);
    const arrestState = a.activeStates?.find(s => s.type === 'arrested');
    const cur = { age: a.age, hobbies, arrested: !!arrestState };
    nextAgents.set(a.id, cur);
    const prev = state.prevAgents?.get(a.id);
    if (!prev) continue; // first sighting: baseline only

    for (const [hobby, level] of hobbies) {
      if (level > (prev.hobbies.get(hobby) ?? 0)) {
        fire(state, out, { kind: 'levelup', agentIds: [a.id] }, nowMs);
        break; // one burst per agent per poll
      }
    }
    if (a.age !== undefined && prev.age !== undefined && a.age > prev.age) {
      fire(state, out, { kind: 'birthday', agentIds: [a.id] }, nowMs);
    }
    if (cur.arrested && !prev.arrested) {
      const ids = [a.id];
      const by = arrestState?.target_agent_id;
      if (typeof by === 'number' && by !== a.id) ids.push(by);
      fire(state, out, { kind: 'arrest', agentIds: ids }, nowMs);
    }
  }
  state.prevAgents = nextAgents;

  // ── Relationship diffs: a partnership that ended ──
  const nextRel = new Map<string, string>();
  for (const r of snap.relationships) {
    if (r.status === undefined) continue;
    const key = pairKey(r.agent_a, r.agent_b);
    nextRel.set(key, r.status);
    const prev = state.prevRelStatus?.get(key);
    if (prev === 'partners' && r.status !== 'partners') {
      fire(state, out, { kind: 'heartbreak', agentIds: [Math.min(r.agent_a, r.agent_b), Math.max(r.agent_a, r.agent_b)] }, nowMs);
    }
  }
  state.prevRelStatus = nextRel;

  // ── Resolve deaths ──
  for (const [id, since] of state.pendingDeaths) {
    const removed = state.removedRecently.get(id);
    const gone = !present.has(id) && state.lastPos.has(id);
    if (removed || gone) {
      const at = removed ?? state.lastPos.get(id);
      state.pendingDeaths.delete(id);
      state.deadIds.add(id);
      out.push(at ? { kind: 'death', agentIds: [id], at: { x: at.x, y: at.y } } : { kind: 'death', agentIds: [id] });
    } else if (nowMs - since > DEATH_WAIT_MS) {
      state.pendingDeaths.delete(id);
    }
  }
  for (const [id, r] of state.removedRecently) {
    if (nowMs - r.at > DEATH_WAIT_MS) state.removedRecently.delete(id);
  }

  // ── Housekeeping ──
  if (state.lastFired.size > 64) {
    for (const [k, t] of state.lastFired) if (nowMs - t > DEDUPE_MS) state.lastFired.delete(k);
  }
  return out;
}
