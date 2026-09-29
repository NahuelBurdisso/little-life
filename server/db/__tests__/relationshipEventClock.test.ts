import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  backfillRelationshipEventGameMinutes,
  installRelationshipEventMinuteTrigger,
} from '../relationshipEventClock';

// Private in-memory DB with just the columns involved: the shared test file has
// other tests' rows, and the process-wide connection already has the trigger.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE world_state (id INTEGER PRIMARY KEY, time TEXT NOT NULL, tick_speed REAL NOT NULL);
    CREATE TABLE relationship_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      game_minute INTEGER
    );
  `);
  return db;
}

function setClock(db: Database.Database, day: number, hour: number, minute: number, speed = 1): void {
  db.prepare('DELETE FROM world_state').run();
  db.prepare('INSERT INTO world_state (time, tick_speed) VALUES (?, ?)').run(
    JSON.stringify({ day, hour, minute, totalTicks: 0, seasonDay: 1, season: 'spring' }),
    speed,
  );
}

const minuteOf = (db: Database.Database, id: number | bigint) =>
  (db.prepare('SELECT game_minute AS v FROM relationship_events WHERE id = ?').get(id) as { v: number | null }).v;

const insert = (db: Database.Database, timestamp = Date.now(), gameMinute: number | null = null) =>
  db.prepare('INSERT INTO relationship_events (event_type, timestamp, game_minute) VALUES (?, ?, ?)')
    .run('fight', timestamp, gameMinute).lastInsertRowid;

describe('relationship_events game-minute trigger', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    installRelationshipEventMinuteTrigger(db);
  });

  it('stamps a new row with the world clock, whoever inserts it', () => {
    setClock(db, 3, 10, 30);
    expect(minuteOf(db, insert(db))).toBe(3 * 1440 + 10 * 60 + 30);
  });

  it('floors a fractional minute (0.5x) like gameMinutes()', () => {
    setClock(db, 1, 0, 12.5);
    expect(minuteOf(db, insert(db))).toBe(1440 + 12);
  });

  it('keeps an explicit value', () => {
    setClock(db, 3, 10, 30);
    expect(minuteOf(db, insert(db, Date.now(), 77))).toBe(77);
  });

  it('leaves the row unstamped when there is no world yet', () => {
    expect(minuteOf(db, insert(db))).toBeNull();
  });

  it('is idempotent to install twice', () => {
    expect(() => installRelationshipEventMinuteTrigger(db)).not.toThrow();
  });
});

describe('backfillRelationshipEventGameMinutes', () => {
  const NOW_MS = 1_700_000_000_000;
  const nowMinutes = 3 * 1440 + 10 * 60; // day 3, 10:00

  it('dates old rows by their wall-clock age at the current speed, clamped to day 0', () => {
    const db = makeDb(); // no trigger: these rows predate it
    const tenSecondsAgo = insert(db, NOW_MS - 10_000);
    const lastWeek = insert(db, NOW_MS - 7 * 86_400_000);
    const stamped = insert(db, NOW_MS - 10_000, 42);
    setClock(db, 3, 10, 0, 4);

    expect(backfillRelationshipEventGameMinutes(db, NOW_MS)).toBe(2);
    expect(minuteOf(db, tenSecondsAgo)).toBe(nowMinutes - 40); // 10 ticks × 4 min
    expect(minuteOf(db, lastWeek)).toBe(0);
    expect(minuteOf(db, stamped)).toBe(42);
    // Second run finds nothing left to fill.
    expect(backfillRelationshipEventGameMinutes(db, NOW_MS)).toBe(0);
  });

  it('never dates a row after now (clock skew, future timestamp)', () => {
    const db = makeDb();
    const future = insert(db, NOW_MS + 60_000);
    setClock(db, 3, 10, 0);
    backfillRelationshipEventGameMinutes(db, NOW_MS);
    expect(minuteOf(db, future)).toBe(nowMinutes);
  });

  it('is a no-op on a file without a world or without the column', () => {
    const noWorld = makeDb();
    insert(noWorld, NOW_MS);
    expect(backfillRelationshipEventGameMinutes(noWorld, NOW_MS)).toBe(0);
    expect(() => backfillRelationshipEventGameMinutes(new Database(':memory:'))).not.toThrow();
  });
});
