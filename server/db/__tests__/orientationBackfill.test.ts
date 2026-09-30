import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { backfillOrientations } from '../orientationBackfill';

// A private in-memory DB: the backfill writes to every NULL row, which on the
// shared test DB would rewrite other tests' agents.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, gender TEXT NOT NULL, orientation TEXT);
    CREATE TABLE relationships (
      id INTEGER PRIMARY KEY, agent_a INTEGER NOT NULL, agent_b INTEGER NOT NULL,
      romance_ab REAL NOT NULL, romance_ba REAL NOT NULL
    );
    INSERT INTO agents (id, gender, orientation) VALUES
      (1, 'male', NULL), (2, 'male', NULL), (3, 'female', NULL), (4, 'female', 'bi'), (5, 'male', NULL);
    INSERT INTO relationships (agent_a, agent_b, romance_ab, romance_ba) VALUES (1, 2, 55, 40), (3, 4, 0, 0);
  `);
  return db;
}

const read = (db: Database.Database) =>
  db.prepare('SELECT id, orientation FROM agents ORDER BY id').all() as Array<{ id: number; orientation: string | null }>;

describe('backfillOrientations', () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    db = makeDb();
  });
  afterEach(() => vi.restoreAllMocks());

  it('fills every NULL row and leaves a set orientation alone', () => {
    const changed = backfillOrientations(db);
    expect(changed).toBe(4);
    const rows = read(db);
    expect(rows.every((r) => r.orientation !== null)).toBe(true);
    expect(rows.find((r) => r.id === 4)!.orientation).toBe('bi');
  });

  it('respects a seeded same-gender crush', () => {
    backfillOrientations(db);
    const rows = read(db);
    expect(rows.find((r) => r.id === 1)!.orientation).toBe('gay');
    expect(rows.find((r) => r.id === 2)!.orientation).toBe('gay');
  });

  it('is a no-op on a second run', () => {
    backfillOrientations(db);
    const first = read(db);
    expect(backfillOrientations(db)).toBe(0);
    expect(read(db)).toEqual(first);
  });

  it('is deterministic: the same rows fill the same way', () => {
    backfillOrientations(db);
    const other = makeDb();
    backfillOrientations(other);
    expect(read(other)).toEqual(read(db));
  });

  it('does nothing on an empty table', () => {
    db.exec('DELETE FROM agents');
    expect(backfillOrientations(db)).toBe(0);
  });
});
