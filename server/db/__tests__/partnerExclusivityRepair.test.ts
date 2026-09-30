import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { repairPartnerExclusivity } from '../partnerExclusivityRepair';

// A private in-memory DB with just the columns the repair reads: it rewrites rows, which on the
// shared test DB would touch other tests' relationships.
function makeDb(rels: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE relationships (
      id INTEGER PRIMARY KEY, agent_a INTEGER NOT NULL, agent_b INTEGER NOT NULL,
      friendship_ab REAL NOT NULL, friendship_ba REAL NOT NULL, romance_ab REAL NOT NULL, romance_ba REAL NOT NULL,
      tags TEXT NOT NULL, status TEXT NOT NULL, status_since_minute INTEGER NOT NULL
    );
    INSERT INTO agents (id, is_active) VALUES (1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 0);
    INSERT INTO relationships (id, agent_a, agent_b, friendship_ab, friendship_ba, romance_ab, romance_ba, tags, status, status_since_minute) VALUES
      ${rels};
  `);
  return db;
}

const rows = (db: Database.Database) => db.prepare('SELECT id, status, tags FROM relationships ORDER BY id').all() as
  Array<{ id: number; status: string; tags: string }>;
const statusOf = (db: Database.Database, id: number) => rows(db).find((r) => r.id === id)!;

describe('repairPartnerExclusivity', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('keeps the earliest partnership of a person and demotes the later ones to a crush', () => {
    const db = makeDb(`
      (1, 1, 2, 60, 60, 85, 85, '["partner"]', 'partners', 500),
      (2, 1, 3, 60, 60, 85, 85, '["partner","kissed"]', 'partners', 900),
      (3, 1, 4, 60, 60, 85, 85, '["partner"]', 'partners', 700)`);
    expect(repairPartnerExclusivity(db)).toBe(2);
    expect(statusOf(db, 1)).toMatchObject({ status: 'partners', tags: '["partner"]' });
    for (const id of [2, 3]) {
      const r = statusOf(db, id);
      expect(r.status).toBe('romantic_interest');
      expect(JSON.parse(r.tags)).toContain('crush');
      expect(JSON.parse(r.tags)).not.toContain('partner');
    }
    // Other tags survive.
    expect(JSON.parse(statusOf(db, 2).tags)).toContain('kissed');
  });

  it('a married or engaged tie wins over an older plain partnership, whoever is older', () => {
    const db = makeDb(`
      (1, 1, 2, 60, 60, 85, 85, '["partner"]', 'partners', 100),
      (2, 1, 3, 60, 60, 70, 70, '["partner","married"]', 'partners', 900),
      (3, 4, 5, 60, 60, 85, 85, '["partner"]', 'partners', 100),
      (4, 4, 2, 60, 60, 85, 85, '["partner","engaged"]', 'partners', 950)`);
    repairPartnerExclusivity(db);
    expect(statusOf(db, 2).status).toBe('partners'); // married stays
    expect(statusOf(db, 1).status).toBe('romantic_interest'); // 1 is married to 3
    expect(statusOf(db, 4).status).toBe('partners'); // engaged stays
    expect(statusOf(db, 3).status).toBe('romantic_interest'); // 4 is engaged to 2
  });

  it('a demoted row frees its other person, so a later row of theirs can stand', () => {
    // 1-2 is earliest and wins 1 and 2; 2-3 loses (2 is taken); 3-4 then stands because 3 is free.
    const db = makeDb(`
      (1, 1, 2, 60, 60, 85, 85, '["partner"]', 'partners', 100),
      (2, 2, 3, 60, 60, 85, 85, '["partner"]', 'partners', 200),
      (3, 3, 4, 60, 60, 85, 85, '["partner"]', 'partners', 300)`);
    repairPartnerExclusivity(db);
    expect(rows(db).map((r) => r.status)).toEqual(['partners', 'romantic_interest', 'partners']);
  });

  it('ignores partnerships with somebody who has left town, and never touches a lone couple', () => {
    const db = makeDb(`
      (1, 1, 2, 60, 60, 85, 85, '["partner"]', 'partners', 100),
      (2, 1, 6, 60, 60, 85, 85, '["partner"]', 'partners', 50),
      (3, 3, 4, 60, 60, 85, 85, '["partner"]', 'partners', 300)`);
    expect(repairPartnerExclusivity(db)).toBe(0);
    expect(rows(db).map((r) => r.status)).toEqual(['partners', 'partners', 'partners']);
  });

  it('a demoted pair that has fallen out reads as complicated, and one with no romance as plain friends', () => {
    const db = makeDb(`
      (1, 1, 2, 60, 60, 85, 85, '["partner"]', 'partners', 100),
      (2, 1, 3, -30, -30, 50, 50, '["partner"]', 'partners', 200),
      (3, 1, 4, 60, 60, 10, 10, '["partner"]', 'partners', 300)`);
    repairPartnerExclusivity(db);
    expect(statusOf(db, 2).status).toBe('complicated');
    expect(statusOf(db, 3).status).toBe('friends');
    // No romance left to call a crush.
    expect(JSON.parse(statusOf(db, 3).tags)).not.toContain('crush');
  });

  it('is idempotent: a second run finds nothing to do', () => {
    const db = makeDb(`
      (1, 1, 2, 60, 60, 85, 85, '["partner"]', 'partners', 100),
      (2, 1, 3, 60, 60, 85, 85, '["partner"]', 'partners', 200)`);
    expect(repairPartnerExclusivity(db)).toBe(1);
    const after = rows(db);
    expect(repairPartnerExclusivity(db)).toBe(0);
    expect(rows(db)).toEqual(after);
  });

  it('reads a partner by the tag alone as well as by the status', () => {
    const db = makeDb(`
      (1, 1, 2, 60, 60, 85, 85, '["partner"]', 'partners', 100),
      (2, 1, 3, 60, 60, 85, 85, '["partner"]', 'romantic_interest', 200)`);
    repairPartnerExclusivity(db);
    expect(JSON.parse(statusOf(db, 2).tags)).not.toContain('partner');
  });
});
