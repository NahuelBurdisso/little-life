import 'dotenv/config';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DATABASE_PATH || './data/little-life.db';
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const sqlite = new Database(dbPath);
// busy_timeout goes first, or it cannot protect the pragma that needs it most:
// `journal_mode = WAL` takes a brief exclusive lock, and with the timeout still
// at its 0 default that lock throws instead of waiting whenever another
// connection is mid-checkpoint.
sqlite.pragma('busy_timeout = 3000');
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('cache_size = -20000');
sqlite.pragma('temp_store = MEMORY');
sqlite.pragma('mmap_size = 30000000');

// Performance indexes not covered by Drizzle schema.
// Each statement gets its own try/catch: one shared catch meant a single missing
// table (e.g. `shared_knowledge`, which only arrives in migration 0001) skipped
// every index after it.
const PERF_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_memories_agent_created ON memories (agent_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_conversations_status_ended ON conversations (status, ended_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_shared_knowledge_type_active ON shared_knowledge (type, is_active)',
  // `relationship_events` only carries an index on `processed`, but it is also
  // range-scanned on `timestamp` — by the heartbroken check in states.ts, once
  // per agent per tick, on a table that is only ever appended to. The window is
  // narrow (60 ticks), so the range index alone reduces a growing full scan to a
  // handful of rows; chronicle and the autoplay collectors ride it too.
  'CREATE INDEX IF NOT EXISTS idx_relationship_events_timestamp ON relationship_events (timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_conversations_started_at ON conversations (started_at)',
];

function createPerfIndexes() {
  for (const stmt of PERF_INDEXES) {
    try {
      sqlite.exec(stmt);
    } catch {
      // Table doesn't exist yet — retried on the next initSchema() call
    }
  }
}

// ─── Schema migrations (additive columns) ─────────────────────────────────
function migrateSchema() {
  const addColumnIfMissing = (table: string, column: string, type: string, dflt?: string) => {
    try {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${dflt ? ` DEFAULT ${dflt}` : ''}`);
    } catch (err) {
      // Only two outcomes are expected: the column is already there, or the
      // table itself does not exist yet on a fresh DB (retried by the
      // initSchema() call at the end of migrate.ts). A blanket catch also hid
      // SQLITE_BUSY, which silently skipped the column add and then surfaced as
      // an unrelated failure on the backfill below.
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(message) && !/no such table/i.test(message)) throw err;
    }
  };

  // Goals table extensions
  addColumnIfMissing('goals', 'description', 'TEXT');
  addColumnIfMissing('goals', 'strategy', 'TEXT');
  addColumnIfMissing('goals', 'mapped_interactions', 'TEXT');
  addColumnIfMissing('goals', 'pivot_count', 'INTEGER', '0');
  addColumnIfMissing('goals', 'source', 'TEXT', "'reactive'");
  addColumnIfMissing('goals', 'completed_at', 'INTEGER');

  // Aspirations table extensions
  addColumnIfMissing('aspirations', 'description', 'TEXT');
  addColumnIfMissing('aspirations', 'shifted_reason', 'TEXT');

  // Activity log extensions
  addColumnIfMissing('activity_log', 'metadata', 'TEXT');

  // Shared knowledge extensions
  addColumnIfMissing('shared_knowledge', 'is_public', 'INTEGER', '0');
  addColumnIfMissing('shared_knowledge', 'revealed_at', 'INTEGER');

  // World state extensions
  addColumnIfMissing('world_state', 'road_tiles', 'TEXT', "'[]'");
  addColumnIfMissing('world_state', 'terrain_tiles', 'TEXT', "'[]'");

  // Backfills. Each runs independently — sharing one catch meant a failure on
  // the goals backfill skipped the aspirations one entirely. The first real
  // error is still rethrown, after every statement has had its turn.
  const BACKFILLS = [
    `UPDATE goals SET description = type WHERE description IS NULL`,
    `UPDATE aspirations SET description = type WHERE description IS NULL`,
    // Retroactive half of the fix in MemoryStore.deactivate, which now clears the
    // embedding as it soft-deletes. Every read path filters on `is_active = 1`, so
    // a vector on an inactive row can never be retrieved — but it is 4 KB, and
    // consolidation deactivates far more rows than it keeps. On an existing
    // database these accounted for well over half the file. Self-limiting: after
    // the first run the predicate matches nothing.
    `UPDATE memories SET embedding = NULL WHERE is_active = 0 AND embedding IS NOT NULL`,
  ];

  let firstError: unknown = null;
  for (const stmt of BACKFILLS) {
    try {
      sqlite.exec(stmt);
    } catch (err) {
      if (firstError === null) firstError = err;
    }
  }
  if (firstError !== null) throw firstError;
}

/**
 * Create the perf indexes and apply additive column migrations.
 *
 * Safe to call more than once (every statement is idempotent), so it can be
 * re-run after tables are created on a fresh database.
 */
export function initSchema(): void {
  createPerfIndexes();
  try {
    migrateSchema();
  } catch (err) {
    // A missing table on a fresh DB is expected; anything else (a locked DB
    // skipping the aspirations/goals backfill, say) used to vanish here and
    // leave `description IS NULL` rows the app assumes are populated.
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such table/i.test(message)) throw err;
  }
}

initSchema();

export const db = drizzle(sqlite, { schema });
export { sqlite };
