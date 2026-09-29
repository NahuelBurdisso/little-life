import type Database from 'better-sqlite3';
import { gameMinutes } from '../lib/gameClock';

/**
 * One-shot rebase of the stamp columns that moved from the TICK clock
 * (`world.time.totalTicks`) to the GAME-MINUTE clock (`gameMinutes(world.time)`).
 *
 * Left as ticks, every stamp in an existing world would read as older than it
 * is by the gap between the two clocks — at least the start-day offset, plus
 * (speed - 1) minutes for every tick played above 1x. Timed states and events
 * would all end on the first tick, and elapsed-time checks would fire at once:
 * a lonely agent turning depressed, an alcoholic reaching the 7-day death gate,
 * every goal past its abandonment age.
 *
 * A stamp N ticks ago becomes N × tick_speed game minutes ago. The speed history
 * is not stored, so the current speed stands in for it: exact for a world that
 * always ran at one speed, approximate otherwise. NULLs stay NULL.
 *
 * Progress is recorded in `PRAGMA user_version` (nothing else in the project
 * uses it; Drizzle tracks its migrations in a table). Each step runs at most
 * once per database file, in order.
 */
const STEPS: ReadonlyArray<{ version: number; columns: ReadonlyArray<readonly [table: string, column: string]> }> = [
  {
    version: 1,
    columns: [
      ['agents', 'action_started'],
      ['agent_states', 'started_at'],
      ['world_events', 'started_at'],
    ],
  },
  {
    version: 2,
    columns: [
      ['goals', 'created_at'],
      ['goals', 'completed_at'],
      ['aspirations', 'adopted_at'],
      ['aspirations', 'shifted_at'],
    ],
  },
];

export const GAME_MINUTE_STAMPS_VERSION = STEPS[STEPS.length - 1].version;

/**
 * The speed the rebase multiplies tick ages by: the current `tick_speed`, but
 * never more than `nowMinutes / nowTicks`.
 *
 * The current speed is only a guess at the speed history. `nowMinutes /
 * nowTicks` is an upper bound on the true average — the clock started at
 * minute >= 0, so the ticks played cover at most `nowMinutes` of game time.
 * A world that ran at 1x for a week and was switched to 4x just before the
 * upgrade would, with the raw speed, push its oldest stamps four times further
 * back than the world has existed: negative minutes, i.e. every such state and
 * goal instantly "ancient". Capped, a tick-0 stamp maps to minute >= 0.
 */
export function rebaseSpeed(tickSpeed: number, nowMinutes: number, nowTicks: number): number {
  const speed = tickSpeed > 0 ? tickSpeed : 1;
  return nowTicks > 0 ? Math.min(speed, nowMinutes / nowTicks) : speed;
}

function userVersion(sqlite: Database.Database): number {
  return sqlite.pragma('user_version', { simple: true }) as number;
}

/**
 * Run whatever steps this database hasn't had yet. Idempotent and safe to call
 * on every startup: the version is re-read inside an IMMEDIATE transaction, so
 * two processes opening the same file (the dev server and scripts/diagnose.ts
 * both import server/db) can't both apply a step. Everything — every UPDATE and
 * the version bump — commits together or not at all.
 *
 * A database with no world row (or no world_state table yet) has no old stamps,
 * so it is just marked current; so is a stamp table that doesn't exist.
 */
