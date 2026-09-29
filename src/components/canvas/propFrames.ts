/**
 * Cell layout of `/sprites/props/props.png` (scripts/aseprite/nature-props.lua) and the
 * per-tile variant choice. Pure — no PixiJS — so it can be unit tested.
 */
export const PROP_FRAMES = {
  tree: [0, 1, 2, 3],     // oak, round, fruit, pine
  bush: [4, 5, 6],        // plain, berry, flowering
  rock: [7, 8],           // boulder, stones
  flowers: [9, 10, 11],   // pink, yellow, white
} as const;

export const PROP_FRAME_COUNT = 12;
export const PROPS_URL = '/sprites/props/props.png';

export type PropSpriteKind = keyof typeof PROP_FRAMES;

/**
 * Which cell a prop on tile (x, y) uses. Deterministic per tile, so a re-render (or a
 * reload) never reshuffles the forest. `h` is the tile hash the renderer already uses
 * for placement jitter; the variant reads different bits so it doesn't correlate with
 * the jitter.
 */
export function propFrame(kind: PropSpriteKind, h: number): number {
  const cells = PROP_FRAMES[kind];
  return cells[(h >>> 23) % cells.length];
}
