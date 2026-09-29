import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  GAME_MINUTE_STAMPS_VERSION,
  backfillRelationshipInteractionMinutes,
  clampFutureGameMinuteStamps,
  rebaseSpeed,
  rebaseTickStampsToGameMinutes,
} from '../clockMigration';
import { runStartupSteps } from '../startupSteps';

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

  it('never pushes already-converted stamps into the future if it runs twice', () => {
    rebaseTickStampsToGameMinutes(db);
    db.pragma('user_version = 0'); // version header lost, e.g. a restored file
    rebaseTickStampsToGameMinutes(db);
    for (const sql of [
      'SELECT action_started AS v FROM agents',
      'SELECT started_at AS v FROM agent_states',
      'SELECT started_at AS v FROM world_events',
      'SELECT created_at AS v FROM goals',
      'SELECT adopted_at AS v FROM aspirations',
      'SELECT shifted_at AS v FROM aspirations',
    ]) {
      const v = val(db, sql)!;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(nowMinutes);
    }
  });

  it('clamps a stamp that was already after the current tick to now', () => {
    db.prepare('UPDATE agent_states SET started_at = 1200').run(); // 200 ticks "in the future"
    rebaseTickStampsToGameMinutes(db);
    expect(val(db, 'SELECT started_at AS v FROM agent_states')).toBe(nowMinutes);
  });

  it('caps the speed at minutes/ticks, so a world sped up late never gets negative stamps', () => {
    // Day 0 16:40 = 1000 minutes after 1000 ticks: it ran at 1x all along and
    // was only just switched to 4x. The raw speed would send the tick-0 stamp
    // to 1000 - 1000 × 4 = -3000.
    const late = makeDb();
    late.prepare('INSERT INTO world_state VALUES (?, ?)').run(
      JSON.stringify({ day: 0, hour: 16, minute: 40, totalTicks: 1000 }), 4,
    );
    late.prepare('INSERT INTO agent_states (started_at) VALUES (?)').run(0);
    late.prepare('INSERT INTO agents (action_started) VALUES (?)').run(500);
    late.prepare('INSERT INTO world_events (started_at) VALUES (?)').run(-5); // corrupt
    rebaseTickStampsToGameMinutes(late);
    expect(val(late, 'SELECT started_at AS v FROM agent_states')).toBe(0);
    expect(val(late, 'SELECT action_started AS v FROM agents')).toBe(500);
    expect(val(late, 'SELECT started_at AS v FROM world_events')).toBe(0); // clamped, not -5
  });
});

describe('rebaseSpeed', () => {
  it('is the tick speed when minutes/ticks allows it', () => {
    expect(rebaseSpeed(4, 4920, 1000)).toBe(4);
    expect(rebaseSpeed(0.5, 4920, 1000)).toBe(0.5);
  });
  it('never exceeds the average speed the clock could have run at', () => {
    expect(rebaseSpeed(4, 1000, 1000)).toBe(1);
    expect(rebaseSpeed(4, 1500, 1000)).toBe(1.5);
  });
  it('treats speed 0 as 1x and a tick-0 world as its current speed', () => {
    expect(rebaseSpeed(0, 4920, 1000)).toBe(1);
    expect(rebaseSpeed(2, 480, 0)).toBe(2);
  });
});

