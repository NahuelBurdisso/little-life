import fs from 'fs';

/**
 * Vitest per-worker setup: point this worker at its own copy of the database.
 *
 * `globalSetup` builds one schema-complete template. Every test file used to
 * open that same file, and vitest runs files in parallel, so ~40 connections
 * hit one WAL database at once — which on Windows surfaces as
 * `SqliteError: disk I/O error` from the `journal_mode = WAL` pragma in
 * `server/db/index.ts`, failing a different file on each run. Tests that clear
 * every table (`setup.initialize`) also raced whatever else was mid-query.
 *
 * Copying per worker removes the concurrency entirely: files sharing a worker
 * run one after another, and files in different workers no longer share a file.
 *
 * This must run before any test module imports `server/db`, which reads
 * DATABASE_PATH once at import time — that is exactly what `setupFiles` guarantees.
 */
const TEMPLATE = './data/test.db';
const workerDb = `./data/test-worker-${process.env.VITEST_WORKER_ID ?? '0'}.db`;

// Workers are reused across files, so only the first file in a worker copies.
// Later files inherit the previous file's rows, which matches the old shared-file
// behaviour that the existing tests were written against.
if (!fs.existsSync(workerDb)) fs.copyFileSync(TEMPLATE, workerDb);
process.env.DATABASE_PATH = workerDb;
