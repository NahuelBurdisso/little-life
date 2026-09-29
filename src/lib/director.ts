/**
 * Director mode: which shot the camera should be on.
 *
 * The old Auto-Cut re-centred on the subject of every new alert the instant it
 * arrived, so with a busy town the camera ping-ponged between toasts and never
 * stayed on a scene long enough to read it. A director does three things that
 * reflex does not:
 *
 *   1. It scores everything on offer at once (live conversations, fresh alerts,
 *      world events, what the player just meddled with, residents about to snap)
 *      and picks the best shot, not the newest.
 *   2. It commits. A shot is held for a minimum time, and a challenger has to beat
 *      the current shot by a margin (hysteresis) — a slightly better candidate
 *      never steals the camera, so it cannot flip between two near-equal scenes.
 *   3. When nothing is interesting it does not freeze on the last scene: it
 *      wanders to the busiest places, slowly, so the town keeps being shown.
 *
 * Pure module (no React, no clock reads — `now` is passed in) so scoring,
 * hold times, hysteresis and the idle fallback are tested on fixtures
 * (`__tests__/director.test.ts`). `hooks/useDirector.ts` feeds it live data and
 * applies its cuts to the camera; `lib/directorCaption.ts` turns a shot into
 * the lower-third text.
 */

/** What kind of thing a shot is about. */
export type ShotKind = 'conversation' | 'alert' | 'intervention' | 'event' | 'brewing' | 'roam';

/** Every tunable in one place, exported so tests state their expectations in the same units. */
export const DIRECTOR = {
  /** How often the hook re-scores the town (real ms). */
  TICK_MS: 3000,
  /** Minimum real time on a shot, by kind, before a challenger may take it. */
  MIN_HOLD_MS: {
    conversation: 18_000,
    alert: 14_000,
    intervention: 14_000,
    event: 16_000,
    brewing: 12_000,
    roam: 20_000,
  } satisfies Record<ShotKind, number>,
  /**
   * A roam stop yields to real drama sooner than a scene does: the camera was
   * only killing time, so waiting the full 20 s while a fight starts is worse
   * than a quick cut. Still not instant, so a cut never lands on a shot that
   * hasn't had a moment to register.
   */
  ROAM_PREEMPT_MS: 6_000,
  /** How long a roam stop stays when nothing better turns up. */
  ROAM_DWELL_MS: 20_000,
  /**
   * The hysteresis band: after the hold, a challenger must beat the current
   * shot's own score by this much to take the camera. Alert and conversation
   * scores move by several points as lines arrive and toasts age, so without a
   * band two similar scenes would trade the lead every few seconds.
   */
  SWITCH_MARGIN: 15,
  /** Below this a candidate isn't worth a cut: the camera roams instead. */
  IDLE_SCORE: 22,
  /** A shot we just left is docked up to this much, fading over FATIGUE_MS (anti ping-pong). */
  FATIGUE_MAX: 25,
  FATIGUE_MS: 90_000,
  /** Manual camera input pauses the director this long. */
  PAUSE_MS: 20_000,
  /** How long a toast-worthy alert keeps pulling the camera. */
  ALERT_FRESH_MS: 30_000,
  /** How long the player's own nudge keeps pulling the camera. */
  INTERVENTION_FRESH_MS: 45_000,
  /** A world event is a headline for this long, then a long-running backdrop. */
  EVENT_FRESH_MS: 45_000,
  EVENT_FADE_MS: 75_000,
  /** Roam stops we avoid revisiting. */
  ROAM_MEMORY: 3,
} as const;

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface DirectorAgent {
  id: number | string;
  current_location?: number | null;
  current_action?: { type?: string } | null;
}

export interface DirectorLocation {
  id: number;
  name?: string;
  /** Location kind from the server (`home`, `tavern`, …). */
  type?: string;
}

export interface DirectorConversation {
  id: number;
  participants: number[];
  messages: ReadonlyArray<unknown>;
  topic?: string | null;
  trigger_reason?: string | null;
  sentiment?: number | null;
  max_turns?: number | null;
  location?: number | null;
}

/** The slice of `chronicle.getBrewing` the director reads. */
export interface DirectorBrewing {
  id: string;
  kind: string;
  agentIds: number[];
  /** 0..1, comparable across kinds. */
  heat: number;
  text?: string;
}

