import type { BeatKind } from './beatDetect';

/**
 * Cell layout of `/sprites/fx/beats.png` (scripts/aseprite/beat-fx.lua, 32x32 cells) and how
 * each story beat is dressed. Pure — no PixiJS — so it can be unit tested.
 * Keep `ANIMS` in step with the header comment of the Lua script.
 */
export const BEATS_URL = '/sprites/fx/beats.png';
export const BEATS_FRAME_COUNT = 48;
export const BEATS_FRAME_SIZE = 32;

export type FxName =
  | 'brawl' | 'giftBox' | 'giftPop' | 'heart' | 'broken' | 'cuffs'
  | 'whisper' | 'levelup' | 'cake' | 'ghost' | 'ping';

export interface FxAnim {
  /** First cell in the strip. */
  start: number;
  count: number;
  fps: number;
  /** How many times the frames play back to back (candle flicker, murmur waves). */
  loops: number;
}

export const FX_ANIMS: Record<FxName, FxAnim> = {
  brawl:   { start: 0,  count: 6, fps: 5, loops: 1 },
  giftBox: { start: 6,  count: 1, fps: 1, loops: 1 },
  giftPop: { start: 7,  count: 4, fps: 5, loops: 1 },
  heart:   { start: 11, count: 5, fps: 5, loops: 1 },
  broken:  { start: 16, count: 5, fps: 4, loops: 1 },
  cuffs:   { start: 21, count: 4, fps: 4, loops: 1 },
  whisper: { start: 25, count: 4, fps: 6, loops: 2 },
  levelup: { start: 29, count: 5, fps: 5, loops: 1 },
  cake:    { start: 34, count: 4, fps: 6, loops: 2 },
  ghost:   { start: 38, count: 5, fps: 3, loops: 1 },
  ping:    { start: 43, count: 5, fps: 6, loops: 1 },
};

/** Seconds a whole animation lasts. */
export function fxDuration(name: FxName): number {
  const a = FX_ANIMS[name];
  return (a.count * a.loops) / a.fps;
}

/** The absolute strip cell to show `elapsed` seconds into the animation (holds the last frame). */
export function fxFrame(name: FxName, elapsed: number): number {
  const a = FX_ANIMS[name];
  const step = Math.floor(Math.max(0, elapsed) * a.fps);
  const last = a.count * a.loops - 1;
  return a.start + (Math.min(step, last) % a.count);
}

/** A gifted box flies from giver to receiver for this long, then pops. */
export const GIFT_TRAVEL_S = 0.8;
/** Pixels the ghost drifts upward over its life. */
export const GHOST_RISE_PX = 26;

export interface BeatStyle {
  fx: FxName;
  /** Pixels above the agents' feet the effect is centred (body height ≈ 12, head ≈ 27). */
  lift: number;
  /** Horizontal shift from the anchor, in px. */
  dx?: number;
  scale?: number;
  /** Vertical squash: a ring on the ground is an ellipse. */
  squashY?: number;
  /** Emote for the first / second agent of the beat (null = none). */
  emotes: readonly [string | null, string | null];
}

/**
 * Emote names are the ones planned for the pixel-emote atlas (workstream A); until that
 * lands BubbleSystem draws an unknown name as a "?" emoji.
 */
export const BEAT_STYLE: Record<BeatKind | 'intervention', BeatStyle> = {
  fight:      { fx: 'brawl',   lift: 10, emotes: ['anger', 'anger'] },
  gift:       { fx: 'giftPop', lift: 12, emotes: [null, 'gift'] },
  romance:    { fx: 'heart',   lift: 22, emotes: ['heart', 'heart'] },
  heartbreak: { fx: 'broken',  lift: 22, emotes: ['broken_heart', 'broken_heart'] },
  arrest:     { fx: 'cuffs',   lift: 10, emotes: ['handcuffs', 'exclaim'] },
  secret:     { fx: 'whisper', lift: 20, emotes: ['whisper', 'exclaim'] },
  levelup:    { fx: 'levelup', lift: 16, emotes: ['levelup', null] },
  birthday:   { fx: 'cake',    lift: 11, dx: 15, emotes: ['cake', null] },
  death:      { fx: 'ghost',   lift: 14, emotes: [null, null] },
  intervention: { fx: 'ping',  lift: 4, scale: 1, squashY: 0.6, emotes: ['exclaim', 'exclaim'] },
};

/** Whole life of one beat's effect, in seconds. */
export function beatDuration(kind: BeatKind | 'intervention'): number {
  const fx = BEAT_STYLE[kind].fx;
  if (fx === 'giftPop') return GIFT_TRAVEL_S + fxDuration('giftPop');
  return fxDuration(fx);
}
