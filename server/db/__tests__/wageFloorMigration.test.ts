import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { raiseWagesToFloor, WAGE_FLOOR_VERSION } from '../wageFloorMigration';
import { GAME_MINUTE_STAMPS_VERSION } from '../clockMigration';

// A private in-memory DB with just the columns the migration reads: running it
// against the shared test DB would rewrite other tests' rows.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, is_active INTEGER NOT NULL);
    CREATE TABLE economy (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, salary REAL NOT NULL);
  `);
  const add = (active: boolean, salary: number) => {
    const { lastInsertRowid } = db.prepare('INSERT INTO agents (is_active) VALUES (?)').run(active ? 1 : 0);
    db.prepare('INSERT INTO economy (agent_id, salary) VALUES (?, ?)').run(lastInsertRowid, salary);
  };
  add(true, 14);  // musician on the old table
  add(true, 28);  // mayor: above the floor, untouched
  add(true, 0);   // no job: the stipend is their floor
  add(false, 15); // dead retiree: nobody to pay
  return db;
}

const salaries = (db: Database.Database) =>
  (db.prepare('SELECT salary FROM economy ORDER BY id').all() as { salary: number }[]).map((r) => r.salary);
const version = (db: Database.Database) => db.pragma('user_version', { simple: true });

describe('raiseWagesToFloor', () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    db = makeDb();
    db.pragma(`user_version = ${GAME_MINUTE_STAMPS_VERSION}`);
  });
  afterEach(() => vi.restoreAllMocks());

  it("raises an old world's active low earners to the floor, once", () => {
    raiseWagesToFloor(db, 20);
    expect(salaries(db)).toEqual([20, 28, 0, 15]);
    expect(version(db)).toBe(WAGE_FLOOR_VERSION);

    // A player who then sets a $12 wage in a later world keeps it: the step
    // never runs again on this file.
    db.prepare('UPDATE economy SET salary = 12 WHERE id = 1').run();
    raiseWagesToFloor(db, 20);
    expect(salaries(db)[0]).toBe(12);
  });

  it('waits for the clock rebase: a file it has not reached yet is left alone', () => {
    db.pragma('user_version = 0');
    raiseWagesToFloor(db, 20);
    expect(salaries(db)[0]).toBe(14);
    expect(version(db)).toBe(0);
  });

  it('a file without the tables yet is just marked current', () => {
    const fresh = new Database(':memory:');
    fresh.pragma(`user_version = ${GAME_MINUTE_STAMPS_VERSION}`);
    raiseWagesToFloor(fresh, 20);
    expect(version(fresh)).toBe(WAGE_FLOOR_VERSION);
  });
});
