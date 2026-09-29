import 'dotenv/config';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import {
  backfillRelationshipInteractionMinutes,
  clampFutureGameMinuteStamps,
  rebaseTickStampsToGameMinutes,
} from './clockMigration';
import {
  backfillRelationshipEventGameMinutes,
  installRelationshipEventMinuteTrigger,
} from './relationshipEventClock';
import { runStartupSteps } from './startupSteps';
import { raiseWagesToFloor } from './wageFloorMigration';
import { CONFIG } from '../lib/constants';
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
  // handful of rows; the autoplay collectors ride it too.
  'CREATE INDEX IF NOT EXISTS idx_relationship_events_timestamp ON relationship_events (timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_conversations_started_at ON conversations (started_at)',
  // Game-day retention (relationships.ts pruneRelationshipEvents) range-scans
  // this; the chronicle orders every pair's beats by it.
  'CREATE INDEX IF NOT EXISTS idx_relationship_events_game_minute ON relationship_events (game_minute)',
];

function createPerfIndexes() {
  for (const stmt of PERF_INDEXES) {
    try {
      sqlite.exec(stmt);
    } catch {
      // Table (or, on an old file, column) doesn't exist yet — retried at the
      // end of initSchema() and on the next initSchema() call
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

  // The Town Crier (server/lib/gazette.ts). A whole table, not a column: the
  // migration chain is stale, so new tables are created here too.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS gazette_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day INTEGER NOT NULL,
    season TEXT NOT NULL,
    headline TEXT NOT NULL,
    articles TEXT NOT NULL,
    gossip TEXT,
    covers_to_tick INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  // Small key/value store for facts about the DB itself (which embedding model
  // made the stored vectors — see lib/memory/embeddingBackfill.ts).
  sqlite.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  // Checkpoints of in-memory sim state (server/engine/simSnapshots.ts). The rows
  // belong to one world, so the table is in both ALL_TABLES lists and a world
  // replace wipes it together with everything else.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS sim_snapshots (
    key TEXT PRIMARY KEY NOT NULL,
    world_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    game_minute INTEGER NOT NULL,
    data TEXT NOT NULL,
    saved_at INTEGER NOT NULL
  )`);

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

  // Relationship decay clock (game minutes; see schema.ts)
  addColumnIfMissing('relationships', 'last_interaction_minute', 'INTEGER');
  // When the pair reached its current status (game minutes; see schema.ts).
  // Old rows stay NULL: lib/milestonesEngine.ts starts their clock when it
  // first meets them rather than guessing how long a couple has been together.
  addColumnIfMissing('relationships', 'status_since_minute', 'INTEGER');

  // Story-arc / retention clock (game minutes; see schema.ts). Filled by a TEMP
  // trigger on insert, old rows by backfillRelationshipEventGameMinutes.
  addColumnIfMissing('relationship_events', 'game_minute', 'INTEGER');

  // Activity log extensions
  addColumnIfMissing('activity_log', 'metadata', 'TEXT');

  // Conversation pacing on the game clock (see schema.ts)
  addColumnIfMissing('conversation_queue', 'deadline_game_min', 'INTEGER');
  addColumnIfMissing('template_usage', 'used_game_min', 'INTEGER');

  // Shared knowledge extensions
  addColumnIfMissing('shared_knowledge', 'is_public', 'INTEGER', '0');
  addColumnIfMissing('shared_knowledge', 'revealed_at', 'INTEGER');

  // World state extensions
  addColumnIfMissing('world_state', 'road_tiles', 'TEXT', "'[]'");
  addColumnIfMissing('world_state', 'terrain_tiles', 'TEXT', "'[]'");
  addColumnIfMissing('world_state', 'money_target_per_capita', 'REAL');
  // Live rule overrides (Storyteller / world.setRules), see lib/worldRules.ts.
  addColumnIfMissing('world_state', 'rule_overrides', 'TEXT');

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

// ─── agent_states write counter ───────────────────────────────────────────
// `lib/states.ts` keeps a per-tick snapshot of every agent's state types so the
// dozens of getAgentStates() calls per phase don't each hit the DB. That snapshot
// is only correct if it notices writes — and agent_states is written from ~45
// call sites across a dozen modules (states, conversations, decisions, gossip,
// cascade, tavern, gifts, loneliness, life events...). Routing all of them
// through one helper would be a wide refactor that the next new writer silently
// escapes, so instead the connection itself counts writes: TEMP triggers (local
// to this connection, never persisted into the DB file, so other tools opening
// it never see a trigger calling a function they lack) bump a JS counter on
// every insert/delete, and on updates that change which agent/type a row is.
// Readers compare the counter to the value they cached at and rebuild on change.
//
// What the counter can NOT see is a ROLLBACK: no trigger fires when a
// transaction is undone. If a phase writes a state, a reader rebuilds from that
// uncommitted row, and the phase then throws, the snapshot keeps a state that no
// longer exists. Whoever catches a rolled-back transaction must therefore call
// `invalidateAgentStatesCache()` (lib/states.ts) — the tick's phase runner does.
let agentStatesWriteVersion = 0;
sqlite.function('ll_agent_states_written', { deterministic: false }, () => {
  agentStatesWriteVersion++;
  return null;
});

const AGENT_STATES_TRIGGERS = ['ll_agent_states_ai', 'll_agent_states_ad', 'll_agent_states_au'];

let agentStatesHookInstalled = false;
function installAgentStatesWriteHook(): boolean {
  if (agentStatesHookInstalled) return true;
  try {
    sqlite.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS ll_agent_states_ai AFTER INSERT ON main.agent_states
        BEGIN SELECT ll_agent_states_written(); END;
      CREATE TEMP TRIGGER IF NOT EXISTS ll_agent_states_ad AFTER DELETE ON main.agent_states
        BEGIN SELECT ll_agent_states_written(); END;
      CREATE TEMP TRIGGER IF NOT EXISTS ll_agent_states_au AFTER UPDATE OF agent_id, type ON main.agent_states
        BEGIN SELECT ll_agent_states_written(); END;
    `);
    agentStatesHookInstalled = true;
  } catch (err) {
    // Only a missing table is expected (fresh DB, before migrations) — retried by
    // initSchema() and lazily by the next getAgentStatesWriteVersion() call.
    // Anything else (SQLITE_BUSY, a broken DDL edit) would otherwise leave the
    // state cache silently uncached forever, so it surfaces instead.
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such table/i.test(message)) throw err;
  }
  return agentStatesHookInstalled;
}