export function rebaseTickStampsToGameMinutes(sqlite: Database.Database): void {
  if (userVersion(sqlite) >= GAME_MINUTE_STAMPS_VERSION) return;

  sqlite.transaction(() => {
    const from = userVersion(sqlite);
    if (from >= GAME_MINUTE_STAMPS_VERSION) return; // another connection got here first
    const pending = STEPS.filter((s) => s.version > from);

    let world: { time: string; tick_speed: number } | undefined;
    try {
      world = sqlite.prepare('SELECT time, tick_speed FROM world_state LIMIT 1').get() as typeof world;
    } catch (err) {
      // Fresh file before its tables exist: nothing was ever stamped on the old clock.
      const message = err instanceof Error ? err.message : String(err);
      if (!/no such table/i.test(message)) throw err;
    }

    if (world) {
      const time = JSON.parse(world.time) as { day: number; hour: number; minute: number; totalTicks: number };
      const nowMinutes = gameMinutes(time);
      const nowTicks = time.totalTicks;
      const speed = rebaseSpeed(world.tick_speed, nowMinutes, nowTicks);
      const changed: string[] = [];
      for (const step of pending) {
        for (const [table, column] of step.columns) {
          // A table or column this file doesn't have holds no old stamps. Skip it
          // rather than fail: failing would roll back and retry on every start
          // while new code kept writing game minutes elsewhere, and a later retry
          // would then rebase stamps that were already converted.
          const hasColumn = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
            .some((c) => c.name === column);
          if (!hasColumn) {
            changed.push(`${table}.${column}: absent`);
            continue;
          }
          // CAST keeps the result INTEGER at fractional speeds (0.5x). The
          // clamp to [0, now] is the backstop for inputs the formula can't
          // vouch for — a stamp already in minutes (say user_version was lost
          // with a restored file) would otherwise land far in the future, and
          // nothing legitimate is stamped after "now" or before day 0.
          const { changes } = sqlite
            .prepare(
              `UPDATE ${table} SET ${column} = MAX(0, MIN(?, CAST(? - (? - ${column}) * ? AS INTEGER))) ` +
              `WHERE ${column} IS NOT NULL`,
            )
            .run(nowMinutes, nowMinutes, nowTicks, speed);
          changed.push(`${table}.${column}: ${changes}`);
        }
      }
      console.log(
        `[db] Rebased tick stamps onto the game-minute clock (user_version ${from} -> ${GAME_MINUTE_STAMPS_VERSION}; ` +
        `now = tick ${nowTicks} = game minute ${nowMinutes}, tick_speed ${speed}). Rows: ${changed.join(', ')}`,
      );
    }
    sqlite.pragma(`user_version = ${GAME_MINUTE_STAMPS_VERSION}`);
  }).immediate();
}

/**
 * Game-minute "started at" stamps that are checked against now on every start.
 * A value after now makes `now - started` negative, so an action never ends, a
 * state or event never expires and a goal never ages.
 */
const FUTURE_CHECKED_STAMPS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['agents', 'action_started'],
  ['agent_states', 'started_at'],
  ['world_events', 'started_at'],
  ['goals', 'created_at'],
];

/**
 * Startup self-heal: pull any of those stamps that lies after the world's
 * current game minute back to now.
 *
 * Independent of `user_version` on purpose. The one-shot rebase trusts that
 * version to say which clock the columns are on; if the trust is ever
 * misplaced (a file restored without its header, an old branch run against a
 * migrated file, a rebase applied to values that were already minutes), stamps
 * end up in the future and stay there — the rebase never runs again. Nothing
 * legitimate writes a future stamp, so clamping is always safe, and on a
 * healthy database it is four small UPDATEs that change nothing.
 *
 * Logs once, with per-column counts, only when it changed something.
 */
export function clampFutureGameMinuteStamps(sqlite: Database.Database): void {
  let world: { time: string } | undefined;
  try {
    world = sqlite.prepare('SELECT time FROM world_state LIMIT 1').get() as typeof world;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such table/i.test(message)) throw err;
  }
  if (!world) return;
  const nowMinutes = gameMinutes(JSON.parse(world.time) as { day: number; hour: number; minute: number });

  const changed: string[] = [];
  sqlite.transaction(() => {
    for (const [table, column] of FUTURE_CHECKED_STAMPS) {
      const hasColumn = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .some((c) => c.name === column);
      if (!hasColumn) continue;
      const { changes } = sqlite
        .prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} > ?`)
        .run(nowMinutes, nowMinutes);
      if (changes > 0) changed.push(`${table}.${column}: ${changes}`);
    }
  }).immediate();

  if (changed.length > 0) {
    console.log(
      `[db] Clamped future game-minute stamps to now (game minute ${nowMinutes}). Rows: ${changed.join(', ')}`,
    );
  }
}
