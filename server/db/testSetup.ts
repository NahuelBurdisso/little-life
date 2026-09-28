import fs from 'fs';
import { execFileSync } from 'child_process';

/**
 * Vitest global setup: build a throwaway database for the suite.
 *
 * Several tests clear every table, so they must never run against the path in
 * .env — that is the live simulation's world. Start from a deleted file so a
 * run can't inherit rows from the previous one.
 *
 * Tables come from `drizzle-kit push` rather than the migration chain: the
 * chain is missing the tables added after 0001 (goals, aspirations,
 * interactions, interaction_participants, interaction_cooldowns), so replaying
 * it yields a database the app can't actually use. Pushing derives the schema
 * from schema.ts, which is what the code queries.
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
    execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
      env: { ...process.env, DATABASE_PATH: TEST_DB },
      // 'pipe', not 'ignore': a failed push used to surface as hundreds of
      // "no such table" test failures with the actual cause discarded.
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    const output = [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join('\n');
    if (output) console.error(`[testSetup] drizzle-kit push failed:\n${output}`);
    throw err;
  }
}
