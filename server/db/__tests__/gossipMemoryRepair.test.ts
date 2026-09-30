import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { repairUndefinedGossipMemories } from '../gossipMemoryRepair';

// A private in-memory DB, like sightingFactRepair.test.ts: the repair must not run on the shared test DB.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, description TEXT NOT NULL);');
  const add = db.prepare('INSERT INTO memories (id, description) VALUES (?, ?)');
  add.run(1, 'I told undefined that Tom Park stole a loaf.');
  add.run(2, 'I shared with undefined that Tom Park stole a loaf.');
  add.run(3, 'I told Ana that Tom Park stole a loaf.');
  add.run(4, 'The undefined behaviour of the mill worried me.');
  return db;
}

const rows = (db: Database.Database) =>
  (db.prepare('SELECT description FROM memories ORDER BY id').all() as Array<{ description: string }>).map((r) => r.description);

describe('repairUndefinedGossipMemories', () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    db = makeDb();
  });
  afterEach(() => vi.restoreAllMocks());

  it('names "someone" where the old template printed undefined, and only there', () => {
    expect(repairUndefinedGossipMemories(db)).toBe(2);
    expect(rows(db)).toEqual([
      'I told someone that Tom Park stole a loaf.',
      'I shared with someone that Tom Park stole a loaf.',
      'I told Ana that Tom Park stole a loaf.',
      'The undefined behaviour of the mill worried me.',
    ]);
  });

  it('is a no-op the second time', () => {
    repairUndefinedGossipMemories(db);
    const after = rows(db);
    expect(repairUndefinedGossipMemories(db)).toBe(0);
    expect(rows(db)).toEqual(after);
  });
});
