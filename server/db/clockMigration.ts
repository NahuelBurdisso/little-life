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
      const speed = world.tick_speed > 0 ? world.tick_speed : 1;
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
          // CAST keeps the result INTEGER at fractional speeds (0.5x).
          const { changes } = sqlite
            .prepare(`UPDATE ${table} SET ${column} = CAST(? - (? - ${column}) * ? AS INTEGER) WHERE ${column} IS NOT NULL`)
            .run(nowMinutes, nowTicks, speed);
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
