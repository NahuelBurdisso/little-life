import type { ConversationLite } from '../../../../lib/apiTypes';
/**
 * Pure helpers behind the player-action effects: curves, timings and "is it over yet"
 * decisions. No PixiJS, so all of it is unit tested; the effects only feed these numbers
 * into sprites.
 */

const TILE = 32;

// ── Lifetimes ────────────────────────────────────────────────────────────────────────────────

/** The matchmaker arc shows at least this long even if the pair already stands together. */
export const TALK_MIN_S = 2;
/** ...and never longer than this: a pair that never meets must not keep an arc forever. */
export const TALK_MAX_S = 60;
/** Close enough to count as "together": about two tiles. */
export const TALK_NEAR_PX = 2 * TILE;

export const PIN_MIN_S = 1.5;
export const PIN_MAX_S = 90;
/** Within this distance of the pin the agent has effectively arrived. */
export const PIN_NEAR_PX = 40;

export interface TalkState { elapsed: number; dist: number; talking: boolean }
export function talkArcDone(s: TalkState): boolean {
  if (s.elapsed >= TALK_MAX_S) return true;
  return s.elapsed >= TALK_MIN_S && (s.dist <= TALK_NEAR_PX || s.talking);
}

export interface PinState { elapsed: number; atLocation: boolean; dist: number }
export function pinDone(s: PinState): boolean {
  if (s.elapsed >= PIN_MAX_S) return true;
  return s.elapsed >= PIN_MIN_S && (s.atLocation || s.dist <= PIN_NEAR_PX);
}

/** Whether two agents are in the same active conversation (ids may be numbers or strings). */
export function isTalking(conversations: ArrayLike<ConversationLite> | null | undefined, a: number, b: number): boolean {
  if (!conversations) return false;
  for (let i = 0; i < conversations.length; i++) {
    const c = conversations[i];
    if (!c || c.status !== 'active') continue;
    const ids = c.participants as ArrayLike<number | string> | undefined;
    if (!ids) continue;
    let hasA = false, hasB = false;
    for (let k = 0; k < ids.length; k++) {
      const id = Number(ids[k]);
      if (id === a) hasA = true;
      else if (id === b) hasB = true;
    }
    if (hasA && hasB) return true;
  }
  return false;
}

// ── Curves ───────────────────────────────────────────────────────────────────────────────────

export interface Point { x: number; y: number }

/**
 * Point at `f` (0..1) on a quadratic curve from A to B whose apex rises `bow` px above the
 * chord (screen-up = negative y). Writes into `out` — it runs per dot per frame.
 */
export function arcPoint(ax: number, ay: number, bx: number, by: number, bow: number, f: number, out: Point): Point {
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2 - bow * 2;
  const u = 1 - f;
  out.x = u * u * ax + 2 * u * f * cx + f * f * bx;
  out.y = u * u * ay + 2 * u * f * cy + f * f * by;
  return out;
}

export function arcBow(dist: number): number {
  return Math.min(28, Math.max(8, dist * 0.3));
}

/** Dots along an arc/line: one per ~14 px, between 6 and `max`. */
export function dotCount(dist: number, max = 18): number {
  return Math.max(6, Math.min(max, Math.round(dist / 14)));
}

/**
 * Brightness of the dot at fraction `f` along the path at time `t`: a soft wave running
 * from A to B, so the arc reads as something being carried across.
 */
export function pulse(f: number, t: number): number {
  const w = Math.sin(t * 4 - f * Math.PI * 3);
  return 0.35 + 0.65 * Math.max(0, w);
}

// ── Motions ──────────────────────────────────────────────────────────────────────────────────

export function easeIn(f: number): number {
  const c = Math.min(1, Math.max(0, f));
  return c * c;
}
export function easeInOut(f: number): number {
  const c = Math.min(1, Math.max(0, f));
  return c * c * (3 - 2 * c);
}

/** Alpha that stays 1 until the last `span` seconds of `life`, then falls linearly to 0. */
export function fadeOut(elapsed: number, life: number, span: number): number {
  const left = life - elapsed;
  if (left <= 0) return 0;
  return left >= span ? 1 : left / span;
}

/**
 * Height above the ground of something dropped from `height` px: falls (accelerating),
 * then bounces twice, each smaller and quicker. 0 once it rests.
 */
export function dropBounce(t: number, height: number): number {
  const FALL = 0.32, B1 = 0.22, B2 = 0.13;
  if (t <= 0) return height;
  if (t < FALL) { const f = t / FALL; return height * (1 - f * f); }
  let r = t - FALL;
  if (r < B1) { const f = r / B1; return height * 0.22 * 4 * f * (1 - f); }
  r -= B1;
  if (r < B2) { const f = r / B2; return height * 0.07 * 4 * f * (1 - f); }
  return 0;
}

/** Arc height of a repeated hop: `hops` hops of `hopS` seconds each, then flat. */
export function hopHeight(t: number, hopS: number, hops: number, height: number): number {
  if (t <= 0 || t >= hopS * hops) return 0;
  return Math.abs(Math.sin((t / hopS) * Math.PI)) * height;
}

