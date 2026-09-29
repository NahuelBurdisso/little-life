/**
 * Cell layout of `/sprites/fx/playerfx.png` (scripts/aseprite/player-fx.lua, 32x32 cells) and
 * `/sprites/fx/playerfxdigits.png` (10x10 cells: "0".."9" then "+"). Pure — no PixiJS — so it
 * can be unit tested. The `-- LAYOUT:` line in the Lua header must list the same names with the
 * same counts (a test parses it).
 */
export const PFX_URL = '/sprites/fx/playerfx.png';
export const PFX_FRAME_COUNT = 52;
export const PFX_FRAME_SIZE = 32;

export const DIGITS_URL = '/sprites/fx/playerfxdigits.png';
/** "0".."9" then "+". */
export const DIGITS_FRAME_COUNT = 11;
export const DIGITS_FRAME_SIZE = 10;
/** Pixels from one glyph's centre to the next: 5px glyph + 1px gap (outlines overlap). */
export const DIGIT_ADVANCE = 6;
const PLUS_CELL = 10;

export type PfxName =
  | 'speech' | 'coin' | 'coinSparkle' | 'swirl' | 'clash' | 'column' | 'suitcase'
  | 'confetti' | 'poof' | 'pin' | 'groundRing' | 'burst'
  | 'dotPink' | 'dotPinkBig' | 'dotHeart' | 'dotGold' | 'dotGoldBig';

export interface PfxAnim {
  /** First cell in the strip. */
  start: number;
  count: number;
  fps: number;
  /** How many times the frames play back to back. */
  loops: number;
}

export const PFX_ANIMS: Record<PfxName, PfxAnim> = {
  speech:      { start: 0,  count: 4, fps: 3,  loops: 1 },
  coin:        { start: 4,  count: 4, fps: 12, loops: 1 },
  coinSparkle: { start: 8,  count: 3, fps: 9,  loops: 1 },
  swirl:       { start: 11, count: 4, fps: 10, loops: 1 },
  clash:       { start: 15, count: 5, fps: 6,  loops: 1 },
  column:      { start: 20, count: 6, fps: 8,  loops: 1 },
  suitcase:    { start: 26, count: 1, fps: 1,  loops: 1 },
  confetti:    { start: 27, count: 4, fps: 6,  loops: 1 },
  poof:        { start: 31, count: 5, fps: 9,  loops: 1 },
  pin:         { start: 36, count: 2, fps: 2,  loops: 1 },
  groundRing:  { start: 38, count: 4, fps: 6,  loops: 1 },
  burst:       { start: 42, count: 5, fps: 7,  loops: 1 },
  dotPink:     { start: 47, count: 1, fps: 1,  loops: 1 },
  dotPinkBig:  { start: 48, count: 1, fps: 1,  loops: 1 },
  dotHeart:    { start: 49, count: 1, fps: 1,  loops: 1 },
  dotGold:     { start: 50, count: 1, fps: 1,  loops: 1 },
  dotGoldBig:  { start: 51, count: 1, fps: 1,  loops: 1 },
};

/** Seconds one full playback (all loops) lasts. */
export function pfxDuration(name: PfxName): number {
  const a = PFX_ANIMS[name];
  return (a.count * a.loops) / a.fps;
}

/**
 * The absolute strip cell to show `elapsed` seconds in. A one-shot holds its last cell; a
 * multi-loop one wraps. `cycle` keeps wrapping forever (pins glinting, rings turning, speech
 * dots typing) instead of holding.
 */
export function pfxFrame(name: PfxName, elapsed: number, cycle = false): number {
  const a = PFX_ANIMS[name];
  const step = Math.floor(Math.max(0, elapsed) * a.fps);
  if (cycle) return a.start + (step % a.count);
  const last = a.count * a.loops - 1;
  return a.start + (Math.min(step, last) % a.count);
}

/** Digit-strip cells for a "+N" label: the plus, then one cell per decimal digit. */
export function digitCells(amount: number): number[] {
  const n = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0));
  const out = [PLUS_CELL];
  for (const ch of String(n)) out.push(ch.charCodeAt(0) - 48);
  return out;
}
