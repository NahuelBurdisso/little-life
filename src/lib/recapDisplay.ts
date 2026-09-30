/**
 * When the "Previously on…" / "Overnight…" recap card shows, next to the
 * Director.
 *
 * Why (playtest #3): the card stayed until dismissed and sat over the
 * Director's caption bar (both bottom of the map). With the Director on the
 * player is watching, not reading, so the card goes away on its own after
 * AUTO_DISMISS_MS; and while a caption is on screen the card steps aside
 * (hidden, not dismissed — it comes back when the caption ends, if its time
 * isn't up). With the Director off nothing changes: the card waits for ×/Esc.
 */
export const RECAP_AUTO_DISMISS_MS = 20_000;

/** Milliseconds until the card dismisses itself, or null to wait for the player. */
export function recapAutoDismissMs(directorOn: boolean): number | null {
  return directorOn ? RECAP_AUTO_DISMISS_MS : null;
}

/** Whether the card may be on screen right now. */
export function recapVisible(p: { directorOn: boolean; captionShown: boolean }): boolean {
  return !(p.directorOn && p.captionShown);
}
