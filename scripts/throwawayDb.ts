/**
 * Side-effect module: import it FIRST in a script that must never open the live world.
 *
 * The prompt builders read the live rules (`isAdultContent()` -> `server/db`), so a script that only
 * "formats prompts" still opens whatever `DATABASE_PATH` points at, and with nothing set that is
 * `data/little-life.db`: opening it runs the startup migrations and backfills on the player's world.
 * This pins `DATABASE_PATH` to a throwaway copy of the test schema instead (its world_state is empty,
 * so every rule reads its default). An explicit `DATABASE_PATH` from the caller is left alone.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

if (!process.env.DATABASE_PATH) {
  const tmp = path.join(os.tmpdir(), `little-life-script-${process.pid}.db`);
  const template = path.resolve('data/test.db');
  if (fs.existsSync(template)) {
    fs.copyFileSync(template, tmp);
  } else {
    // A fresh clone has no test DB yet: derive the tables from schema.ts, like the soak and the tests do.
    execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
      env: { ...process.env, DATABASE_PATH: tmp }, stdio: 'pipe', shell: process.platform === 'win32',
    });
  }
  process.env.DATABASE_PATH = tmp;
  process.on('exit', () => {
    for (const sfx of ['', '-wal', '-shm']) { try { fs.rmSync(tmp + sfx, { force: true }); } catch { /* still open */ } }
  });
}
