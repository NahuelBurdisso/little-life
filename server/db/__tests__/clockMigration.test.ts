import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { GAME_MINUTE_STAMPS_VERSION, rebaseTickStampsToGameMinutes } from '../clockMigration';

// A private in-memory DB with just the columns the rebase touches: running it
// against the shared test DB would rewrite other tests' rows.
function makeDb(withGoals = true): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE world_state (time TEXT NOT NULL, tick_speed REAL NOT NULL);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, action_started INTEGER NOT NULL);
    CREATE TABLE agent_states (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL);
    CREATE TABLE world_events (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL);
  `);
  if (withGoals) {
    db.exec(`
      CREATE TABLE goals (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, completed_at INTEGER);
      CREATE TABLE aspirations (id INTEGER PRIMARY KEY, adopted_at INTEGER NOT NULL, shifted_at INTEGER);
    `);
  }
  return db;
}

function putWorld(db: Database.Database, speed: number): void {
  db.prepare('INSERT INTO world_state VALUES (?, ?)').run(
    JSON.stringify({ day: 3, hour: 10, minute: 0, totalTicks: 1000, seasonDay: 3, season: 'spring' }), speed,
  );
}

const val = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { v: number | null }).v;
const version = (db: Database.Database) => db.pragma('user_version', { simple: true });

describe('rebaseTickStampsToGameMinutes', () => {
  // Day 3, 10:00 = 4920 game minutes, reached in 1000 ticks, now running at 4x.
  const nowMinutes = 3 * 1440 + 10 * 60;
  let db: Database.Database;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    db = makeDb();
    putWorld(db, 4);
    db.prepare('INSERT INTO agents (action_started) VALUES (?)').run(990); // 10 ticks ago
    db.prepare('INSERT INTO agent_states (started_at) VALUES (?)').run(900); // 100 ticks ago
    db.prepare('INSERT INTO world_events (started_at) VALUES (?)').run(1000); // this tick
    db.prepare('INSERT INTO goals (created_at, completed_at) VALUES (?, ?)').run(500, null);
    db.prepare('INSERT INTO aspirations (adopted_at, shifted_at) VALUES (?, ?)').run(0, 750);
  });
  afterEach(() => vi.restoreAllMocks());

  it('moves every tick stamp onto the game-minute clock, keeping its age at the current speed', () => {
    rebaseTickStampsToGameMinutes(db);
    expect(val(db, 'SELECT action_started AS v FROM agents')).toBe(nowMinutes - 40);
    expect(val(db, 'SELECT started_at AS v FROM agent_states')).toBe(nowMinutes - 400);
    expect(val(db, 'SELECT started_at AS v FROM world_events')).toBe(nowMinutes);
    expect(val(db, 'SELECT created_at AS v FROM goals')).toBe(nowMinutes - 2000);
    expect(val(db, 'SELECT completed_at AS v FROM goals')).toBeNull();
    expect(val(db, 'SELECT adopted_at AS v FROM aspirations')).toBe(nowMinutes - 4000);
    expect(val(db, 'SELECT shifted_at AS v FROM aspirations')).toBe(nowMinutes - 1000);
    expect(version(db)).toBe(GAME_MINUTE_STAMPS_VERSION);
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0])).toContain('Rebased tick stamps');
  });

  it('runs only once', () => {
    rebaseTickStampsToGameMinutes(db);
    rebaseTickStampsToGameMinutes(db);
    expect(val(db, 'SELECT started_at AS v FROM agent_states')).toBe(nowMinutes - 400);
    expect(log).toHaveBeenCalledOnce();
  });

  it('applies only the steps a database has not had yet', () => {
    db.pragma('user_version = 1'); // an earlier build already converted actions/states/events
    rebaseTickStampsToGameMinutes(db);
    expect(val(db, 'SELECT started_at AS v FROM agent_states')).toBe(900); // untouched
    expect(val(db, 'SELECT created_at AS v FROM goals')).toBe(nowMinutes - 2000);
  });

  it('keeps stamps whole at fractional speeds', () => {
    const half = makeDb();
    putWorld(half, 0.5);
    half.prepare('INSERT INTO agent_states (started_at) VALUES (?)').run(999); // 1 tick = 0.5 min ago
    rebaseTickStampsToGameMinutes(half);
    expect(Number.isInteger(val(half, 'SELECT started_at AS v FROM agent_states'))).toBe(true);
  });

  it('skips stamp tables the file does not have, and still finishes', () => {
    const old = makeDb(false);
    putWorld(old, 1);
    old.prepare('INSERT INTO agent_states (started_at) VALUES (?)').run(900);
    rebaseTickStampsToGameMinutes(old);
    expect(val(old, 'SELECT started_at AS v FROM agent_states')).toBe(nowMinutes - 100);
    expect(version(old)).toBe(GAME_MINUTE_STAMPS_VERSION);
  });

  it('rolls back everything, version included, if a step fails', () => {
    db.exec('CREATE TRIGGER boom BEFORE UPDATE ON goals BEGIN SELECT RAISE(ABORT, \'boom\'); END;');
    expect(() => rebaseTickStampsToGameMinutes(db)).toThrow('boom');
    expect(val(db, 'SELECT started_at AS v FROM agent_states')).toBe(900);
    expect(version(db)).toBe(0);
  });

  it('marks a database with no world yet as done, silently', () => {
    const empty = new Database(':memory:');
    rebaseTickStampsToGameMinutes(empty);
    expect(version(empty)).toBe(GAME_MINUTE_STAMPS_VERSION);
    expect(log).not.toHaveBeenCalled();
  });
});
