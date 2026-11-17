import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { applyMigrations } from '../schemaMigrations';

/**
 * The migration chain is the only thing that builds a database (schemaMigrations.ts).
 * These run on their own temp files, never on the worker's copy: they drop tables.
 */

const opened: Array<{ sqlite: Database.Database; file: string }> = [];

function open(): { sqlite: Database.Database; run: () => ReturnType<typeof applyMigrations> } {
  const file = path.join(os.tmpdir(), `little-life-migrations-${process.pid}-${opened.length}-${Date.now()}.db`);
  const sqlite = new Database(file);
  sqlite.pragma('foreign_keys = ON');
  opened.push({ sqlite, file });
  return { sqlite, run: () => applyMigrations(sqlite) };
}

afterEach(() => {
  for (const { sqlite, file } of opened.splice(0)) {
    sqlite.close();
    for (const sfx of ['', '-wal', '-shm']) fs.rmSync(file + sfx, { force: true });
  }
});

const tables = (Object.values(schema) as unknown[]).filter((t): t is SQLiteTable => is(t, SQLiteTable));
const columnsOf = (sqlite: Database.Database, table: string) =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const stamps = (sqlite: Database.Database) =>
  (sqlite.prepare('SELECT count(*) AS c FROM __drizzle_migrations').get() as { c: number }).c;

describe('applyMigrations', () => {
  it('builds every table and column of schema.ts in an empty file', () => {
    // The guard for "edited schema.ts, forgot `npm run db:generate`": the tests run on
    // a database built by this chain, so a column missing here is missing everywhere.
    const { sqlite, run } = open();
    expect(run().kind).toBe('fresh');
    expect(tables.length).toBeGreaterThan(20);
    for (const table of tables) {
      const cfg = getTableConfig(table);
      const actual = columnsOf(sqlite, cfg.name);
      expect(actual, `table ${cfg.name}`).toEqual(expect.arrayContaining(cfg.columns.map((c) => c.name)));
    }
  });

  it('is a no-op the second time', () => {
    const { sqlite, run } = open();
    run();
    const before = stamps(sqlite);
    expect(run().kind).toBe('current');
    expect(stamps(sqlite)).toBe(before);
  });

  it('upgrades a file from before the chain without touching its rows', () => {
    const { sqlite, run } = open();
    run();
    // Make it look like an old world: no record of the baseline, a column the old boot
    // code used to add by hand missing, a table the old chain never had missing, and
    // only the stale chain's stamp in the migrations table.
    sqlite.exec('DROP TABLE __drizzle_migrations');
    sqlite.exec('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('old-chain', 1774489179408);
    sqlite.exec('ALTER TABLE world_state DROP COLUMN civic');
    sqlite.exec('DROP INDEX IF EXISTS idx_children_mother');
    sqlite.exec('DROP INDEX IF EXISTS idx_children_father');
    sqlite.exec('DROP TABLE children');
    sqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('embedding_model', 'kept')").run();

    expect(run().kind).toBe('legacy');

    expect(columnsOf(sqlite, 'world_state')).toContain('civic');
    expect(columnsOf(sqlite, 'children')).toContain('mother_id');
    const indexes = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'children'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_children_mother', 'idx_children_father']));
    expect(sqlite.prepare("SELECT value FROM app_meta WHERE key = 'embedding_model'").get()).toEqual({ value: 'kept' });
    expect(stamps(sqlite)).toBe(2);
    expect(run().kind).toBe('current');
  });

  it('replaces the hand-made tables of a file that never held a world', () => {
    // What the old boot code left behind on a fresh clone: its four CREATE TABLE IF
    // NOT EXISTS and nothing else. The baseline could not create over them.
    const { sqlite, run } = open();
    sqlite.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sqlite.exec('CREATE TABLE gazette_issues (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL)');
    expect(run().kind).toBe('fresh');
    expect(columnsOf(sqlite, 'gazette_issues')).toContain('headline');
    expect(columnsOf(sqlite, 'agents')).toContain('name');
  });
});
