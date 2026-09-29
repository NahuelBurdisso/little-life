/**
 * Run each idempotent schema startup step on its own, so one failing never
 * skips the next.
 *
 * They used to share a single try in `initSchema`: a swallowed "no such table"
 * from a migrateSchema backfill skipped the one-shot tick → game-minute rebase
 * behind it. New code then went on writing game minutes, and a later start
 * would rebase those already-converted values as if they were ticks.
 *
 * A missing table is expected on a fresh DB (initSchema runs again after
 * migrate.ts creates the tables) and is swallowed. Anything else (a locked DB
 * skipping a backfill, a broken DDL edit) used to vanish and leave rows the app
 * assumes are populated, so the first such error is rethrown — but only after
 * every step has had its turn.
 *
 * Kept out of `server/db/index.ts` so it can be tested without opening the
 * process-wide connection.
 */
export function runStartupSteps(steps: ReadonlyArray<() => void>): void {
  let firstError: unknown = null;
  for (const step of steps) {
    try {
      step();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/no such table/i.test(message) && firstError === null) firstError = err;
    }
  }
  if (firstError !== null) throw firstError;
}