export interface DirectorAlert {
  id: number;
  tier: 'player' | 'major' | 'minor';
  agentIds: number[];
  /** Wall-clock ms the toast appeared. */
  shownAt: number;
  label: string;
}

export interface DirectorEvent {
  id: number;
  name: string;
  locationId: number | null;
  /** Wall-clock ms this tab first saw the event (the server only gives game time). */
  firstSeenAt: number;
}

/** The player just poked these residents (nudge, secret, confrontation...). */
export interface DirectorIntervention {
  id: number;
  agentIds: number[];
  at: number;
  label: string;
}

export interface DirectorInput {
  now: number;
  conversations: readonly DirectorConversation[];
  brewing: readonly DirectorBrewing[];
  alerts: readonly DirectorAlert[];
  events: readonly DirectorEvent[];
  interventions: readonly DirectorIntervention[];
  /** The cast bar's starred ids (strings, as elsewhere in the UI). */
  favorites: ReadonlySet<string>;
  /** Turns an id into a display name for shot labels. */
  nameOf?: (id: number) => string;
}

// ─── Candidates & shots ──────────────────────────────────────────────────────

export interface Candidate {
  /** Stable across re-scores ("convo:12"), so hold/hysteresis can tell "same shot". */
  key: string;
  kind: ShotKind;
  score: number;
  /** The cast in frame; the first one is who the camera follows. */
  agentIds: number[];
  locationId: number | null;
  label: string;
}

export interface Shot {
  key: string;
  kind: ShotKind;
  agentIds: number[];
  locationId: number | null;
  label: string;
  /** Wall-clock ms the camera arrived. */
  since: number;
  /** Latest score (informational; the hold/hysteresis maths uses the live candidate). */
  score: number;
}

export interface DirectorState {
  current: Shot | null;
  /** Shot key → when we left it, for the fatigue penalty. */
  recent: Readonly<Record<string, number>>;
  /** Locations the roam visited, oldest first. */
  roamTrail: readonly number[];
}

export const INITIAL_DIRECTOR_STATE: DirectorState = { current: null, recent: {}, roamTrail: [] };

// ─── Scoring ─────────────────────────────────────────────────────────────────

export type ConversationTier = 'llm_deep' | 'llm_standard' | 'template';

/**
 * The scheduler's tier isn't stored on the conversation row (only on the queue
 * entry it came from), so recover it from what is. A player-made one is always
 * a deep one (nudge.ts queues them so), a dramatic topic is what makes
 * decisions.ts pick deep, and `max_turns` carries the rest: the deep tier is
 * given the longer budget. Template chats are inserted already ended, so a live
 * one is never a template — the branch is for recently-ended rows.
 */
export function inferTier(c: Pick<DirectorConversation, 'trigger_reason' | 'topic' | 'max_turns'>): ConversationTier {
  const trigger = c.trigger_reason ?? '';
  if (trigger.includes('(template)')) return 'template';
  if (trigger.startsWith('player_')) return 'llm_deep';
  if (topicWeight(c.topic) >= 22) return 'llm_deep';
  if ((c.max_turns ?? 0) >= 5) return 'llm_deep';
  return 'llm_standard';
}

const TIER_BASE: Record<ConversationTier, number> = { llm_deep: 55, llm_standard: 32, template: 8 };

/**
 * How much a topic is worth watching. Confrontations and secrets are the
 * game's whole point; gossip and comfort are texture. The stored topic is free
 * text (personality picks, the player's own words, "gossip about Mara"), so
 * this matches on stems.
 */
export function topicWeight(topic: string | null | undefined): number {
  const t = (topic ?? '').toLowerCase();
  if (!t) return 0;
  if (/confront|argu|fight|tension|clash|accus/.test(t)) return 28;
  if (/secret|reveal/.test(t)) return 26;
  if (/flirt|romanc|love|kiss|affair/.test(t)) return 22;
  if (/gossip|rumou?r/.test(t)) return 14;
  if (/comfort|vent|worr|griev|cry/.test(t)) return 10;
  return 0;
}

/** The hottest brewing item (0..1) touching any of these residents. */
function brewingHeatFor(agentIds: readonly number[], brewing: readonly DirectorBrewing[]): number {
  let heat = 0;
  for (const b of brewing) {
    if (b.agentIds.some((id) => agentIds.includes(id))) heat = Math.max(heat, b.heat);
  }
  return heat;
}

