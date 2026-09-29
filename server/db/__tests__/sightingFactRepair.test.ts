import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { repairLegacySightingFacts } from '../sightingFactRepair';

// A private in-memory DB: running the repair on the shared test DB would
// rewrite other tests' rows.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE shared_knowledge (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL, subject_id INTEGER NOT NULL,
      target_id INTEGER, content TEXT NOT NULL
    );
    INSERT INTO agents (id, name) VALUES (1, 'Yuki Tanaka'), (2, 'Diego Santos'), (3, 'Rosa Chen'), (4, 'Carlos Mendez');
  `);
  const add = db.prepare('INSERT INTO shared_knowledge (id, type, subject_id, target_id, content) VALUES (?, ?, ?, ?, ?)');
  // Old orientation: subject = the witness.
  add.run(1, 'witness', 1, 2, 'Yuki Tanaka spotted Diego Santos at a secret meeting.');
  // New orientation (setupGenerator since d111d34): subject = the person seen.
  add.run(2, 'witness', 2, 1, 'Yuki Tanaka saw Diego Santos sneaking out late at night.');
  // A witness secret with nobody seen stays as it is.
  add.run(3, 'witness', 1, null, 'Yuki Tanaka saw what really caused the accident.');
  // Not a sighting: leads with its subject and is right as it is.
  add.run(4, 'financial', 3, 4, 'Rosa Chen has been extending Carlos Mendez credit.');
  return db;
}

const pointers = (db: Database.Database) =>
  (db.prepare('SELECT subject_id, target_id FROM shared_knowledge ORDER BY id').all() as Array<{ subject_id: number; target_id: number | null }>)
    .map((r) => [r.subject_id, r.target_id]);

describe('repairLegacySightingFacts', () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    db = makeDb();
  });
  afterEach(() => vi.restoreAllMocks());

  it('points an old sighting at the person seen and leaves everything else', () => {
    expect(repairLegacySightingFacts(db)).toBe(1);
    expect(pointers(db)).toEqual([[2, 1], [2, 1], [1, null], [3, 4]]);
  });

  it('is a no-op the second time', () => {
    repairLegacySightingFacts(db);
    expect(repairLegacySightingFacts(db)).toBe(0);
    expect(pointers(db)).toEqual([[2, 1], [2, 1], [1, null], [3, 4]]);
  });
});
