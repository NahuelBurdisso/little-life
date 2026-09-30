import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createIntimacyTally, findMinorsInIntimacy, formatIntimacyReport } from '../soakIntimacy';

// Just the columns the soak's intimacy section reads.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    create table agents (id integer primary key, name text, age integer);
    create table relationship_events (id integer primary key autoincrement, agent_a integer, agent_b integer, event_type text);
    create table activity_log (id integer primary key autoincrement, type text, initiator_id integer, target_id integer, agent_ids text);
    create table shared_knowledge (id integer primary key autoincrement, type text, subject_id integer, target_id integer, known_by text);
    create table agent_states (id integer primary key autoincrement, agent_id integer, type text, target_agent_id integer);
    create table relationships (id integer primary key autoincrement, agent_a integer, agent_b integer, romance_ab real, romance_ba real, tags text);
    create table sim_snapshots (key text primary key, data text);
    insert into agents values (1, 'Ada', 30), (2, 'Ben', 34), (3, 'Cy', 40), (4, 'Kid', 16);
  `);
  return db;
}

describe('findMinorsInIntimacy', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it('is clean for a town of adults, and for a minor with nothing intimate', () => {
    db.exec(`insert into relationship_events (agent_a, agent_b, event_type) values (1, 2, 'first_tryst');
             insert into activity_log (type, initiator_id, target_id, agent_ids) values ('tryst', 1, 2, '[1,2]');
             insert into shared_knowledge (type, subject_id, target_id, known_by) values ('tryst_seen', 1, 2, '[1,2,3]');
             insert into relationships (agent_a, agent_b, romance_ab, romance_ba, tags) values (1, 2, 80, 80, '["kissed","lovers"]');
             insert into relationships (agent_a, agent_b, romance_ab, romance_ba, tags) values (3, 4, 0, 0, '["coworkers"]');`);
    expect(findMinorsInIntimacy(db).every((f) => f.rows.length === 0)).toBe(true);
  });

  it('flags a minor in each place an intimacy fact can name someone', () => {
    db.exec(`insert into relationship_events (agent_a, agent_b, event_type) values (2, 4, 'kiss');
             insert into activity_log (type, initiator_id, target_id, agent_ids) values ('caught', 1, 2, '[1,2,4]');
             insert into shared_knowledge (type, subject_id, target_id, known_by) values ('kiss_seen', 1, 2, '[1,2,4]');
             insert into agent_states (agent_id, type, target_agent_id) values (1, 'infatuated', 4);
             insert into relationships (agent_a, agent_b, romance_ab, romance_ba, tags) values (3, 4, 12, 0, '[]');
             insert into sim_snapshots values ('intimacy', '{"pairs":{"2-4":{"kisses":1,"trysts":0}},"agents":{"4":{"longing":20}}}');`);
    const bad = findMinorsInIntimacy(db).filter((f) => f.rows.length > 0).map((f) => f.source.split(' ')[0]);
    expect(bad).toEqual(['relationship_events', 'activity_log', 'shared_knowledge', 'agent_states', 'relationships', 'sim_snapshots.intimacy']);
  });

  it('ignores rows that are not intimacy (a minor in an ordinary conversation)', () => {
    db.exec(`insert into relationship_events (agent_a, agent_b, event_type) values (2, 4, 'conversation');
             insert into activity_log (type, initiator_id, target_id, agent_ids) values ('gift', 2, 4, '[2,4]');
             insert into shared_knowledge (type, subject_id, target_id, known_by) values ('white_lie', 2, 4, '[2,4]');`);
    expect(findMinorsInIntimacy(db).every((f) => f.rows.length === 0)).toBe(true);
  });
});

describe('createIntimacyTally', () => {
  it('counts only what was created since the previous day closed', () => {
    const db = makeDb();
    const tally = createIntimacyTally(db);
    db.exec(`insert into relationship_events (agent_a, agent_b, event_type) values (1, 2, 'first_kiss'), (1, 2, 'kiss'), (1, 3, 'kiss_rebuffed');
             insert into activity_log (type, agent_ids) values ('caught', '[1,2,3]');
             insert into shared_knowledge (type, subject_id, known_by) values ('kiss_seen', 1, '[1]'), ('affair', 1, '[1]');`);
    tally.endDay(1);
    db.exec(`insert into relationship_events (agent_a, agent_b, event_type) values (1, 2, 'first_tryst');`);
    tally.endDay(2);
    tally.endDay(3);
    expect(tally.days.map((d) => [d.kisses, d.firstKisses, d.rebuffs, d.trysts, d.caught])).toEqual([
      [2, 1, 1, 0, 1], [0, 0, 0, 1, 0], [0, 0, 0, 0, 0],
    ]);
    expect(tally.days[0].facts).toMatchObject({ kiss_seen: 1, affair: 1, tryst_seen: 0 });
    expect(tally.days[1].facts.kiss_seen).toBe(0);
  });

  it('formats a report whose minors line says CLEAN or VIOLATION', () => {
    const db = makeDb();
    const tally = createIntimacyTally(db);
    tally.endDay(1);
    expect(formatIntimacyReport(tally.days, findMinorsInIntimacy(db), 1).join('\n')).toContain('CLEAN');
    db.exec(`insert into relationship_events (agent_a, agent_b, event_type) values (2, 4, 'kiss');`);
    expect(formatIntimacyReport(tally.days, findMinorsInIntimacy(db), 1).join('\n')).toContain('VIOLATION in 1 source');
  });
});
