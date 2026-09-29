import type Database from 'better-sqlite3';

/**
 * `PRAGMA user_version` once the tick stamps below have been rebased. Nothing
 * else in the project uses user_version (Drizzle tracks its own migrations in a
 * table), so it is free to act as this one-shot data migration's marker.
 */
export const GAME_MINUTE_STAMPS_VERSION = 1;

/**
 * One-shot rebase of the stamps that moved from the TICK clock to the
 * GAME-MINUTE clock (`day*1440 + hour*60 + minute`):
 *
 *   agents.action_started, agent_states.started_at, world_events.started_at
 *
 * Left as ticks, every stamp in an existing world would read as older than it
 * is by the gap between the two clocks — at least the start-day offset, and
 * (speed - 1) minutes more per tick played above 1x. Timed states and events
 * would all end on the first tick, and elapsed-time checks would fire at once:
 * a lonely agent turning depressed, an alcoholic reaching the 7-day death gate.
 *
 * A stamp N ticks ago becomes N * tick_speed game minutes ago. The speed history
 * is not stored, so the current speed stands in for it; the rebase is
 * approximate for a world whose speed changed, exact otherwise.
 */
export function rebaseTickStampsToGameMinutes(sqlite: Database.Database): void {
  const version = sqlite.pragma('user_version', { simple: true }) as number;
  if (version >= GAME_MINUTE_STAMPS_VERSION) return;

  let world: { time: string; tick_speed: number } | undefined;
  try {
    world = sqlite.prepare('SELECT time, tick_speed FROM world_state LIMIT 1').get() as typeof world;
  } catch (err) {
    // Fresh DB before its tables exist: nothing was ever stamped on the old
    // clock, and everything written from here on uses the new one.
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such table/i.test(message)) throw err;
  }

  sqlite.transaction(() => {
    if (world) {
      const time = JSON.parse(world.time) as { day: number; hour: number; minute: number; totalTicks: number };
      const nowMinutes = time.day * 1440 + time.hour * 60 + time.minute;
      const nowTicks = time.totalTicks;
      const speed = world.tick_speed > 0 ? world.tick_speed : 1;
      for (const [table, column] of [
        ['agents', 'action_started'],
        ['agent_states', 'started_at'],
        ['world_events', 'started_at'],
      ] as const) {
        sqlite.prepare(`UPDATE ${table} SET ${column} = ? - (? - ${column}) * ?`).run(nowMinutes, nowTicks, speed);
      }
    }
    sqlite.pragma(`user_version = ${GAME_MINUTE_STAMPS_VERSION}`);
  })();
}
