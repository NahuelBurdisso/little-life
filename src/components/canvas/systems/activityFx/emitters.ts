import type { FxSprite } from './activityFrames';

/**
 * Particle emitters attached to an agent while an activity runs. Pure data + the scheduling
 * arithmetic, so every cadence is unit tested and the system only spawns what this module says.
 *
 * All timing runs on one absolute clock per agent (`performance.now()/1000` plus a per-agent
 * phase, see `agentPhase`). That makes cadences deterministic across frames and lets an emitter
 * line up with a held item that runs on the same clock (the watering can pours for the first
 * 0.9 s of every 9, so the drops fall for exactly that long).
 */
export interface EmitterSpec {
  sprite: FxSprite;
  /**
   * When a shot fires: every `every` seconds starting at `offset`, or on each hammer-stroke
   * (the body's `workStroke` crossing the strike line), which is when a smith's sparks fly.
   */
  every?: number;
  offset?: number;
  trigger?: 'stroke';
  /** Particles per shot (default 1). */
  count?: number;
  /** Fire only during [from, to) seconds of each `period` (a pour, a shout). */
  window?: { period: number; from: number; to: number };

  /**
   * Where the particle starts, px from the feet with x mirrored by facing.
   * hand: follows the body's bob and lean; ground: planted on the floor; bobber: out over the water;
   * roof: the top edge of the building the agent is inside (x, y are px from its middle-top, not
   * mirrored by facing), for effects that belong to the house rather than a body -- and which,
   * unlike every other anchor, still fire for an agent lying down (a bed) or indoors.
   */
  at: 'hand' | 'ground' | 'bobber' | 'roof';
  x: number;
  y: number;
  spreadX?: number;
  spreadY?: number;

  /** Initial velocity in px/s; vx mirrors with facing. */
  vx?: number;
  vy?: number;
  velSpreadX?: number;
  velSpreadY?: number;
  /** px/s^2 downwards. */
  gravity?: number;

  life: number;
  /** life: frames stretch over the life. loop: frames cycle at fps. pick: one random frame per particle. */
  anim?: 'life' | 'loop' | 'pick';
  fps?: number;
  scale?: number;
  /** Mirror the sprite with facing (sound waves open the way the agent looks). */
  flip?: boolean;
  /** Tilt along the direction of travel (a leaping fish). */
  tilt?: boolean;
  /** Which canvas layer: under the agents (dust, ripples) or over them. */
  layer?: 'ground' | 'over';
  /** Skip at far zoom unless the detail level is at least this (default 1). */
  minDetail?: 1 | 2;
}

/** k-th shot of a `every`/`offset` schedule falls in (from, to]: how many shots is that? */
export function shotsBetween(every: number, offset: number, from: number, to: number): number {
  if (!(every > 0) || !(to > from)) return 0;
  return Math.max(0, Math.floor((to - offset) / every) - Math.floor((from - offset) / every));
}

/** Index of the shot that fired last at or before `t` (0 for the first, may be negative before `offset`). */
export function shotIndex(every: number, offset: number, t: number): number {
  return Math.floor((t - offset) / every);
}

export function inWindow(w: EmitterSpec['window'], t: number): boolean {
  if (!w) return true;
  // (Adding the period before the second modulo would smear float error into the edges.)
  let m = t % w.period;
  if (m < 0) m += w.period;
  return m >= w.from && m < w.to;
}

/** Whether the edge from `prev` to `cur` crosses upward through `line` (a hammer strike). */
export function crossedUp(prev: number, cur: number, line: number): boolean {
  return prev <= line && cur > line;
}

/** Per-agent time offset in seconds, so neighbours do not sip, blink and puff in lockstep. */
export function agentPhase(id: number | string): number {
  return (Number(id) * 1.618) % 10 || 0;
}