function favouriteBonus(agentIds: readonly number[], favorites: ReadonlySet<string>): number {
  const stars = agentIds.filter((id) => favorites.has(String(id))).length;
  if (stars === 0) return 0;
  // Someone you starred is on screen: worth a look; both of a pair, more so.
  return stars >= 2 ? 22 : 16;
}

export function scoreConversation(
  c: DirectorConversation,
  ctx: { brewing: readonly DirectorBrewing[]; favorites: ReadonlySet<string> },
): number {
  const lines = c.messages.length;
  let score = TIER_BASE[inferTier(c)];
  score += topicWeight(c.topic);
  if ((c.trigger_reason ?? '').startsWith('player_')) score += 18;
  score += Math.abs(c.sentiment ?? 0) * 12;
  // Nothing said yet → nothing to caption; give the pair a moment to speak first.
  score += lines === 0 ? -12 : Math.min(lines, 4) * 2;
  score += brewingHeatFor(c.participants, ctx.brewing) * 30;
  score += favouriteBonus(c.participants, ctx.favorites);
  return score;
}

const ALERT_BASE: Record<DirectorAlert['tier'], number> = { player: 88, major: 72, minor: 42 };

/** 1 → 0 over `spanMs`, clamped. */
function fresh(ageMs: number, spanMs: number): number {
  return Math.max(0, Math.min(1, 1 - ageMs / spanMs));
}

export function scoreAlert(a: DirectorAlert, now: number, favorites: ReadonlySet<string>): number {
  const base = ALERT_BASE[a.tier] * fresh(now - a.shownAt, DIRECTOR.ALERT_FRESH_MS);
  return base > 0 ? base + favouriteBonus(a.agentIds, favorites) * 0.75 : 0;
}

export function scoreIntervention(i: DirectorIntervention, now: number): number {
  return 78 * fresh(now - i.at, DIRECTOR.INTERVENTION_FRESH_MS);
}

/** Full marks while the event is news, then a slide down to a backdrop that never wins on its own. */
export function scoreEvent(e: DirectorEvent, now: number): number {
  const age = now - e.firstSeenAt;
  if (age <= DIRECTOR.EVENT_FRESH_MS) return 55;
  const t = Math.min(1, (age - DIRECTOR.EVENT_FRESH_MS) / DIRECTOR.EVENT_FADE_MS);
  return 55 - t * 35; // 55 → 20, under IDLE_SCORE
}

/** Only near-boiling suspense earns a cut of its own; a low simmer is the feed's job. */
const BREWING_WATCH_HEAT = 0.6;
const BREWING_KINDS = new Set(['snap', 'confrontation']);

/**
 * Everything on offer right now, best first. One scene, one candidate: an
 * alert, a nudge or a boiling secret about residents who are already in a live
 * conversation adds to that conversation instead of competing with it —
 * otherwise "alert:9" and "convo:5" (same two people, same spot) would trade
 * the camera with a cut that shows nothing new.
 */
export function buildCandidates(input: DirectorInput): Candidate[] {
  const name = input.nameOf ?? ((id: number) => `#${id}`);
  const convoCandidates: Candidate[] = input.conversations.map((c) => ({
    key: `convo:${c.id}`,
    kind: 'conversation',
    score: scoreConversation(c, input),
    agentIds: [...c.participants],
    locationId: c.location ?? null,
    label: c.participants.map(name).join(' & '),
  }));

  const others: Candidate[] = [];
  for (const a of input.alerts) {
    if (a.agentIds.length === 0) continue; // nobody to point the camera at
    const score = scoreAlert(a, input.now, input.favorites);
    if (score > 0) others.push({ key: `alert:${a.id}`, kind: 'alert', score, agentIds: [...a.agentIds], locationId: null, label: a.label });
  }
  for (const i of input.interventions) {
    if (i.agentIds.length === 0) continue;
    const score = scoreIntervention(i, input.now);
    if (score > 0) others.push({ key: `nudge:${i.id}`, kind: 'intervention', score, agentIds: [...i.agentIds], locationId: null, label: i.label });
  }
  for (const e of input.events) {
    if (e.locationId == null) continue; // an event with no place has nowhere to look
    others.push({ key: `event:${e.id}`, kind: 'event', score: scoreEvent(e, input.now), agentIds: [], locationId: e.locationId, label: e.name });
  }
  for (const b of input.brewing) {
    if (!BREWING_KINDS.has(b.kind) || b.heat < BREWING_WATCH_HEAT || b.agentIds.length === 0) continue;
    others.push({
      key: `brew:${b.id}`,
      kind: 'brewing',
      score: 20 + b.heat * 30 + favouriteBonus(b.agentIds, input.favorites) * 0.5,
      agentIds: [...b.agentIds],
      locationId: null,
      label: b.text ?? 'Trouble brewing',
    });
  }

  const merged: Candidate[] = [];
  for (const o of others) {
    const host = convoCandidates.find((c) => o.agentIds.some((id) => c.agentIds.includes(id)));
    if (host) {
      // 60 %: the scene is where the payoff will happen, but the news itself is
      // worth less once the camera is already on the people it is about.
      host.score += o.score * 0.6;
    } else {
      merged.push(o);
    }
  }
  return [...convoCandidates, ...merged].sort(byScore);
}

