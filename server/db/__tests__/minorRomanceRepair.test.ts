import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { repairMinorRomance } from '../minorRomanceRepair';

// A private in-memory DB with just the columns the repair reads: it rewrites rows, which on
// the shared test DB would touch other tests' agents.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, age INTEGER NOT NULL);
    CREATE TABLE relationships (
      id INTEGER PRIMARY KEY, agent_a INTEGER NOT NULL, agent_b INTEGER NOT NULL,
      friendship_ab REAL NOT NULL, friendship_ba REAL NOT NULL, romance_ab REAL NOT NULL, romance_ba REAL NOT NULL,
      tags TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE agent_states (
      id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, type TEXT NOT NULL, target_agent_id INTEGER, metadata TEXT
    );
    CREATE TABLE shared_knowledge (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL, subject_id INTEGER NOT NULL, target_id INTEGER,
      sensitivity INTEGER NOT NULL, known_by TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
    );
    -- 1, 2, 3 adults; 10 and 11 minors.
    INSERT INTO agents (id, age) VALUES (1, 30), (2, 28), (3, 45), (10, 16), (11, 12);
    INSERT INTO relationships (id, agent_a, agent_b, friendship_ab, friendship_ba, romance_ab, romance_ba, tags, status) VALUES
      (1, 1, 2, 70, 70, 80, 80, '["married","kissed"]', 'partners'),
      (2, 1, 10, 60, 60, 70, 55, '["crush","kissed","friend"]', 'romantic_interest'),
      (3, 10, 11, 20, 20, 40, -10, '["partner"]', 'partners');
    INSERT INTO agent_states (id, agent_id, type, target_agent_id, metadata) VALUES
      (1, 1, 'infatuated', 2, NULL),
      (2, 1, 'infatuated', 10, NULL),
      (3, 10, 'infatuated', 1, NULL),
      (4, 2, 'jealous', 3, '{"rivalId":3,"loveInterestId":10}'),
      (5, 2, 'jealous', 3, '{"rivalId":3,"loveInterestId":1}'),
      (6, 10, 'afterglow', 1, NULL),
      (7, 11, 'suspicious', 10, NULL),
      (8, 1, 'angry', 10, NULL);
    INSERT INTO shared_knowledge (id, type, subject_id, target_id, sensitivity, known_by, is_active) VALUES
      (1, 'affair', 1, 2, 3, '[1,2,3]', 1),
      (2, 'affair', 1, 10, 3, '[1,10,3]', 1),
      (3, 'crush', 10, 1, 2, '[10]', 1),
      (4, 'kiss_seen', 1, 2, 2, '[1,2,3,10,11]', 1),
      (5, 'tryst_seen', 10, 1, 3, '[3]', 1),
      (6, 'illegitimate_pregnancy', 3, NULL, 3, '[3,1]', 1),
      (7, 'theft', 10, 1, 2, '[10]', 1),
      (8, 'seduction', 1, 10, 2, '[1]', 0);
  `);
  return db;
}

const q = <T>(db: Database.Database, sql: string) => db.prepare(sql).all() as T[];

describe('repairMinorRomance', () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    db = makeDb();
  });
  afterEach(() => vi.restoreAllMocks());

  it('strips romance, tags and status from every relationship with a minor, and leaves adult couples alone', () => {
    repairMinorRomance(db);
    const rows = q<{ id: number; romance_ab: number; romance_ba: number; tags: string; status: string }>(
      db, 'SELECT id, romance_ab, romance_ba, tags, status FROM relationships ORDER BY id');
    expect(rows[0]).toMatchObject({ romance_ab: 80, romance_ba: 80, tags: '["married","kissed"]', status: 'partners' });
    expect(rows[1]).toMatchObject({ romance_ab: 0, romance_ba: 0, tags: '["friend"]', status: 'friends' });
    // A seeded dislike stays a dislike.
    expect(rows[2]).toMatchObject({ romance_ab: 0, romance_ba: -10, tags: '[]', status: 'acquaintances' });
  });

  it('removes romantic states of a minor or aimed at one (and jealousy over a minor), keeping the rest', () => {
    repairMinorRomance(db);
    const ids = q<{ id: number }>(db, 'SELECT id FROM agent_states ORDER BY id').map((r) => r.id);
    // Kept: adult-to-adult infatuation (1), jealousy over an adult love interest (5), a non-romantic state (8).
    expect(ids).toEqual([1, 5, 8]);
  });

  it('retires romantic facts that name a minor, and takes minors out of the rest', () => {
    repairMinorRomance(db);
    const rows = q<{ id: number; is_active: number; known_by: string }>(db, 'SELECT id, is_active, known_by FROM shared_knowledge ORDER BY id');
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(1)!.is_active).toBe(1);
    expect(byId.get(2)!.is_active).toBe(0); // names a minor as target
    expect(byId.get(3)!.is_active).toBe(0); // a minor's crush
    expect(byId.get(5)!.is_active).toBe(0); // a minor as subject
    expect(byId.get(7)!.is_active).toBe(1); // not romantic: untouched, even about a minor
    expect(JSON.parse(byId.get(7)!.known_by)).toEqual([10]);
    // Adults' romance stays, but no child knows it.
    expect(JSON.parse(byId.get(4)!.known_by)).toEqual([1, 2, 3]);
    expect(byId.get(4)!.is_active).toBe(1);
    expect(JSON.parse(byId.get(6)!.known_by)).toEqual([3, 1]);
  });

  it('is idempotent, and a no-op for a town of adults', () => {
    expect(repairMinorRomance(db)).toBeGreaterThan(0);
    const snapshot = JSON.stringify([
      q(db, 'SELECT * FROM relationships'), q(db, 'SELECT * FROM agent_states'), q(db, 'SELECT * FROM shared_knowledge'),
    ]);
    expect(repairMinorRomance(db)).toBe(0);
    expect(JSON.stringify([
      q(db, 'SELECT * FROM relationships'), q(db, 'SELECT * FROM agent_states'), q(db, 'SELECT * FROM shared_knowledge'),
    ])).toBe(snapshot);

    const adults = makeDb();
    adults.exec('DELETE FROM agents WHERE age < 18');
    expect(repairMinorRomance(adults)).toBe(0);
  });

  it('does nothing on an empty world', () => {
    db.exec('DELETE FROM agents');
    expect(repairMinorRomance(db)).toBe(0);
  });
});
