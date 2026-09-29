import type Database from 'better-sqlite3';
import { gameMinutes } from '../lib/gameClock';

/**
 * `activity_log.game_minute` — the in-world instant a feed row happened, which
 * the town timeline groups by day (see schema.ts for why `timestamp` can't).
 *
 * New rows are stamped by `logActivity` (it already reads the world clock for
 * `timestamp`); this file only heals the rows written before the column
 * existed. Kept out of `server/db/index.ts`, like relationshipEventClock.ts, so
 * it can be exercised on a private in-memory database.
 */

/**
 * Give rows from before the column existed a game minute.
 *
 * Unlike `relationship_events` (stamped with `Date.now()`, so only the
 * wall-clock age is evidence), an activity row carries `timestamp` = the tick
 * it was logged on, and the world knows the current tick. The row is
 * `currentTick - timestamp` ticks old, and a tick is `tick_speed` game minutes
 * — the CURRENT speed standing in for the unrecorded history, exactly the
 * approximation the tick → minute rebase makes (clockMigration.ts). Server-off
 * time doesn't inflate it, since no ticks pass while the server is down.
 *
 * Clamped to [0, now]: a row stamped past the current tick (a world replaced
 * under an old file) lands on "now" rather than the future, and a very old row
 * at a high speed can't go negative. Order among rows is preserved (the
 * mapping is monotonic in `timestamp`), which is what "days" needs.
 *
 * Idempotent: a no-op once no NULLs remain. Returns the rows healed.
 */
export function backfillActivityLogGameMinutes(sqlite: Database.Database): number {
  let world: { time: string; tick_speed: number } | undefined;
  try {
    world = sqlite.prepare('SELECT time, tick_speed FROM world_state ORDER BY id LIMIT 1').get() as typeof world;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such table/i.test(message)) throw err;
  }
  if (!world) return 0;
  const hasColumn = (sqlite.prepare('PRAGMA table_info(activity_log)').all() as { name: string }[])
    .some((c) => c.name === 'game_minute');
  if (!hasColumn) return 0;

  const time = JSON.parse(world.time) as { day: number; hour: number; minute: number; totalTicks?: number };
  const nowMinutes = gameMinutes(time);
  const nowTick = time.totalTicks ?? 0;
  const speed = world.tick_speed > 0 ? world.tick_speed : 1;
  return sqlite
    .prepare(
      'UPDATE activity_log ' +
      'SET game_minute = MAX(0, MIN(?, ? - CAST(MAX(0, ? - timestamp) * ? AS INTEGER))) ' +
      'WHERE game_minute IS NULL',
    )
    .run(nowMinutes, nowMinutes, nowTick, speed).changes;
}