describe('clampFutureGameMinuteStamps', () => {
  const nowMinutes = 3 * 1440 + 10 * 60;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('pulls future stamps back to now and logs once with counts', () => {
    const db = makeDb();
    putWorld(db, 1);
    db.prepare('INSERT INTO agents (action_started) VALUES (?), (?)').run(nowMinutes + 10, nowMinutes - 10);
    db.prepare('INSERT INTO agent_states (started_at) VALUES (?)').run(nowMinutes + 5000);
    db.prepare('INSERT INTO world_events (started_at) VALUES (?)').run(nowMinutes);
    db.prepare('INSERT INTO goals (created_at) VALUES (?)').run(nowMinutes + 1);
    clampFutureGameMinuteStamps(db);
    expect((db.prepare('SELECT action_started AS v FROM agents ORDER BY id').all() as { v: number }[]).map((r) => r.v))
      .toEqual([nowMinutes, nowMinutes - 10]);
    expect(val(db, 'SELECT started_at AS v FROM agent_states')).toBe(nowMinutes);
    expect(val(db, 'SELECT started_at AS v FROM world_events')).toBe(nowMinutes);
    expect(val(db, 'SELECT created_at AS v FROM goals')).toBe(nowMinutes);
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('agents.action_started: 1');
    expect(line).toContain('goals.created_at: 1');
    expect(line).not.toContain('world_events');
  });

  it('runs regardless of user_version and is silent on a healthy database', () => {
    const db = makeDb();
    putWorld(db, 1);
    db.pragma(`user_version = ${GAME_MINUTE_STAMPS_VERSION}`);
    db.prepare('INSERT INTO agent_states (started_at) VALUES (?)').run(nowMinutes - 1);
    clampFutureGameMinuteStamps(db);
    expect(val(db, 'SELECT started_at AS v FROM agent_states')).toBe(nowMinutes - 1);
    expect(log).not.toHaveBeenCalled();

    db.prepare('UPDATE agent_states SET started_at = ?').run(nowMinutes + 60);
    clampFutureGameMinuteStamps(db);
    expect(val(db, 'SELECT started_at AS v FROM agent_states')).toBe(nowMinutes);
  });

  it('skips missing tables and does nothing without a world', () => {
    const old = makeDb(false);
    putWorld(old, 1);
    expect(() => clampFutureGameMinuteStamps(old)).not.toThrow();
    expect(() => clampFutureGameMinuteStamps(new Database(':memory:'))).not.toThrow();
  });
});

describe('backfillRelationshipInteractionMinutes', () => {
  it('starts NULL and future decay clocks at now, leaving the rest alone', () => {
    const db = makeDb();
    putWorld(db, 1);
    db.exec('CREATE TABLE relationships (id INTEGER PRIMARY KEY, last_interaction_minute INTEGER)');
    db.prepare('INSERT INTO relationships (last_interaction_minute) VALUES (?), (?), (?)').run(null, 100, 999_999);
    backfillRelationshipInteractionMinutes(db);
    const now = 3 * 1440 + 10 * 60;
    expect((db.prepare('SELECT last_interaction_minute AS v FROM relationships ORDER BY id').all() as { v: number }[])
      .map((r) => r.v)).toEqual([now, 100, now]);
  });

  it('is a no-op without the column or a world', () => {
    const db = makeDb();
    putWorld(db, 1);
    db.exec('CREATE TABLE relationships (id INTEGER PRIMARY KEY)');
    expect(() => backfillRelationshipInteractionMinutes(db)).not.toThrow();
    expect(() => backfillRelationshipInteractionMinutes(new Database(':memory:'))).not.toThrow();
  });
});

describe('runStartupSteps', () => {
  it('still runs the clock rebase when the schema migration hits a missing table', () => {
    const db = makeDb();
    putWorld(db, 4);
    db.prepare('INSERT INTO agent_states (started_at) VALUES (?)').run(900);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    runStartupSteps([
      () => { throw new Error('no such table: shared_knowledge'); },
      () => rebaseTickStampsToGameMinutes(db),
    ]);
    expect(version(db)).toBe(GAME_MINUTE_STAMPS_VERSION);
    expect(val(db, 'SELECT started_at AS v FROM agent_states')).toBe(3 * 1440 + 10 * 60 - 400);
    vi.restoreAllMocks();
  });

  it('runs every step, then rethrows the first real error', () => {
    const ran: number[] = [];
    expect(() => runStartupSteps([
      () => { ran.push(1); throw new Error('SQLITE_BUSY: database is locked'); },
      () => { ran.push(2); throw new Error('second'); },
      () => { ran.push(3); },
    ])).toThrow('SQLITE_BUSY');
    expect(ran).toEqual([1, 2, 3]);
  });
});
