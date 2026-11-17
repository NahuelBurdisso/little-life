/**
 * Side-effect module: import it FIRST in a script that must never open the live world.
 *
 * The prompt builders read the live rules (`isAdultContent()` -> `server/db`), so a script that only
 * "formats prompts" still opens whatever `DATABASE_PATH` points at, and with nothing set that is
 * `data/little-life.db`: opening it runs the startup migrations and backfills on the player's world.
 * This pins `DATABASE_PATH` to a throwaway copy of the test schema instead (its world_state is empty,
 * so every rule reads its default). An explicit `DATABASE_PATH` from the caller is left alone, except
 * that one naming the live world is refused, like `soak.ts` refuses it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/** The repo root, from this file rather than the cwd: a script run from another directory must not resolve `data/` elsewhere. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Throws when `dbPath` (resolved against the cwd, as `server/db` does) is the live world's database. */
export function assertNotLiveDb(dbPath: string, repoRoot: string = REPO_ROOT): void {
  const live = path.resolve(repoRoot, 'data/little-life.db');
  if (path.resolve(dbPath).toLowerCase() === live.toLowerCase()) {
    throw new Error(
      `Refusing to open ${live} (the live world). Copy it first:\n`
      + '  cp data/little-life.db data/verify.db  and point DATABASE_PATH at the copy',
    );
  }
}

/** Copies a SQLite file and its `-wal` / `-shm` sidecars when present: a WAL-mode template keeps recent commits in `-wal`. */
export function copyDbWithSidecars(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
  for (const sfx of ['-wal', '-shm']) {
    if (fs.existsSync(src + sfx)) fs.copyFileSync(src + sfx, dest + sfx);
  }
}

if (process.env.DATABASE_PATH) {
  assertNotLiveDb(process.env.DATABASE_PATH);
} else {
  const tmp = path.join(os.tmpdir(), `little-life-script-${process.pid}.db`);
  const template = path.resolve(REPO_ROOT, 'data/test.db');
  // A fresh clone has no test DB yet: then the path stays empty and server/db builds
  // the tables from the migration chain when the script imports it.
  if (fs.existsSync(template)) copyDbWithSidecars(template, tmp);
  process.env.DATABASE_PATH = tmp;
  process.on('exit', () => {
    for (const sfx of ['', '-wal', '-shm']) { try { fs.rmSync(tmp + sfx, { force: true }); } catch { /* still open */ } }
  });
}