/** Coins that rain onto the agent: a few for pocket change, a shower for a fortune. */
export function coinCount(amount: number): number {
  const a = Math.max(1, Number.isFinite(amount) ? amount : 1);
  return Math.min(8, Math.max(2, 2 + Math.floor(Math.log10(a) * 2)));
}

/** Seconds a whisper takes to cross from teller to listener: slower over longer distances. */
export function secretTravelSeconds(dist: number): number {
  return Math.min(2, Math.max(0.9, dist / 150));
}

/** Integer scale for the event burst so a 32px cell covers a building of `w` x `h`. */
export function burstScale(w: number, h: number): number {
  return Math.min(6, Math.max(2, Math.round(Math.max(w, h) / 32)));
}

/**
 * Point `u` (0..1, wraps) around the outline of a rectangle, starting top-left, clockwise.
 * Used to place the sparkles that pop around an event's building.
 */
export function perimeterPoint(x: number, y: number, w: number, h: number, u: number, out: Point): Point {
  const per = 2 * (w + h);
  let d = (((u % 1) + 1) % 1) * per;
  if (d < w) { out.x = x + d; out.y = y; return out; }
  d -= w;
  if (d < h) { out.x = x + w; out.y = y + d; return out; }
  d -= h;
  if (d < w) { out.x = x + w - d; out.y = y + h; return out; }
  d -= w;
  out.x = x; out.y = y + h - d;
  return out;
}

/** The weather flash: a quick swell to `peak`, then a longer decay to nothing at `life`. */
export function flashAlpha(elapsed: number, peak: number, life: number): number {
  if (elapsed <= 0 || elapsed >= life) return 0;
  const attack = 0.08;
  if (elapsed < attack) return peak * (elapsed / attack);
  return peak * (1 - (elapsed - attack) / (life - attack));
}

// ── Planting powers (whisper / rumor / feeling) ──────────────────────────────────────────────

/**
 * Point `f` (0..1) of a thought falling into an agent's head: it starts `height` px above,
 * circles inward on a shrinking loop and lands on (0, 0). Offsets from the head, into `out`.
 */
export function thoughtFallPoint(f: number, height: number, out: Point): Point {
  const c = Math.min(1, Math.max(0, f));
  const r = 16 * (1 - c);
  const a = c * Math.PI * 3;
  out.x = Math.sin(a) * r;
  out.y = -height * (1 - c) * (1 - c) + Math.cos(a) * r * 0.35;
  return out;
}

/**
 * Where rumor wisp `i` of `n` is at `f` (0..1) of its drift: they leave the head in a fan
 * (upper half-circle, left to right) and slow as they go, like talk carried off on the air.
 */
export function rumorWispPoint(i: number, n: number, f: number, dist: number, out: Point): Point {
  const c = Math.min(1, Math.max(0, f));
  const a = Math.PI * (1.1 + 0.8 * (n > 1 ? i / (n - 1) : 0.5));
  const d = dist * (1 - (1 - c) * (1 - c));
  out.x = Math.cos(a) * d;
  out.y = Math.sin(a) * d * 0.6 - 6 * c;
  return out;
}

/**
 * A stirred feeling rising around an agent: particle `i` of `n`, `f` (0..1) through its own
 * climb, orbiting on a flattened ring that narrows as it rises. Offsets from the feet.
 */
export function feelingSpiralPoint(i: number, n: number, f: number, t: number, rise: number, out: Point): Point {
  const c = Math.min(1, Math.max(0, f));
  const a = t * 3 + (i / Math.max(1, n)) * Math.PI * 2;
  const r = 14 * (1 - c * 0.5);
  out.x = Math.cos(a) * r;
  out.y = -6 - c * rise + Math.sin(a) * r * 0.35;
  return out;
}

export interface FeelingStyle {
  /** playerfx.png cell name the particles use. */
  cell: 'dotHeart' | 'dotPinkBig' | 'dotGoldBig' | 'dotGold' | 'swirl';
  /** Multiplied into the cell's colours (0xffffff = as drawn). */
  tint: number;
  /** Emote over the agent (an emotes.png name, same as BubbleSystem's STATE_EMOTES). */
  emote: string;
}

/** How each stirrable feeling looks. Unknown ones get plain gold dots and a "!". */
export function feelingStyle(state: string | undefined): FeelingStyle {
  switch (state) {
    case 'infatuated': return { cell: 'dotHeart', tint: 0xffffff, emote: 'heart' };
    case 'jealous': return { cell: 'dotPinkBig', tint: 0x9bd46a, emote: 'fire' };
    case 'confident': return { cell: 'dotGoldBig', tint: 0xffffff, emote: 'star' };
    case 'stressed': return { cell: 'swirl', tint: 0xa9b8d6, emote: 'sweat' };
    default: return { cell: 'dotGold', tint: 0xffffff, emote: 'exclaim' };
  }
}
