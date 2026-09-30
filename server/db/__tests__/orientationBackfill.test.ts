import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { backfillOrientations, repairOrientationConflicts } from '../orientationBackfill';

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

describe('repairOrientationConflicts', () => {
  function repairDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agents (id INTEGER PRIMARY KEY, gender TEXT NOT NULL, age INTEGER, orientation TEXT);
      CREATE TABLE relationships (
        id INTEGER PRIMARY KEY, agent_a INTEGER NOT NULL, agent_b INTEGER NOT NULL,
        romance_ab REAL NOT NULL, romance_ba REAL NOT NULL
      );
      INSERT INTO agents (id, gender, age, orientation) VALUES
        (1, 'male', 30, 'gay'),      -- seeded in love with a woman, wrongly rolled gay
        (2, 'female', 28, 'straight'),
        (3, 'male', 40, 'straight'), -- nothing seeded: untouched
        (4, 'female', 35, 'gay'),    -- gay and content: untouched
        (5, 'male', 16, 'gay'),      -- a minor: never widened here
        (6, 'female', 30, 'straight');
      INSERT INTO relationships (agent_a, agent_b, romance_ab, romance_ba) VALUES
        (1, 2, 60, 55), (3, 4, 0, 0), (5, 6, 70, 70);
    `);
    return db;
  }
  const orient = (db: Database.Database, id: number) =>
    (db.prepare('SELECT orientation FROM agents WHERE id = ?').get(id) as { orientation: string }).orientation;

  beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('widens an orientation that blocks a seeded adult romance to bi', () => {
    const db = repairDb();
    expect(repairOrientationConflicts(db)).toBe(1);
    expect(orient(db, 1)).toBe('bi');
    expect(orient(db, 2)).toBe('straight');
    expect(orient(db, 3)).toBe('straight');
    expect(orient(db, 4)).toBe('gay');
  });

  it('never widens a minor, or an adult over a romance with a minor', () => {
    const db = repairDb();
    repairOrientationConflicts(db);
    expect(orient(db, 5)).toBe('gay');
    expect(orient(db, 6)).toBe('straight');
  });

  it('is idempotent', () => {
    const db = repairDb();
    repairOrientationConflicts(db);
    expect(repairOrientationConflicts(db)).toBe(0);
  });
});
