import path from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';

/**
 * The one way a database file gets its tables and columns.
 *
 * Until this module there were three, and they disagreed. The Drizzle migration chain
 * stopped at 0001 and lacked seven tables. Tests, the soak and every script built their
 * files with `drizzle-kit push` from schema.ts instead. And the running game added what
 * it needed by hand at boot: 28 `ALTER TABLE ... ADD COLUMN` and four `CREATE TABLE IF
 * NOT EXISTS`. Nothing created the base tables at runtime at all, so a fresh clone
 * (`npm install && npm run dev`, no data/little-life.db) booted into a file with five
 * tables and failed on the first query. It only ever worked on a machine that already
 * had a database.
 *
 * Now: `server/db/migrations/` is generated from schema.ts (`npm run db:generate`), and
 * this function applies it at every start, in the game, in tests and in scripts alike.
 *   - A new file gets 0000_baseline and everything after it.
 *   - A file from before this module (it has tables but no record of the baseline) is
 *     first brought up to the baseline by `upgradeLegacyFile`: the old hand-written
 *     column list, frozen, plus any baseline table or index it lacks. Then the baseline
 *     is recorded as applied, and from there it follows the chain like a new file.
 *
 * To change the schema: edit schema.ts, run `npm run db:generate`, commit the new SQL
 * file. Do not add to LEGACY_COLUMNS; it describes history.
 */

export const MIGRATIONS_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * Columns added by hand at boot between the old chain (0001) and the baseline, in the
 * order they were added: [table, column, type, default]. Frozen. Every one of them is
 * in the baseline's CREATE TABLE, so a new file never needs this list.
 */
const LEGACY_COLUMNS: ReadonlyArray<readonly [string, string, string, string?]> = [
  ['agents', 'years_in_town', 'INTEGER'],
  ['agents', 'job_years', 'INTEGER'],
  ['agents', 'orientation', 'TEXT'],
  ['goals', 'description', 'TEXT'],
  ['goals', 'strategy', 'TEXT'],
  ['goals', 'mapped_interactions', 'TEXT'],
  ['goals', 'pivot_count', 'INTEGER', '0'],
  ['goals', 'source', 'TEXT', "'reactive'"],
  ['goals', 'completed_at', 'INTEGER'],
  ['aspirations', 'description', 'TEXT'],
  ['aspirations', 'shifted_reason', 'TEXT'],
  ['relationships', 'last_interaction_minute', 'INTEGER'],
  ['relationships', 'status_since_minute', 'INTEGER'],
  ['relationship_events', 'game_minute', 'INTEGER'],
  ['activity_log', 'metadata', 'TEXT'],
  ['activity_log', 'game_minute', 'INTEGER'],
  ['conversation_queue', 'deadline_game_min', 'INTEGER'],
  ['template_usage', 'used_game_min', 'INTEGER'],
  ['shared_knowledge', 'is_public', 'INTEGER', '0'],
  ['shared_knowledge', 'revealed_at', 'INTEGER'],
  ['shared_knowledge', 'paid_at', 'INTEGER'],
  ['world_state', 'road_tiles', 'TEXT', "'[]'"],
  ['world_state', 'terrain_tiles', 'TEXT', "'[]'"],
  ['world_state', 'money_target_per_capita', 'REAL'],
  ['world_state', 'treasury_ramp_left', 'INTEGER'],
  ['world_state', 'rule_overrides', 'TEXT'],
  ['world_state', 'world_id', 'TEXT'],
  ['world_state', 'civic', 'TEXT'],
];

/**
 * Tables the old boot code created by hand even in a file with no world in it. If one
 * of them is there and `agents` is not, the file never held a world: they are dropped so
 * the baseline can create them (its CREATE TABLE has no IF NOT EXISTS).
 */
const LEGACY_HANDMADE_TABLES = ['children', 'gazette_issues', 'sim_snapshots', 'app_meta'] as const;

