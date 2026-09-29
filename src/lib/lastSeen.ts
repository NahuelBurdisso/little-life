/**
 * The last game minute the player saw of a world, per world, so coming back
 * after a while can open with "Previously on…" (RecapCard, server/lib/recap.ts).
 *
 * Kept in localStorage under the world's seed key (firstRun.ts `worldSeedKey`):
 * there is no world id, and the seeds are what tell one town from another.
 * Written while the tab is visible (useRecap), so a tab left in the background
 * while the town runs on counts as time away.
 */

import { browserStore, type KeyValueStore } from './firstRun';

/** Six game hours: less than that is a coffee break, not a story to catch up on. */
export const RECAP_GAP_MINUTES = 6 * 60;

export function lastSeenKey(worldKey: string): string {
  return `little-life.lastSeen.${worldKey}`;
}

export function readLastSeen(worldKey: string, store: KeyValueStore | null = browserStore()): number | null {
  try {
    const raw = store?.getItem(lastSeenKey(worldKey));
    if (raw == null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

export function writeLastSeen(worldKey: string, minute: number, store: KeyValueStore | null = browserStore()): void {
  if (!Number.isFinite(minute) || minute < 0) return;
  try {
    store?.setItem(lastSeenKey(worldKey), String(Math.floor(minute)));
  } catch {
    // Quota or blocked storage: no recap next time, which beats crashing.
  }
}

/**
 * The minute a recap should start from, or null for none.
 *
 * None when this world was never seen here (a brand-new world: the first-run
 * guide has that moment), when the gap is short, and when the clock is BEHIND
 * the mark: Restart replays the same seeds from day 0, and that town has no
 * past to recap.
 */
export function recapSince(lastSeen: number | null, nowMinute: number, gap = RECAP_GAP_MINUTES): number | null {
  if (lastSeen == null || !Number.isFinite(nowMinute)) return null;
  if (nowMinute < lastSeen) return null;
  return nowMinute - lastSeen >= gap ? lastSeen : null;
}

/** The slice of `world.getNightSkip` the overnight recap watches. */
export interface SkipStatusLike {
  active: boolean;
  startMinute: number | null;
  lastStop: { reason: string } | null;
}

/**
 * One step of watching the night skip: while one runs, remember the minute it
 * started; when it stops, hand back that minute as the start of an
 * "Overnight…" recap — once, and only for a skip this tab saw running (a page
 * loaded after it ended gets the arrival recap instead). A skip ended by a
 * world replace recaps nothing: that town is gone.
 */
export function skipRecapStep(
  watchedStart: number | null,
  status: SkipStatusLike,
): { watchedStart: number | null; recapSince: number | null } {
  if (status.active) return { watchedStart: status.startMinute ?? watchedStart, recapSince: null };
  if (watchedStart == null || status.lastStop?.reason === 'world_replaced') {
    return { watchedStart: null, recapSince: null };
  }
  return { watchedStart: null, recapSince: watchedStart };
}

/** "9 hours", "1 day", "2 days, 3 hours" of town time between two game minutes. */
export function describeSpan(sinceMinute: number, untilMinute: number): string {
  const total = Math.max(0, Math.round((untilMinute - sinceMinute) / 60));
  const days = Math.floor(total / 24);
  const hours = total % 24;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (days === 0) return part(hours, 'hour');
  return hours === 0 ? part(days, 'day') : `${part(days, 'day')}, ${part(hours, 'hour')}`;
}
