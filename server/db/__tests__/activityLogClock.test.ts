import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { backfillActivityLogGameMinutes } from '../activityLogClock';

// Private in-memory DB with just the columns involved, like the relationship
// event clock test: the shared test file holds other tests' rows.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE world_state (id INTEGER PRIMARY KEY, time TEXT NOT NULL, tick_speed REAL NOT NULL);
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      game_minute INTEGER
    );
  `);
  return db;
}

function setClock(db: Database.Database, day: number, hour: number, minute: number, totalTicks: number, speed = 1): void {
  db.prepare('DELETE FROM world_state').run();
  db.prepare('INSERT INTO world_state (time, tick_speed) VALUES (?, ?)').run(
    JSON.stringify({ day, hour, minute, totalTicks, seasonDay: 1, season: 'spring' }),
    speed,
  );
}

const insert = (db: Database.Database, timestamp: number, gameMinute: number | null = null) =>
  db.prepare('INSERT INTO activity_log (timestamp, game_minute) VALUES (?, ?)').run(timestamp, gameMinute).lastInsertRowid;

const minuteOf = (db: Database.Database, id: number | bigint) =>
  (db.prepare('SELECT game_minute AS v FROM activity_log WHERE id = ?').get(id) as { v: number | null }).v;

describe('backfillActivityLogGameMinutes', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('places an old row by its tick age at the current speed', () => {
    // Now: day 3, 10:00 = minute 4680, tick 1000, 2 game minutes per tick.
    setClock(db, 3, 10, 0, 1000, 2);
    const id = insert(db, 900); // 100 ticks old -> 200 minutes back
    expect(backfillActivityLogGameMinutes(db)).toBe(1);
    expect(minuteOf(db, id)).toBe(3 * 1440 + 600 - 200);
  });

  it('keeps row order and clamps to [0, now]', () => {
    setClock(db, 1, 0, 30, 500, 4); // now = minute 1470
    const ancient = insert(db, 0); // 500 ticks * 4 = 2000 minutes back: below 0
    const older = insert(db, 200);
    const newer = insert(db, 480);
    const future = insert(db, 9000); // stamped past the current tick
    backfillActivityLogGameMinutes(db);
    expect(minuteOf(db, ancient)).toBe(0);
    expect(minuteOf(db, older)).toBe(1470 - 300 * 4);
    expect(minuteOf(db, newer)).toBe(1470 - 20 * 4);
    expect(minuteOf(db, future)).toBe(1470);
  });

  it('leaves stamped rows alone and is a no-op the second time', () => {
    setClock(db, 2, 0, 0, 100);
    const stamped = insert(db, 50, 77);
    const old = insert(db, 50);
    expect(backfillActivityLogGameMinutes(db)).toBe(1);
    expect(minuteOf(db, stamped)).toBe(77);
    expect(minuteOf(db, old)).not.toBeNull();
    expect(backfillActivityLogGameMinutes(db)).toBe(0);
  });

  it('treats a paused world (speed 0) as 1 minute per tick', () => {
    setClock(db, 1, 1, 0, 100, 0); // minute 1500
    const id = insert(db, 40);
    backfillActivityLogGameMinutes(db);
    expect(minuteOf(db, id)).toBe(1500 - 60);
  });

  it('does nothing without a world row', () => {
    insert(db, 5);
    expect(backfillActivityLogGameMinutes(db)).toBe(0);
  });

  it('does nothing before the column exists', () => {
    const bare = new Database(':memory:');
    bare.exec(`
      CREATE TABLE world_state (id INTEGER PRIMARY KEY, time TEXT NOT NULL, tick_speed REAL NOT NULL);
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL);
    `);
    setClock(bare, 1, 0, 0, 10);
    expect(backfillActivityLogGameMinutes(bare)).toBe(0);
  });
});
