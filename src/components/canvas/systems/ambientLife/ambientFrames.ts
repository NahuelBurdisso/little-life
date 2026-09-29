/**
 * Cell layout of `/sprites/fx/critters.png` (scripts/aseprite/critters.lua): 16x16 cells,
 * one horizontal strip. Keep in sync with the header comment of the Lua script. Pure — no
 * PixiJS — so the behaviour modules and their tests can name frames.
 *
 * Every critter is drawn facing right; the system mirrors with scale.x.
 */
export const AMBIENT_FRAMES = {
  /** Sparrow: head-up / head-down peck, a hop pose and two wing beats. */
  bird: { peck: [0, 1], hop: 2, fly: [3, 4] },
  butterfly: [5, 6],
  moth: [7, 8],
  cat: { sit: 9, walk: [10, 11], lick: 12 },
  duck: [13, 14],
  /** Well water: ripple rings plus a few droplets, three phases. */
  splash: [15, 16, 17],
} as const;

export const AMBIENT_FRAME_COUNT = 18;
export const AMBIENT_FRAME_SIZE = 16;
export const AMBIENT_URL = '/sprites/fx/critters.png';