function byScore(a: Candidate, b: Candidate): number {
  return b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// ─── Roam ────────────────────────────────────────────────────────────────────

function isAwake(a: DirectorAgent): boolean {
  const t = a.current_action?.type;
  return t !== 'sleeping' && t !== 'dead';
}

/**
 * The next place for the idle camera: the busiest location by awake residents,
 * skipping the last few stops so it circulates instead of camping the tavern.
 * Deterministic (ties → lower id) so it is testable and so two tabs agree.
 * `null` when nobody is anywhere — the camera then stays put.
 */
export function pickRoamStop(
  locations: readonly DirectorLocation[],
  agents: readonly DirectorAgent[],
  trail: readonly number[],
): DirectorLocation | null {
  const counts = new Map<number, number>();
  for (const a of agents) {
    if (a.current_location == null || !isAwake(a)) continue;
    counts.set(a.current_location, (counts.get(a.current_location) ?? 0) + 1);
  }
  // Private homes are skipped: a roam is the camera "strolling through town",
  // and cutting into a bedroom reads as snooping — at night it is also the only
  // busy place, so the roam would park on sleepers instead of going idle.
  const busy = locations.filter((l) => l.type !== 'home' && (counts.get(l.id) ?? 0) > 0);
  if (busy.length === 0) return null;
  const avoid = new Set(trail.slice(-DIRECTOR.ROAM_MEMORY));
  const unvisited = busy.filter((l) => !avoid.has(l.id));
  // Everywhere busy was visited lately: better a repeat than a dead camera.
  const pool = unvisited.length > 0 ? unvisited : busy;
  return [...pool].sort((a, b) => (counts.get(b.id)! - counts.get(a.id)!) || a.id - b.id)[0];
}

// ─── The director ────────────────────────────────────────────────────────────

export interface StepResult {
  state: DirectorState;
  /** Set when the camera has to move to a new subject; null when it stays put. */
  cut: Shot | null;
}

export interface WorldSnapshot {
  locations: readonly DirectorLocation[];
  agents: readonly DirectorAgent[];
}

function fatigue(recent: DirectorState['recent'], key: string, currentKey: string | undefined, now: number): number {
  if (key === currentKey) return 0;
  const left = recent[key];
  if (left == null) return 0;
  return DIRECTOR.FATIGUE_MAX * fresh(now - left, DIRECTOR.FATIGUE_MS);
}

function toShot(c: Candidate, now: number): Shot {
  return { key: c.key, kind: c.kind, agentIds: c.agentIds, locationId: c.locationId, label: c.label, since: now, score: c.score };
}

function sameSubject(a: { agentIds: number[]; locationId: number | null }, b: { agentIds: number[]; locationId: number | null }): boolean {
  if (a.agentIds.length > 0 && b.agentIds.length > 0) return a.agentIds[0] === b.agentIds[0];
  return a.agentIds.length === 0 && b.agentIds.length === 0 && a.locationId != null && a.locationId === b.locationId;
}

/** Forget fatigue entries that have fully faded. */
function pruneRecent(recent: DirectorState['recent'], now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries(recent)) if (now - t < DIRECTOR.FATIGUE_MS) out[k] = t;
  return out;
}