function tableExists(sqlite: Database.Database, name: string): boolean {
  return sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

function lastAppliedMillis(sqlite: Database.Database): number | null {
  if (!tableExists(sqlite, MIGRATIONS_TABLE)) return null;
  const row = sqlite.prepare(`SELECT max(created_at) AS at FROM ${MIGRATIONS_TABLE}`).get() as { at: number | string | null };
  return row.at == null ? null : Number(row.at);
}

/** `CREATE TABLE \`name\`` / `CREATE [UNIQUE] INDEX \`name\`` → what a baseline statement makes. */
function createdObject(stmt: string): { kind: 'table' | 'index'; name: string } | null {
  const m = /^\s*CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\s+[`"]?([A-Za-z0-9_]+)[`"]?/i.exec(stmt);
  if (!m) return null;
  return { kind: /TABLE/i.test(m[1]) ? 'table' : 'index', name: m[2] };
}

/**
 * Bring a pre-baseline file up to the baseline's shape. Every step is additive and
 * idempotent: nothing is dropped or rewritten, so a world is never at risk here.
 */
function upgradeLegacyFile(sqlite: Database.Database, baselineStatements: readonly string[]): void {
  const objects = baselineStatements.map((sql) => ({ sql, made: createdObject(sql) }));

  // Whole tables first: the old chain never had goals, aspirations or the interaction
  // tables, and the four hand-made ones may predate the file's last run.
  for (const { sql, made } of objects) {
    if (made?.kind === 'table' && !tableExists(sqlite, made.name)) sqlite.exec(sql);
  }

  for (const [table, column, type, dflt] of LEGACY_COLUMNS) {
    try {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${dflt ? ` DEFAULT ${dflt}` : ''}`);
    } catch (err) {
      // Already there is the normal case. Anything else (SQLITE_BUSY, a locked file)
      // must not pass silently: the backfills after this would fail on a missing column.
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(message)) throw err;
    }
  }

  // Indexes last, now that every column they name exists.
  for (const { sql, made } of objects) {
    if (made?.kind !== 'index') continue;
    const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(made.name) != null;
    if (!exists) sqlite.exec(sql);
  }
}

export interface MigrationReport {
  /** 'fresh' = no world tables before this call; 'legacy' = upgraded and stamped; 'current' = already on the chain. */
  kind: 'fresh' | 'legacy' | 'current';
}

export function applyMigrations(sqlite: Database.Database, migrationsFolder: string = MIGRATIONS_FOLDER): MigrationReport {
  const migrations = readMigrationFiles({ migrationsFolder });
  const baseline = migrations[0];
  if (!baseline) throw new Error(`No migrations in ${migrationsFolder}: run "npm run db:generate"`);

  const hasWorldTables = tableExists(sqlite, 'agents');
  let kind: MigrationReport['kind'] = 'current';

  const apply = () => {
    if (!hasWorldTables) {
      kind = 'fresh';
      for (const name of LEGACY_HANDMADE_TABLES) sqlite.exec(`DROP TABLE IF EXISTS ${name}`);
      // A record left by the old chain (0000/0001 run against a file whose tables were
      // later lost) would make the baseline look applied.
      sqlite.exec(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}`);
    }
    // Same table and rows drizzle's own migrator writes (sqlite-core/dialect.js), so
    // `drizzle-kit` tooling reads this file's history correctly.
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
    const stamp = sqlite.prepare(`INSERT INTO ${MIGRATIONS_TABLE} ("hash", "created_at") VALUES (?, ?)`);

    let applied = lastAppliedMillis(sqlite);
    if (hasWorldTables && (applied == null || applied < baseline.folderMillis)) {
      // Tables but no record of the baseline (none at all, or only the old chain's).
      kind = 'legacy';
      upgradeLegacyFile(sqlite, baseline.sql);
      stamp.run(baseline.hash, baseline.folderMillis);
      applied = baseline.folderMillis;
    }

    // Whatever the file has not seen: everything for a fresh one, only the migrations
    // after the baseline for the rest. Same rule as drizzle's migrator (newer than the
    // last one recorded).
    for (const migration of migrations) {
      if (applied != null && applied >= migration.folderMillis) continue;
      for (const stmt of migration.sql) sqlite.exec(stmt);
      stamp.run(migration.hash, migration.folderMillis);
    }
  };

  // Not drizzle's `migrate()`: it issues its own BEGIN, and a save load calls this from
  // inside the transaction that swaps the world in (lib/saves.ts), where a second BEGIN
  // is an error. All or nothing either way: alone it gets its own transaction, inside
  // the load it is part of the load's.
  if (sqlite.inTransaction) apply();
  else sqlite.transaction(apply)();
  return { kind };
}
