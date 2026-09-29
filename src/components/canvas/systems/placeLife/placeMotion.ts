import type { Rng } from "../ambientLife/critters";
import { PLACE_FRAMES } from "./placeFrames";
import type { GlowPulse } from "./placePlan";
import type { Rect } from "./zoneGeometry";

/**
 * Motion rules of the place effects as small pure functions: how a glow pulses, how a spark
 * or a music note flies, how a hen pecks about. No PixiJS and no allocation in the steps (the
 * system preallocates the state objects and mutates them), and every random choice goes
 * through an injected `rnd`, so tests are deterministic.
 */

const between = (rnd: Rng, lo: number, hi: number) => lo + rnd() * (hi - lo);

// ── Glow pulses ─────────────────────────────────────────────────────────────────────────

const HEARTBEAT_PERIOD = 1.3;
const bump = (u: number, at: number, width: number) => {
  let d = Math.abs(u - at);
  if (d > 0.5) d = 1 - d;
  return d >= width ? 0 : 1 - d / width;
};

/**
 * Multiplier for a glow's alpha at time `t`, always within [1 - swing, 1]. `phase` (any
 * number) keeps neighbouring glows out of step.
 * - flicker: fire — three incommensurate sines, so it never visibly loops;
 * - breath: slow swell, for warm windows and stage lamps;
 * - heartbeat: two quick beats and a rest, for the clinic's sick-bay cross.
 */
export function pulseFactor(pulse: GlowPulse, swing: number, t: number, phase: number): number {
  let level: number; // 0..1, 1 = brightest
  if (pulse === 'flicker') {
    const n = Math.sin(t * 17 + phase) * 0.5 + Math.sin(t * 29.3 + phase * 1.7) * 0.3 + Math.sin(t * 7.1 + phase * 0.6) * 0.2;
    level = 0.5 + 0.5 * n;
  } else if (pulse === 'breath') {
    level = 0.5 + 0.5 * Math.sin(t * 2.2 + phase);
  } else {
    const u = (((t / HEARTBEAT_PERIOD + phase) % 1) + 1) % 1;
    level = Math.max(bump(u, 0.05, 0.12), 0.7 * bump(u, 0.27, 0.12));
  }
  return 1 - swing * (1 - level);
}

// ── Flying bits ─────────────────────────────────────────────────────────────────────────

export type ParticleKind = 'spark' | 'note' | 'puff' | 'dust';

/** Launch parameters of one particle: velocity (px/s), gravity (px/s²), lifetime (s). */
export interface Launch { vx: number; vy: number; g: number; life: number }

/**
 * Sparks: a hammer strike throws a short fan up from the anvil; a vent shoots a few embers
 * up and out of the chimney that cool as they climb.
 */
export function sparkLaunch(mode: 'hammer' | 'vent', rnd: Rng, out: Launch): Launch {
  if (mode === 'hammer') {
    out.vx = between(rnd, -42, 42);
    out.vy = between(rnd, -70, -28);
    out.g = 190;
    out.life = between(rnd, 0.32, 0.6);
  } else {
    out.vx = between(rnd, -16, 16);
    out.vy = between(rnd, -52, -26);
    out.g = 24;
    out.life = between(rnd, 0.9, 1.5);
  }
  return out;
}

/** Notes and chatter drift up and a little sideways, slowly enough to read. */
export function crowdLaunch(rnd: Rng, out: Launch): Launch {
  out.vx = between(rnd, -7, 7);
  out.vy = between(rnd, -17, -11);
  out.g = 0;
  out.life = between(rnd, 1.5, 2.1);
  return out;
}

/** Sparks age white-hot, orange, ember. */
export function sparkFrame(age01: number): number {
  const f = PLACE_FRAMES.spark;
  return f[Math.min(f.length - 1, Math.floor(age01 * f.length))];
}

/** Dust puff grows through its three frames. */
export function dustFrame(age01: number): number {
  const f = PLACE_FRAMES.dust;
  return f[Math.min(f.length - 1, Math.floor(age01 * f.length))];
}

/**
 * Fade envelope of a particle over its life: quick in, long out. Notes and puffs are alpha
 * 1 for most of the flight; sparks hold full brightness until the last quarter.
 */