/** Leave `cur` for `next`: remember the shot we left (fatigue) and the place we visited (roam trail). */
function moveTo(state: DirectorState, next: Shot, now: number): StepResult {
  const cur = state.current;
  const recent = pruneRecent(state.recent, now);
  if (cur && cur.kind !== 'roam') recent[cur.key] = now;
  const trail = next.locationId != null && next.kind === 'roam'
    ? [...state.roamTrail, next.locationId].slice(-DIRECTOR.ROAM_MEMORY * 2)
    : state.roamTrail;
  return { state: { current: next, recent, roamTrail: trail }, cut: next };
}

function roamShot(world: WorldSnapshot, trail: readonly number[], now: number): Shot {
  const stop = pickRoamStop(world.locations, world.agents, trail);
  if (!stop) {
    // No label: a lower-third announcing "nothing is happening" is noise.
    return { key: 'roam:idle', kind: 'roam', agentIds: [], locationId: null, label: '', since: now, score: 0 };
  }
  return {
    key: `roam:${stop.id}`,
    kind: 'roam',
    agentIds: [],
    locationId: stop.id,
    label: stop.name ? `Life at ${stop.name}` : 'Life in town',
    since: now,
    score: 0,
  };
}

/**
 * One director decision. Call it every `DIRECTOR.TICK_MS` with fresh candidates;
 * feed the returned `state` back in. `cut` is the only thing the camera needs to
 * act on.
 *
 * Order of rules (each one is a test):
 *   - no shot yet → best candidate above IDLE_SCORE, else a roam stop;
 *   - inside the minimum hold → stay, whatever else appears (a roam stop only
 *     holds until ROAM_PREEMPT_MS, then yields to anything above IDLE_SCORE);
 *   - after the hold → stay unless the current shot has gone stale (below
 *     IDLE_SCORE: the conversation ended, the alert aged out) or a challenger
 *     beats it by SWITCH_MARGIN;
 *   - nothing above IDLE_SCORE → roam;
 *   - a "better" candidate about the same lead resident is a relabel, not a cut.
 */
export function stepDirector(
  state: DirectorState,
  candidates: readonly Candidate[],
  now: number,
  world: WorldSnapshot,
): StepResult {
  const cur = state.current;
  const ranked = candidates
    .map((c) => ({ ...c, adj: c.score - fatigue(state.recent, c.key, cur?.key, now) }))
    .sort((a, b) => b.adj - a.adj || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const best = ranked.find((c) => c.adj >= DIRECTOR.IDLE_SCORE) ?? null;

  if (!cur) {
    return moveTo(state, best ? toShot(best, now) : roamShot(world, state.roamTrail, now), now);
  }

  const elapsed = now - cur.since;

  if (cur.kind === 'roam') {
    if (best) {
      if (elapsed < DIRECTOR.ROAM_PREEMPT_MS) return { state, cut: null };
      return moveTo(state, toShot(best, now), now);
    }
    if (elapsed < DIRECTOR.ROAM_DWELL_MS) return { state, cut: null };
    // The current stop is already the newest entry of the trail (moveTo put it there).
    const next = roamShot(world, state.roamTrail, now);
    if (next.key === cur.key) {
      // The only busy place is where we already are: keep the shot, restart its clock.
      return { state: { ...state, current: { ...cur, since: now } }, cut: null };
    }
    return moveTo(state, next, now);
  }

  // The live version of the current shot: same key, or another candidate about
  // the same lead resident (an alert about someone who has since started talking).
  const live = ranked.find((c) => c.key === cur.key) ?? ranked.find((c) => sameSubject(c, cur)) ?? null;
  const curScore = live ? live.adj : 0;

  if (elapsed < DIRECTOR.MIN_HOLD_MS[cur.kind]) {
    return { state: { ...state, current: { ...cur, score: curScore } }, cut: null };
  }

  const challenger = best && best.key !== cur.key && !sameSubject(best, cur) ? best : null;
  const stale = curScore < DIRECTOR.IDLE_SCORE;

  if (challenger && (stale || challenger.adj > curScore + DIRECTOR.SWITCH_MARGIN)) {
    return moveTo(state, toShot(challenger, now), now);
  }
  if (stale) {
    return moveTo(state, roamShot(world, state.roamTrail, now), now);
  }
  // Staying. If the scene changed hands to a same-subject candidate, relabel it
  // in place: same place, same people, so no cut and no hold-clock reset.
  const relabel = live && live.key !== cur.key ? { ...cur, key: live.key, kind: live.kind, label: live.label } : cur;
  return { state: { ...state, current: { ...relabel, score: curScore } }, cut: null };
}
