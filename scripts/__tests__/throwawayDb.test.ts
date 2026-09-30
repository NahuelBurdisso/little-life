import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertNotLiveDb, copyDbWithSidecars } from '../throwawayDb';

/**
 * The guard that keeps a "just format prompts" script off the player's world, and the copy that keeps
 * a WAL-mode template's recent commits. (Importing the module pins DATABASE_PATH only when it is unset;
 * vitest pins it to the test DB, so this file never touches anything real.)
 */

const made: string[] = [];
afterEach(() => { for (const f of made.splice(0)) fs.rmSync(f, { force: true }); });

describe('assertNotLiveDb', () => {
  const root = path.resolve('/repo');

  it('refuses the live world, however it is spelled', () => {
    expect(() => assertNotLiveDb(path.join(root, 'data', 'little-life.db'), root)).toThrow(/live world/);
    expect(() => assertNotLiveDb(path.join(root, 'data', '..', 'data', 'little-life.db'), root)).toThrow(/live world/);
    expect(() => assertNotLiveDb(path.join(root, 'data', 'LITTLE-LIFE.DB'), root)).toThrow(/live world/);
  });

  it('refuses the default relative path when run from the repo root', () => {
    // Resolves against the cwd, like server/db does; the repo root here is the cwd.
    expect(() => assertNotLiveDb('./data/little-life.db', process.cwd())).toThrow(/live world/);
  });

  it('lets a copy, the test DB and a temp file through', () => {
    expect(() => assertNotLiveDb(path.join(root, 'data', 'verify.db'), root)).not.toThrow();
    expect(() => assertNotLiveDb(path.join(root, 'data', 'test.db'), root)).not.toThrow();
    expect(() => assertNotLiveDb(path.join(os.tmpdir(), 'x.db'), root)).not.toThrow();
  });
});

describe('copyDbWithSidecars', () => {
  it('copies the -wal and -shm files that exist, and only those', () => {
    const src = path.join(os.tmpdir(), `throwaway-src-${process.pid}.db`);
    const dest = path.join(os.tmpdir(), `throwaway-dest-${process.pid}.db`);
    made.push(src, src + '-wal', dest, dest + '-wal', dest + '-shm');
    fs.writeFileSync(src, 'main');
    fs.writeFileSync(src + '-wal', 'wal');

    copyDbWithSidecars(src, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('main');
    expect(fs.readFileSync(dest + '-wal', 'utf8')).toBe('wal');
    expect(fs.existsSync(dest + '-shm')).toBe(false);
  });
});
