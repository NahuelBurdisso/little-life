/**
 * Build or upgrade the database at DATABASE_PATH, then close it.
 *
 * Importing `./index` is the whole job: it opens the file, applies the migration
 * chain (schemaMigrations.ts) and runs the data backfills. The game does the same
 * at every start, so this script exists for the callers that need a schema-complete
 * file BEFORE anything else opens it: vitest's global setup, the soak, the tick
 * profiler and the prompt scripts (see scripts/freshDb.ts).
 *
 * The explicit close matters: it checkpoints the WAL, so a plain file copy of the
 * result (server/db/testWorker.ts) has every table in it.
 */
import { sqlite } from './index';

sqlite.close();
console.log('Database schema is up to date.');
