/**
 * Module-level state of the decision phase, kept across ticks. One instance for
 * the whole server: the schedule and the social queue write it, and
 * ../decisions.ts re-exports the `clear*` functions server/engine/worldCaches.ts
 * calls on a world replace.
 */

// Tracks consecutive work skips per agent to detect work_issue pattern
export const workSkipCount = new Map<number, number>();

/** Drop per-agent work-skip counters for a world replace (agent ids are reused). */
export function clearWorkSkipCounts(): void {
  workSkipCount.clear();
}

/**
 * Game minutes before the same couple's date is announced again: one evening.
 * The date is announced when a romantic evening chat is queued, and a queued
 * chat can be dropped (the pair drifted apart, the wait ran out) and queued
 * again on the next tick; without the window the feed repeated "X and Y are
 * on a date" every tick until one finally started (G9).
 */
export const DATE_ANNOUNCE_REPEAT_MINUTES = 360;

/** pairKey → game minute the pair's date was last announced. */
const lastDateAnnounced = new Map<string, number>();

/** Whether to announce this couple's date now (and remember it if so). */
export function shouldAnnounceDate(a: number, b: number, nowMinutes: number): boolean {
  const key = pairKey(a, b);
  const last = lastDateAnnounced.get(key);
  // A negative gap is a replaced world whose clock restarted: announce.
  if (last != null && nowMinutes - last >= 0 && nowMinutes - last < DATE_ANNOUNCE_REPEAT_MINUTES) return false;
  lastDateAnnounced.set(key, nowMinutes);
  return true;
}

/** Drop date announcement stamps for a world replace (ids and the clock restart). */
export function clearDateAnnouncements(): void {
  lastDateAnnounced.clear();
}

/** Order-independent key for an agent pair. */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
