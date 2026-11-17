/**
 * Pure rules behind the couples system (no Pixi, no allocation in the per-frame helpers):
 * who counts as an open couple, when two people are "arm in arm" or "idle together", how far
 * to pull them together, and the throttles for hearts and glances.
 *
 * Only adults ever show up here. `AgentLite.age` is optional on the client, so a missing or
 * non-numeric age is treated as a minor: the check fails closed, like the server's
 * `isIntimacyEligible` it mirrors.
 */

/** Same cut-off as the server's `isIntimacyEligible`. */
export const ADULT_AGE = 18;

/**
 * Tags that make a bond public. `lovers` is deliberately absent: the client cannot know whether
 * the affair is secret, and secret lovers keep their distance in public -- that is the realism.
 */
const OPEN_TAGS = ['married', 'engaged', 'partner'] as const;
/** A couple who have fallen out do not stroll hand in hand. */
const ESTRANGED_TAG = 'estranged';

/** Walking within this many px of each other, heading the same way = arm in arm. */
export const ARM_IN_ARM_PX = 48;
/** Once arm in arm they stay so out to this distance (hysteresis: no flicker at the edge). */
const ARM_IN_ARM_KEEP_PX = ARM_IN_ARM_PX + 12;
/** Standing within this many px = they turn to face each other. */
export const FACING_PX = 40;
/** An infatuated agent this close (px) to their crush steals glances. */
export const GLANCE_PX = 80;

/** Smoothed speed (px/s) above which someone counts as walking; lower to keep the state. */
const WALK_ENTER = 4;
const WALK_KEEP = 2;
/** cos(angle) between the two headings above which they walk "the same way" (60 degrees). */
const SAME_HEADING_COS = 0.5;

/** Total pull between the pair is twice this (each side steps toward the other). */
const NUDGE_EACH_PX = 3;
/** Never pull them closer than this centre-to-centre. */
const MIN_GAP_PX = 10;
/** Horizontal dead zone for "turn toward": within it, keep the facing they have. */
const FACE_DEADZONE_PX = 4;

/** A pair shows at most one heart per this long. */
export const HEART_GAP_MS = 25_000;
/** Up to this much extra random wait after the minimum, so couples do not pulse together. */
const HEART_JITTER_MS = 10_000;

const GLANCE_GAP_MIN_MS = 4000;
const GLANCE_GAP_SPAN_MS = 2000;
/** How long the eyes stay on the crush before the agent looks away again. */
export const GLANCE_HOLD_MS = 900;

export interface CouplePair {
  a: number;
  b: number;
  key: string;
}

export function isAdultAge(age: unknown): boolean {
  return typeof age === 'number' && Number.isFinite(age) && age >= ADULT_AGE;
}

export function coupleKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function isOpenCouple(tags: unknown): boolean {
  if (!Array.isArray(tags) || tags.includes(ESTRANGED_TAG)) return false;
  for (const t of OPEN_TAGS) if (tags.includes(t)) return true;
  return false;
}

/**
 * Open couples out of `relationships.getGraph` rows, both members adults (per `isAdult`).
 * Fills and returns `out` (cleared first) so the poll handler can reuse one array.
 */
export function openCouplePairs(
  rows: ReadonlyArray<{ agent_a?: unknown; agent_b?: unknown; tags?: unknown } | null | undefined> | undefined,
  isAdult: (id: number) => boolean,
  out: CouplePair[] = [],
): CouplePair[] {
  out.length = 0;
  if (!rows) return out;
  for (const r of rows) {
    if (!r || typeof r.agent_a !== 'number' || typeof r.agent_b !== 'number' || r.agent_a === r.agent_b) continue;
    if (!isOpenCouple(r.tags)) continue;
    if (!isAdult(r.agent_a) || !isAdult(r.agent_b)) continue;
    const a = Math.min(r.agent_a, r.agent_b);
    const b = Math.max(r.agent_a, r.agent_b);
    out.push({ a, b, key: coupleKey(a, b) });
  }
  return out;
}

/** Both moving, and their headings within 60 degrees of each other. Velocities in any unit. */
export function sameHeading(vax: number, vay: number, vbx: number, vby: number): boolean {
  const la = Math.hypot(vax, vay);
  const lb = Math.hypot(vbx, vby);
  if (la < 1e-3 || lb < 1e-3) return false;
  return (vax * vbx + vay * vby) / (la * lb) >= SAME_HEADING_COS;
}

/** Walking together and close enough (with hysteresis once already arm in arm). */
export function armInArmNow(
  was: boolean, dist: number, vax: number, vay: number, vbx: number, vby: number,
): boolean {
  if (dist > (was ? ARM_IN_ARM_KEEP_PX : ARM_IN_ARM_PX)) return false;
  const min = was ? WALK_KEEP : WALK_ENTER;
  if (Math.hypot(vax, vay) < min || Math.hypot(vbx, vby) < min) return false;
  return sameHeading(vax, vay, vbx, vby);
}

/** Close and neither of them walking. */
export function idleTogetherNow(dist: number, vax: number, vay: number, vbx: number, vby: number): boolean {
  return dist <= FACING_PX && Math.hypot(vax, vay) < WALK_KEEP && Math.hypot(vbx, vby) < WALK_KEEP;
}

/** How far each of a pair at `dist` steps toward the other: 3 px, less if they are nearly touching. */
export function nudgeFor(dist: number): number {
  return Math.min(NUDGE_EACH_PX, Math.max(0, (dist - MIN_GAP_PX) / 2));
}

/** Which way to face to look at something `dx` px to the right (+) or left (-); 0 = keep facing. */
export function facingToward(dx: number): 1 | -1 | 0 {
  return dx > FACE_DEADZONE_PX ? 1 : dx < -FACE_DEADZONE_PX ? -1 : 0;
}

export function heartDue(now: number, nextAt: number): boolean {
  return now >= nextAt;
}

/** When the next heart may show after one at `now`: never sooner than `HEART_GAP_MS`. */
export function nextHeartAt(now: number, rand01: number): number {
  return now + HEART_GAP_MS + rand01 * HEART_JITTER_MS;
}

/** Wait until the next glance: 4 to 6 seconds. */
export function glanceGapMs(rand01: number): number {
  return GLANCE_GAP_MIN_MS + rand01 * GLANCE_GAP_SPAN_MS;
}
