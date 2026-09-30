/** Seconds a curtain takes to close (or to open again): about a second, as a hand draws it. */
export const CURTAIN_SECONDS = 1;

/** Each of the two panels covers this many px of the 8 px pane when fully drawn. */
export const PANEL_MAX_PX = 4;

/** One frame of drawing (`want` true) or opening the curtain: progress 0 = open, 1 = drawn. */
export function stepCurtain(progress: number, want: boolean, seconds: number): number {
  const step = seconds / CURTAIN_SECONDS;
  return want ? Math.min(1, progress + step) : Math.max(0, progress - step);
}

/** Width in whole px of one panel at this progress (pixel art snaps to the grid). */
export function panelPx(progress: number): number {
  return Math.round(Math.max(0, Math.min(1, progress)) * PANEL_MAX_PX);
}