export function particleAlpha(kind: ParticleKind, age01: number): number {
  const fadeIn = kind === 'spark' ? 0.02 : 0.12;
  const fadeOutStart = kind === 'spark' ? 0.75 : kind === 'dust' ? 0.35 : 0.65;
  if (age01 < fadeIn) return age01 / fadeIn;
  if (age01 > fadeOutStart) return Math.max(0, (1 - age01) / (1 - fadeOutStart));
  return 1;
}

// ── Chickens ────────────────────────────────────────────────────────────────────────────

export type ChickMode = 'stand' | 'peck' | 'walk';

export interface ChickState {
  x: number; y: number;
  tx: number; ty: number;
  mode: ChickMode;
  /** Seconds left in the current mode. */
  left: number;
  /** +1 faces right, -1 left. */
  facing: 1 | -1;
  /** Personal offset so the flock does not peck in unison. */
  phase: number;
}

export const CHICK_SPEED = 15;
/** An agent this close (px) sends a hen scurrying. */
export const CHICK_FLEE_RADIUS = 26;

export function newChick(): ChickState {
  return { x: 0, y: 0, tx: 0, ty: 0, mode: 'stand', left: 0, facing: 1, phase: 0 };
}

export function resetChick(c: ChickState, yard: Rect, rnd: Rng): ChickState {
  c.x = yard.x + rnd() * yard.width;
  c.y = yard.y + rnd() * yard.height;
  c.tx = c.x; c.ty = c.y;
  c.mode = 'stand';
  c.left = rnd() * 1.2;
  c.facing = rnd() < 0.5 ? 1 : -1;
  c.phase = rnd() * 10;
  return c;
}

function pickMode(c: ChickState, yard: Rect, rnd: Rng): void {
  const r = rnd();
  if (r < 0.5) {
    c.mode = 'peck';
    c.left = between(rnd, 1.2, 3);
  } else if (r < 0.78) {
    c.mode = 'walk';
    c.tx = yard.x + rnd() * yard.width;
    c.ty = yard.y + rnd() * yard.height;
    c.left = 6; // gives up if it never arrives
    if (Math.abs(c.tx - c.x) > 1) c.facing = c.tx > c.x ? 1 : -1;
  } else {
    c.mode = 'stand';
    c.left = between(rnd, 0.5, 1.4);
  }
}

/**
 * Advance a hen. `threatDx/Dy/D2` is the vector from the nearest agent and its squared
 * distance (Infinity when nobody is around): a close walker sends the hen away from them.
 */
export function stepChick(c: ChickState, dt: number, yard: Rect, rnd: Rng, threatDx: number, threatDy: number, threatD2: number): void {
  if (threatD2 < CHICK_FLEE_RADIUS * CHICK_FLEE_RADIUS) {
    const d = Math.sqrt(threatD2) || 1;
    c.tx = Math.min(yard.x + yard.width, Math.max(yard.x, c.x + (threatDx / d) * 30));
    c.ty = Math.min(yard.y + yard.height, Math.max(yard.y, c.y + (threatDy / d) * 30));
    c.mode = 'walk';
    c.left = 1;
    if (Math.abs(threatDx) > 1) c.facing = threatDx > 0 ? 1 : -1;
  }
  c.left -= dt;
  if (c.mode === 'walk') {
    const dx = c.tx - c.x, dy = c.ty - c.y;
    const dist = Math.hypot(dx, dy);
    const step = CHICK_SPEED * dt;
    if (dist <= step || c.left <= 0) {
      c.x = c.tx; c.y = c.ty;
      c.mode = 'stand';
      c.left = between(rnd, 0.3, 0.9);
    } else {
      c.x += (dx / dist) * step;
      c.y += (dy / dist) * step;
    }
    return;
  }
  if (c.left <= 0) pickMode(c, yard, rnd);
}

/** Frame of the hen for the given clock: pecking bobs at ~3 Hz, walking at ~6. */
export function chickFrame(c: ChickState, clock: number): number {
  const f = PLACE_FRAMES.chicken;
  if (c.mode === 'walk') return f.walk[Math.floor((clock + c.phase) * 6) % 2];
  if (c.mode === 'peck') return Math.floor((clock + c.phase) * 3) % 2 === 0 ? f.peck : f.stand;
  return f.stand;
}
