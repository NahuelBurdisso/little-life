/**
 * Frame selection for the per-agent animation sheets built by
 * `scripts/aseprite/agent-sheets.lua`. Pure — no PixiJS — so it can be unit tested.
 *
 * A sheet is one 32px-tall strip of 32×32 frames. Keep this table in sync with the
 * frame layout comment and `TAGS` at the top of the Lua script, and with `bodyFrames` in
 * src/lib/residentArt/bodySheet.ts (agentFrames.test.ts checks all three).
 */
export const SHEET_FRAMES = {
  idleDown: 0,
  blinkDown: 1,
  walkDown: [2, 3, 4, 5],
  idleUp: 6,
  walkUp: [7, 8, 9, 10],
  /** Profile facing right; the rig's horizontal flip turns it left. */
  idleSide: 11,
  walkSide: [12, 13, 14, 15],
} as const;

export const SHEET_FRAME_COUNT = 16;
export const SHEET_FRAME_SIZE = 32;

/**
 * Ground covered per walk frame. Agents are ~10px wide at 1× zoom; switching legs every
 * 4px reads as a brisk stroll without the feet visibly sliding.
 */
export const WALK_PX_PER_FRAME = 4;

export type SheetFacing = 'down' | 'up' | 'side';

/**
 * Hysteresis band for the side view, in degrees of the step above (or below) the horizontal.
 * A walk turns side-on below SIDE_ENTER_DEG and stops being side-on above SIDE_LEAVE_DEG; in
 * between it keeps whichever it was. Paths are 8-directional, so a route that isn't a straight
 * line is a zig-zag of 0°/45° or 45°/90° steps — and a 45° step sits in the band. With a single
 * threshold at 45° the body would flip between profile and front/back every tile, and on a
 * diagonal neither view is more right than the other, so staying put is the best answer.
 */
export const SIDE_ENTER_DEG = 35;
export const SIDE_LEAVE_DEG = 55;

/**
 * Which view a step shows: the profile for mostly-horizontal motion (the rig's facing mirrors
 * it for leftward steps), the back for mostly-northward, the front for mostly-southward.
 * A body that is already vertical picks up/down by the sign of the step even inside the band,
 * so it still turns its back when a diagonal starts heading north.
 */
export function facingFromStep(dx: number, dy: number, current: SheetFacing): SheetFacing {
  if (dx === 0 && dy === 0) return current;
  const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  const vertical: SheetFacing = dy < 0 ? 'up' : 'down';
  if (current === 'side') return angle > SIDE_LEAVE_DEG ? vertical : 'side';
  return angle < SIDE_ENTER_DEG ? 'side' : vertical;
}

export function pickAgentFrame(s: {
  facing: SheetFacing;
  walking: boolean;
  /** Distance walked since the current walk started, in px. */
  walkDistance: number;
  blinking: boolean;
}): number {
  if (s.walking) {
    const cycle = s.facing === 'up' ? SHEET_FRAMES.walkUp
      : s.facing === 'side' ? SHEET_FRAMES.walkSide
      : SHEET_FRAMES.walkDown;
    const i = Math.floor(s.walkDistance / WALK_PX_PER_FRAME) % cycle.length;
    return cycle[i];
  }
  if (s.facing === 'up') return SHEET_FRAMES.idleUp;
  // No side blink: the profile's eye is a single pixel, and closing it reads as a flicker.
  if (s.facing === 'side') return SHEET_FRAMES.idleSide;
  return s.blinking ? SHEET_FRAMES.blinkDown : SHEET_FRAMES.idleDown;
}
