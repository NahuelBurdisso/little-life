/**
 * Pure rules for the pause / speed overlay on the canvas (PlaybackOverlay.tsx): when to flash
 * a speed change and what it says. Kept apart from React so they can be unit tested.
 */

export interface Playback { paused: boolean; speed: number }

/** The fastest speed button (SpeedControls). Anything above it is the night skip. */
export const UI_MAX_SPEED = 4;

/**
 * What the overlay should do when playback goes from `prev` to `next`.
 * - `flash`: show the speed banner for a moment (resumed, or the speed changed while running).
 * - `none`: nothing new. While paused the PAUSED banner already covers everything, so a speed
 *   change made during a pause is not flashed (the game is not running at it yet).
 */
export function playbackChange(prev: Playback, next: Playback): "flash" | "none" {
  // Above the UI's fastest button the sim is fast-forwarding through the night
  // ("Skip to morning" runs at 30x and steps down to 4x when the LLM is busy):
  // its own banner covers that, and a "30x" flash would be noise.
  if (next.speed > UI_MAX_SPEED) return "none";
  if (next.paused) return "none";
  if (prev.paused) return "flash";
  return prev.speed !== next.speed ? "flash" : "none";
}

/** "2x", "0.5x", "1x". */
export function speedText(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) return "1x";
  return `${Number(speed.toFixed(2))}x`;
}

/** How many play arrows to draw: one at or below normal speed, two when fast, three when fastest. */
export function speedArrows(speed: number): 1 | 2 | 3 {
  if (speed >= 4) return 3;
  if (speed > 1) return 2;
  return 1;
}

/** How long the speed banner stays, in ms. */
export const SPEED_FLASH_MS = 1200;
