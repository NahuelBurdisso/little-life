import type Database from 'better-sqlite3';
import { gameMinutes } from '../lib/gameClock';

/**
 * `relationship_events.game_minute` — the game-clock stamp story arcs and
 * retention read (see schema.ts for why `timestamp` can't serve).
 *
 * Kept out of `server/db/index.ts`, like clockMigration.ts, so both halves can
 * be exercised on a private in-memory database instead of the shared test file.
 */

/**
 * `gameMinutes(world.time)` in SQL, over the JSON `world_state.time` column.
 * CAST truncates, which for the non-negative clock is the same floor
 * `gameMinutes` applies (the minute is fractional at 0.5x).
 */
const WORLD_GAME_MINUTE_SQL =
  "SELECT CAST(json_extract(time, '$.day') * 1440 + json_extract(time, '$.hour') * 60 " +
  "+ json_extract(time, '$.minute') AS INTEGER) FROM world_state ORDER BY id LIMIT 1";

export const RELATIONSHIP_EVENT_MINUTE_TRIGGER = 'll_relationship_events_game_minute';

/**
 * Stamp every new relationship event with the world's current game minute.
 *
 * A trigger rather than a field at each insert site: events are written from a
 * dozen places across conversations, decisions, states, gifts and
 * confrontations, and the next writer added would silently leave the column
 * NULL. The tick advances `world_state.time` before any phase runs, so a row
 * gets the minute of the tick that produced it.
 *
 * TEMP, like the agent_states write hook in index.ts: local to this connection
 * and never persisted into the file, so other tools opening the DB never meet a
 * trigger they didn't ask for. AFTER INSERT + UPDATE because SQLite can't
 * rewrite NEW in a BEFORE trigger; the `WHEN` leaves an explicit value alone.
 * With no world row the subquery is NULL and the row stays unstamped until the
 * prune pass heals it (relationships.ts).
 *
 * Throws "no such table" on a fresh file before migrations; the caller retries.
 */
export function installRelationshipEventMinuteTrigger(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS ${RELATIONSHIP_EVENT_MINUTE_TRIGGER}
      AFTER INSERT ON main.relationship_events
      WHEN NEW.game_minute IS NULL
    BEGIN
      UPDATE relationship_events SET game_minute = (${WORLD_GAME_MINUTE_SQL}) WHERE id = NEW.id;
    END;
  `);
}

/**
 * Give rows from before the column existed a game minute.
 *
 * The true one is unknowable; the wall-clock age is the only evidence. A row
 * N real seconds old is taken as N × tick_speed game minutes old (one tick per
 * real second, `tick_speed` minutes per tick — the current speed standing in
 * for the unrecorded history, as in the tick → minute rebase). Server-off time
 * inflates that age, so the result is clamped to [0, now]: a session from last
 * week lands on day 0, which only makes its trivial rows eligible for pruning
 * sooner — the pivotal ones are kept regardless of age. Order among rows is
 * preserved, which is what the chronicle's beat ordering needs.
 *
 * Idempotent: a no-op once no NULLs remain.
 */
export function backfillRelationshipEventGameMinutes(
  sqlite: Database.Database,
  nowMs: number = Date.now(),
): number {
  let world: { time: string; tick_speed: number } | undefined;
  try {
    world = sqlite.prepare('SELECT time, tick_speed FROM world_state ORDER BY id LIMIT 1').get() as typeof world;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such table/i.test(message)) throw err;
  }
  if (!world) return 0;
  const hasColumn = (sqlite.prepare('PRAGMA table_info(relationship_events)').all() as { name: string }[])
    .some((c) => c.name === 'game_minute');
  if (!hasColumn) return 0;

  const nowMinutes = gameMinutes(JSON.parse(world.time) as { day: number; hour: number; minute: number });
  const speed = world.tick_speed > 0 ? world.tick_speed : 1;
  return sqlite
    .prepare(
      'UPDATE relationship_events ' +
      'SET game_minute = MAX(0, MIN(?, ? - CAST(MAX(0, ? - timestamp) / 1000.0 * ? AS INTEGER))) ' +
      'WHERE game_minute IS NULL',
    )
    .run(nowMinutes, nowMinutes, nowMs, speed).changes;
}
