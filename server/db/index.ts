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
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 3000'); // wait up to 3s for lock instead of throwing immediately
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('cache_size = -20000');
sqlite.pragma('temp_store = MEMORY');
sqlite.pragma('mmap_size = 30000000');

// Performance indexes not covered by Drizzle schema
sqlite.exec('CREATE INDEX IF NOT EXISTS idx_memories_agent_created ON memories (agent_id, created_at DESC)');
sqlite.exec('CREATE INDEX IF NOT EXISTS idx_conversations_status_ended ON conversations (status, ended_at DESC)');

// ─── Schema migrations (additive columns) ─────────────────────────────────
function migrateSchema() {
  const addColumnIfMissing = (table: string, column: string, type: string, dflt?: string) => {
    try {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${dflt ? ` DEFAULT ${dflt}` : ''}`);
    } catch {
      // Column already exists — ignore
    }
  };

  // Goals table extensions
  addColumnIfMissing('goals', 'description', 'TEXT');
  addColumnIfMissing('goals', 'strategy', 'TEXT');
  addColumnIfMissing('goals', 'mapped_interactions', 'TEXT');
  addColumnIfMissing('goals', 'pivot_count', 'INTEGER', '0');
  addColumnIfMissing('goals', 'source', 'TEXT', "'reactive'");

  // Aspirations table extensions
  addColumnIfMissing('aspirations', 'description', 'TEXT');
  addColumnIfMissing('aspirations', 'shifted_reason', 'TEXT');

  // Backfill existing goals with description = type
  sqlite.exec(`UPDATE goals SET description = type WHERE description IS NULL`);
  // Backfill existing aspirations with description from type
  sqlite.exec(`UPDATE aspirations SET description = type WHERE description IS NULL`);
}

migrateSchema();

export const db = drizzle(sqlite, { schema });
export { sqlite };
