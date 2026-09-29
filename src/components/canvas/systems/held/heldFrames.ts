/**
 * Cell layout of `/sprites/fx/held.png` (scripts/aseprite/held-items.lua): a strip of
 * 16x16 cells, one per item, plus a raised-arm variant of the hammer. Pure — no PixiJS —
 * so the item logic and its tests can share it. Keep the frame numbers and grips in sync
 * with the Lua header.
 *
 *   0 hammer   1 hammer (raised)   2 rolling pin   3 clipboard   4 ledger
 *   5 mug      6 quill             7 keys          8 hoe         9 plate
 *   10 basket  11 fishing rod      12 watering can 13 lute       14 book
 */
export const HELD_URL = '/sprites/fx/held.png';
export const HELD_FRAME_SIZE = 16;
export const HELD_FRAME_COUNT = 15;

export type HeldItemId =
  | 'hammer' | 'rolling_pin' | 'clipboard' | 'ledger' | 'mug' | 'quill' | 'keys' | 'hoe'
  | 'plate' | 'basket' | 'rod' | 'watering_can' | 'lute' | 'book';

/**
 * How an item moves in the hand:
 * - swing: follows the body's work stroke (0 = rest, 1 = bottom of the stroke)
 * - bob:   gentle continuous sway (rod in the water, lute being strummed, keys dangling)
 * - sip:   level, then tips toward the face for a moment every few seconds
 * - none:  held still
 */
export type HeldMotion = 'swing' | 'bob' | 'sip' | 'none';

export interface HeldItemDef {
  /** Cell in the strip. */
  frame: number;
  /** Second cell used at the top of a swing (the hammer's raised pose). */
  altFrame: number | null;
  /** Pixel inside the cell that sits in the hand; the sprite pivots around it. */
  grip: { x: number; y: number };
  motion: HeldMotion;
  /** Resting rotation in radians (positive = tip leans toward the way the agent faces). */
  baseRot: number;
  /** Swing depth (swing), sway size (bob) or tip angle (sip), in radians. */
  amp: number;
  /** bob: angular speed in rad/s. sip: seconds between sips. */
  rate: number;
  /**
   * Still worth drawing when the agent's back is to the camera. Tools held out to the
   * side stay visible from behind; things held up in front of the chest (a plate, a
   * mug, a book) would only be seen through the body, so they hide instead.
   */
  visibleFromBehind: boolean;
}

export const HELD_ITEMS: Record<HeldItemId, HeldItemDef> = {
  hammer:       { frame: 0,  altFrame: 1,    grip: { x: 10, y: 12 }, motion: 'swing', baseRot: -0.1, amp: 1.1, rate: 0, visibleFromBehind: true },
  rolling_pin:  { frame: 2,  altFrame: null, grip: { x: 2,  y: 8 },  motion: 'swing', baseRot: -0.1, amp: 0.5, rate: 0, visibleFromBehind: true },
  clipboard:    { frame: 3,  altFrame: null, grip: { x: 8,  y: 12 }, motion: 'none',  baseRot: 0.1,  amp: 0,   rate: 0, visibleFromBehind: false },
  ledger:       { frame: 4,  altFrame: null, grip: { x: 8,  y: 12 }, motion: 'none',  baseRot: 0.1,  amp: 0,   rate: 0, visibleFromBehind: false },
  mug:          { frame: 5,  altFrame: null, grip: { x: 8,  y: 10 }, motion: 'sip',   baseRot: 0,    amp: 0.7, rate: 6, visibleFromBehind: false },
  quill:        { frame: 6,  altFrame: null, grip: { x: 6,  y: 11 }, motion: 'swing', baseRot: 0.1,  amp: 0.3, rate: 0, visibleFromBehind: false },
  keys:         { frame: 7,  altFrame: null, grip: { x: 8,  y: 3 },  motion: 'bob',   baseRot: 0,    amp: 0.14, rate: 2.6, visibleFromBehind: true },
  hoe:          { frame: 8,  altFrame: null, grip: { x: 8,  y: 12 }, motion: 'swing', baseRot: -0.35, amp: 0.9, rate: 0, visibleFromBehind: true },
  plate:        { frame: 9,  altFrame: null, grip: { x: 8,  y: 10 }, motion: 'none',  baseRot: 0,    amp: 0,   rate: 0, visibleFromBehind: false },
  basket:       { frame: 10, altFrame: null, grip: { x: 8,  y: 3 },  motion: 'bob',   baseRot: 0,    amp: 0.05, rate: 1.8, visibleFromBehind: true },
  rod:          { frame: 11, altFrame: null, grip: { x: 4,  y: 13 }, motion: 'bob',   baseRot: -0.1, amp: 0.08, rate: 2.2, visibleFromBehind: true },
  watering_can: { frame: 12, altFrame: null, grip: { x: 2,  y: 8 },  motion: 'sip',   baseRot: 0,    amp: 0.65, rate: 9, visibleFromBehind: true },
  lute:         { frame: 13, altFrame: null, grip: { x: 10, y: 6 },  motion: 'bob',   baseRot: -0.2, amp: 0.07, rate: 7, visibleFromBehind: true },
  book:         { frame: 14, altFrame: null, grip: { x: 8,  y: 12 }, motion: 'none',  baseRot: 0,    amp: 0,   rate: 0, visibleFromBehind: false },
};
// The hammer's raised variant is frame 1 (see `altFrame` above).