/**
 * Re-check that the write triggers still exist and reinstall them if not.
 *
 * TEMP triggers die with their table: anything that drops and recreates
 * `agent_states` on this connection (a migration, a test harness, a future
 * schema reset) would silently disconnect the counter while
 * `agentStatesHookInstalled` still claims it is live. One lookup in
 * `sqlite_temp_master`, run once per tick from `cacheAllAgentStates()`, bounds
 * that blind spot to a single tick. A reinstall also bumps the counter, since
 * writes may have gone unseen while the triggers were missing.
 */
export function verifyAgentStatesWriteHook(): void {
  const placeholders = AGENT_STATES_TRIGGERS.map(() => '?').join(', ');
  const present = sqlite
    .prepare(`SELECT count(*) AS n FROM sqlite_temp_master WHERE type = 'trigger' AND name IN (${placeholders})`)
    .get(...AGENT_STATES_TRIGGERS) as { n: number };
  if (present.n === AGENT_STATES_TRIGGERS.length) return;
  agentStatesHookInstalled = false;
  agentStatesWriteVersion++;
  installAgentStatesWriteHook();
}

/**
 * Monotonic count of writes to `agent_states` on this connection. Compare two
 * readings to learn whether any state was inserted, ended or retyped in between.
 * Blind to rollbacks — see the note above `agentStatesWriteVersion`.
 *
 * While the write hook can't be installed (no table yet) this returns a fresh
 * value on every call, so a caller caching against it simply never trusts its
 * cache — correct, just uncached — instead of trusting one it can't invalidate.
 */
export function getAgentStatesWriteVersion(): number {
  if (!installAgentStatesWriteHook()) return ++agentStatesWriteVersion;
  return agentStatesWriteVersion;
}

/**
 * Create the perf indexes and apply additive column migrations.
 *
 * Safe to call more than once (every statement is idempotent), so it can be
 * re-run after tables are created on a fresh database.
 */
export function initSchema(): void {
  createPerfIndexes();
  installAgentStatesWriteHook();
  // Independent steps (see runStartupSteps): the clock rebase must not depend
  // on migrateSchema succeeding. It still runs after it, since the column
  // migrations add goals.completed_at, and it skips columns a file lacks.
  runStartupSteps([
    migrateSchema,
    // One-shot (PRAGMA user_version); logs to the console when it rewrites a world.
    () => rebaseTickStampsToGameMinutes(sqlite),
    // One-shot (user_version 3), after the rebase: old worlds' wages to the E5 floor.
    () => raiseWagesToFloor(sqlite, CONFIG.ECONOMY.WAGE_FLOOR),
    // Every start, whatever user_version says: no started-at stamp in the future.
    () => clampFutureGameMinuteStamps(sqlite),
    // After migrateSchema, which adds the column; a no-op once filled.
    () => backfillRelationshipInteractionMinutes(sqlite),
    // Same shape for relationship_events.game_minute: the trigger stamps new
    // rows (and must exist before the tick writes any), the backfill old ones.
    // After migrateSchema, which adds the column the trigger writes.
    () => installRelationshipEventMinuteTrigger(sqlite),
    () => backfillRelationshipEventGameMinutes(sqlite),
  ]);
  // Again, for indexes on columns migrateSchema only just added: on an old file
  // the first pass above failed on idx_relationship_events_game_minute (and
  // swallowed it) because `game_minute` didn't exist yet. Idempotent.
  createPerfIndexes();
}

initSchema();

export const db = drizzle(sqlite, { schema });
export { sqlite };
