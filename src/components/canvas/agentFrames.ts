/**
 * Frame selection for the per-agent animation sheets built by
 * `scripts/aseprite/agent-sheets.lua`. Pure — no PixiJS — so it can be unit tested.
 *
 * A sheet is one 32px-tall strip of 32×32 frames. Keep this table in sync with the
 * frame layout comment at the top of the Lua script.
 */
export const SHEET_FRAMES = {
  idleDown: 0,
  blinkDown: 1,
  walkDown: [2, 3, 4, 5],
  idleUp: 6,
  walkUp: [7, 8, 9, 10],
} as const;

export const SHEET_FRAME_COUNT = 11;
export const SHEET_FRAME_SIZE = 32;

/**
 * Ground covered per walk frame. Agents are ~10px wide at 1× zoom; switching legs every
 * 4px reads as a brisk stroll without the feet visibly sliding.
 */
export const WALK_PX_PER_FRAME = 4;

export type SheetFacing = 'down' | 'up';

/**
 * The sheet has a front and a back view; sideways motion uses the (mirrored) front.
 * Only a clearly northward step turns the agent's back to the camera — a diagonal that
 * is mostly sideways keeps the face visible, which is what the player wants to read.
 */
export function facingFromStep(dx: number, dy: number, current: SheetFacing): SheetFacing {
  if (dx === 0 && dy === 0) return current;
  if (Math.abs(dy) <= Math.abs(dx) * 0.5) return 'down';
  return dy < 0 ? 'up' : 'down';
}

export function pickAgentFrame(s: {
  facing: SheetFacing;
  walking: boolean;
  /** Distance walked since the current walk started, in px. */
  walkDistance: number;
  blinking: boolean;
}): number {
  if (s.walking) {
    const cycle = s.facing === 'up' ? SHEET_FRAMES.walkUp : SHEET_FRAMES.walkDown;
    const i = Math.floor(s.walkDistance / WALK_PX_PER_FRAME) % cycle.length;
    return cycle[i];
  }
  if (s.facing === 'up') return SHEET_FRAMES.idleUp;
  return s.blinking ? SHEET_FRAMES.blinkDown : SHEET_FRAMES.idleDown;
}
