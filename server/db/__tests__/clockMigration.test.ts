import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { GAME_MINUTE_STAMPS_VERSION, rebaseTickStampsToGameMinutes } from '../clockMigration';

// A private in-memory DB with just the columns the rebase touches: running it
// against the shared test DB would rewrite other tests' rows.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE world_state (time TEXT NOT NULL, tick_speed REAL NOT NULL);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, action_started INTEGER NOT NULL);
    CREATE TABLE agent_states (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL);
    CREATE TABLE world_events (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL);
  `);
  return db;
}

const col = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { v: number }).v;

describe('rebaseTickStampsToGameMinutes', () => {
  let db: Database.Database;
  // Day 3, 10:00 = 4920 game minutes, reached in 1000 ticks, now running at 4x.
  const nowMinutes = 3 * 1440 + 10 * 60;

  beforeEach(() => {
    db = makeDb();
    db.prepare('INSERT INTO world_state VALUES (?, ?)').run(
      JSON.stringify({ day: 3, hour: 10, minute: 0, totalTicks: 1000, seasonDay: 3, season: 'spring' }), 4,
    );
    db.prepare('INSERT INTO agents (action_started) VALUES (?)').run(990); // 10 ticks ago
    db.prepare('INSERT INTO agent_states (started_at) VALUES (?)').run(900); // 100 ticks ago
    db.prepare('INSERT INTO world_events (started_at) VALUES (?)').run(1000); // this tick
  });

  it('moves every tick stamp onto the game-minute clock, keeping its age at the current speed', () => {
    rebaseTickStampsToGameMinutes(db);
    expect(col(db, 'SELECT action_started AS v FROM agents')).toBe(nowMinutes - 40);
    expect(col(db, 'SELECT started_at AS v FROM agent_states')).toBe(nowMinutes - 400);
    expect(col(db, 'SELECT started_at AS v FROM world_events')).toBe(nowMinutes);
    expect(db.pragma('user_version', { simple: true })).toBe(GAME_MINUTE_STAMPS_VERSION);
  });

  it('runs only once', () => {
    rebaseTickStampsToGameMinutes(db);
    rebaseTickStampsToGameMinutes(db);
    expect(col(db, 'SELECT started_at AS v FROM agent_states')).toBe(nowMinutes - 400);
  });

  it('marks a database with no world yet as done without touching anything', () => {
    const empty = new Database(':memory:');
    rebaseTickStampsToGameMinutes(empty);
    expect(empty.pragma('user_version', { simple: true })).toBe(GAME_MINUTE_STAMPS_VERSION);
  });
});
