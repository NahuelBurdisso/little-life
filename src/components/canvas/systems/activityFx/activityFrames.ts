/**
 * Cell layout of `/sprites/fx/activity-fx.png` (scripts/aseprite/activity-fx.lua): a strip of
 * 16x16 cells, the frames of each particle packed back to back in the order below. Pure — no
 * PixiJS — so the layout and its tests can be shared. The `-- ORDER:` line in the Lua header must
 * list the same names with the same frame counts (a test parses it).
 */
const SPEC = [
  ['steam', 3],
  ['sweat', 2],
  ['dust', 3],
  ['note', 3],
  ['spark', 3],
  ['coin', 4],
  ['flour', 3],
  ['ink', 2],
  ['cross', 2],
  ['ripple', 4],
  ['splash', 4],
  ['fish', 2],
  ['bobber', 2],
  ['drop', 3],
  ['glint', 4],
  ['wave', 3],
  ['crumb', 2],
  ['clap', 3],
] as const;

export type FxSprite = (typeof SPEC)[number][0];

export const FX_SPRITE_NAMES: readonly FxSprite[] = SPEC.map(s => s[0]);

export interface FxCells {
  /** First cell of the particle in the strip. */
  start: number;
  count: number;
}

export const FX_CELLS = ((): Record<FxSprite, FxCells> => {
  const out = {} as Record<FxSprite, FxCells>;
  let next = 0;
  for (const [name, count] of SPEC) {
    out[name] = { start: next, count };
    next += count;
  }
  return out;
})();

export const FX_CELL_COUNT = SPEC.reduce((n, s) => n + s[1], 0);
export const FX_CELL_SIZE = 16;
export const ACTIVITY_FX_URL = '/sprites/fx/activity-fx.png';

/**
 * Strip cell for a particle `age` seconds old.
 * - `life`: the frames are stretched over the particle's life (a puff grows and thins as it
 *   rises, a drop falls then splashes), holding the last one.
 * - `loop`: the frames cycle at `fps` (a spinning coin).
 */
export function fxCellAt(sprite: FxSprite, age: number, life: number, mode: 'life' | 'loop', fps = 8): number {
  const { start, count } = FX_CELLS[sprite];
  if (count === 1) return start;
  const a = age > 0 ? age : 0;
  if (mode === 'loop') return start + (Math.floor(a * fps) % count);
  const f = life > 0 ? a / life : 0;
  return start + Math.min(count - 1, Math.floor(f * count));
}
