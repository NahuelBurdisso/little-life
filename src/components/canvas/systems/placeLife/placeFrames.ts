/**
 * Cell layout of the place-life atlases (scripts/aseprite/place-life.lua). Pure — no PixiJS —
 * so the behaviour modules and their tests can name frames. Keep in sync with the header of
 * that script.
 *
 * Everything is drawn facing right; the renderer mirrors with scale.x.
 */
export const PLACE_URL = '/sprites/fx/place.png';
export const PLACE_FRAME_SIZE = 16;
export const PLACE_FRAME_COUNT = 31;

export const PLACE_FRAMES = {
  /** Forge spark, cooling as it ages: white-hot, orange, dull ember. */
  spark: [0, 1, 2],
  /** Music notes: a single eighth and a beamed pair. */
  note: [3, 4],
  /** Chatter cloud whose three dots hop. */
  puff: [5, 6],
  /** Hanging sign, two swing poses each. */
  signOpen: [7, 8],
  signClosed: [9, 10],
  flag: { hang: 11, wave: [12, 13, 14], gust: [15, 16] },
  bell: { rest: 17, left: 18, right: 19 },
  /** Prison window bars with two hands wrapped round them (grip, shifted grip). */
  hands: [20, 21],
  chicken: { stand: 22, peck: 23, walk: [24, 25] },
  dust: [26, 27, 28],
  laundry: [29, 30],
} as const;

/** White dithered glows, tinted per use and drawn additively. */
export const GLOW_URL = '/sprites/fx/place-glow.png';
export const GLOW_FRAME_SIZE = 32;
export const GLOW_FRAME_COUNT = 3;
export const GLOW_FRAMES = { round: 0, cross: 1, wide: 2 } as const;
export type GlowShape = keyof typeof GLOW_FRAMES;
