import fs from 'fs';
import { execFileSync } from 'child_process';

/**
 * Vitest global setup: build a throwaway database for the suite.
 *
 * Several tests clear every table, so they must never run against the path in
 * .env — that is the live simulation's world. Start from a deleted file so a
 * run can't inherit rows from the previous one.
 *
 * Tables come from the migration chain, through the same code the game runs at
 * boot (`server/db/migrate.ts` just opens the file and closes it). It used to be
 * `drizzle-kit push`, because the chain was stale; that meant the suite tested a
 * schema the running game never built (see schemaMigrations.ts).
 *
 * A child process, not an import: this is vitest's main process, and a connection
 * left open here would hold the template while the workers copy it.
 */
const TEST_DB = './data/test.db';

export async function setup() {
  process.env.DATABASE_PATH = TEST_DB;
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TEST_DB + suffix, { force: true });
  }
  // Per-worker copies from the previous run, or they'd carry its rows forward.
  // `server/db/testWorker.ts` only copies the template when the copy is absent.
  for (const f of fs.readdirSync('./data')) {
    if (f.startsWith('test-worker-')) fs.rmSync(`./data/${f}`, { force: true });
  }
  try {
    execFileSync('npx', ['tsx', 'server/db/migrate.ts'], {
      env: { ...process.env, DATABASE_PATH: TEST_DB },
      // 'pipe', not 'ignore': a failed push used to surface as hundreds of
      // "no such table" test failures with the actual cause discarded.
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const output = [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join('\n');
    if (output) console.error(`[testSetup] building the test database failed:\n${output}`);
    throw err;
  }
}
