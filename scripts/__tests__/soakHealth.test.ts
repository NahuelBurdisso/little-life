import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  createHealthTracker, evaluateHealthWarnings, formatCallsTable, formatHealthTable, percentile, summarizePhases,
  type DayHealth,
} from '../soakHealth';
import { buildSoakCast } from '../soakCast';

/** A quiet, healthy day; each test overrides what it is about. */
function day(n: number, over: Partial<DayHealth> = {}): DayHealth {
  return {
    day: n, population: 13, startPopulation: 13, beats: { fight: 1 }, newBeats: [], beatsSeenTotal: 5, storyTypes: 4,
    statusChanges: 1, statusFlows: {}, factsCreated: 3, secretsCreated: 1, secretsPublic: 0, goalsCompleted: 1,
    goalsAbandoned: 0, proposals: 0, engagements: 0, rejections: 0, weddings: 0, engagementsEnded: 0, deaths: 0,
    arrivals: 0, departures: 0, invisible: 1, invisibleNames: ['A'], invisibleStrict: 2, arcs: 3, arcsHot: 2, arcKinds: {},
    friendShare: 0.2, meanFriendship: 30, pairsWithRow: 60, statusMix: {}, mood: 60, moodStd: 10, arrests: 0, calls: {},
    tick: { p50: 50, p95: 80, mean: 55, max: 120, ticks: 360 }, phases: {},
    ...over,
  };
}
const CTX = { tickIntervalMs: 1000, tickSpeed: 4 };

describe('percentile', () => {
  it('is nearest-rank and 0 for nothing', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5], 50)).toBe(5);
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([3, 1, 2], 100)).toBe(3);
  });
});

describe('evaluateHealthWarnings', () => {
  it('stays quiet for a healthy run', () => {
    expect(evaluateHealthWarnings([day(1, { newBeats: ['fight'] }), day(2, { newBeats: ['date'] }), day(3, { newBeats: ['gossip'] })], CTX)).toEqual([]);
  });

  it('flags a dry spell at 3 days, then weekly, and resets when a beat type appears', () => {
    const days = Array.from({ length: 12 }, (_, i) => day(i + 1));
    const w = evaluateHealthWarnings(days, CTX).filter((m) => /no new beat type/.test(m));
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/^day 3: .*3 days/);
    expect(w[1]).toMatch(/^day 7: .*7 days/);
    const fresh = [...days.slice(0, 2), day(3, { newBeats: ['duel'] }), day(4), day(5)];
    expect(evaluateHealthWarnings(fresh, CTX)).toEqual([]);
  });

  it('flags invisible residents at 40%, not below', () => {
    expect(evaluateHealthWarnings([day(1, { population: 10, invisible: 3 })], CTX)).toEqual([]);
    const w = evaluateHealthWarnings([day(1, { population: 10, invisible: 4, invisibleNames: ['A', 'B', 'C', 'D'] })], CTX);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/4\/10 residents invisible.*A, B, C, D/);
  });

  it('flags a population under 60% of the start, not at 60%', () => {
    expect(evaluateHealthWarnings([day(1, { population: 8, startPopulation: 13 })], CTX)).toEqual([]);
    expect(evaluateHealthWarnings([day(1, { population: 7, startPopulation: 13 })], CTX)[0]).toMatch(/population 7 .* 60%/);
  });

  it('flags tick p95 above the interval, ignoring a day with no ticks', () => {
    expect(evaluateHealthWarnings([day(1, { tick: { p50: 900, p95: 1000, mean: 900, max: 1200, ticks: 360 } })], CTX)).toEqual([]);
    expect(evaluateHealthWarnings([day(1, { tick: { p50: 900, p95: 1400, mean: 900, max: 2000, ticks: 360 } })], CTX)[0]).toMatch(/p95 1400 ms .* 1000 ms/);
    expect(evaluateHealthWarnings([day(1, { tick: { p50: 0, p95: 5000, mean: 0, max: 0, ticks: 0 } })], CTX)).toEqual([]);
  });

  it('flags saturation at 70% of pairs', () => {
    expect(evaluateHealthWarnings([day(1, { friendShare: 0.69 })], CTX)).toEqual([]);
    expect(evaluateHealthWarnings([day(1, { friendShare: 0.7 })], CTX)[0]).toMatch(/saturating: 70%/);
  });

  it('flags money-supply drift between the first and last four days', () => {
    const flat = Array.from({ length: 10 }, (_, i) => ({ day: i + 1, ratio: 1.05 }));
    expect(evaluateHealthWarnings([], CTX, flat)).toEqual([]);
    const drift = flat.map((r, i) => ({ ...r, ratio: 1.0 + i * 0.06 }));
    expect(evaluateHealthWarnings([], CTX, drift)[0]).toMatch(/drifted from 1\.09 .* to 1\.45/);
    // Too short a run says nothing.
    expect(evaluateHealthWarnings([], CTX, drift.slice(0, 5))).toEqual([]);
  });
});

describe('formatHealthTable / summarizePhases', () => {
  it('prints a header, a rule and a row per day', () => {
    const t = formatHealthTable([day(1), day(2)]);
    expect(t).toHaveLength(4);
    expect(t[0].split('|').length).toBe(t[2].split('|').length);
    expect(t[1]).toMatch(/^-+\+/);
  });

  it('tables the social calls per day by beat, with totals', () => {
    const t = formatCallsTable([day(1, { calls: { sick_visit: 2 } }), day(2, { calls: { sick_visit: 1, welcome: 1 } })]);
    expect(t[0]).toMatch(/day \| sick_visit \| welcome \| total/);
    expect(t[2].replace(/\s+/g, '')).toBe('1|2|0|2');
    expect(t[3].replace(/\s+/g, '')).toBe('2|1|1|2');
    expect(t[4].replace(/\s+/g, '')).toBe('all|3|1|4');
    expect(formatCallsTable([day(1)])).toEqual(['(no social calls)']);
  });

  it('ranks phases by mean and gives each its share of the tick', () => {
    const rows = summarizePhases({ a: [1, 1, 1, 1], b: [10, 10, 10, 30] }, [11, 11, 11, 31]);
    expect(rows.map((r) => r.phase)).toEqual(['b', 'a']);
    expect(rows[0].mean).toBe(15);
    expect(rows[1].share).toBeCloseTo(1 / 16, 5);
  });
});

/** The tables the tracker reads, with just the columns it reads. */
function fixtureDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT, is_active INTEGER);
    CREATE TABLE relationships (id INTEGER PRIMARY KEY, agent_a INT, agent_b INT, friendship_ab REAL, friendship_ba REAL, status TEXT);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY, type TEXT, importance REAL, initiator_id INT, target_id INT, agent_ids TEXT, metadata TEXT);
    CREATE TABLE shared_knowledge (id INTEGER PRIMARY KEY, sensitivity INT, is_public INT DEFAULT 0);
    CREATE TABLE goals (id INTEGER PRIMARY KEY, status TEXT);
  `);
  for (const [id, name] of [[1, 'Ann'], [2, 'Bo'], [3, 'Cy'], [4, 'Di']] as const) {
    sqlite.prepare('INSERT INTO agents VALUES (?, ?, 1)').run(id, name);
  }
  return sqlite;
}
const noArcs = { detectStoryArcs: () => [], resetChronicleCache: () => {} };

describe('createHealthTracker', () => {
  it('diffs the day against the snapshot taken at the last day end', () => {
    const sqlite = fixtureDb();
    sqlite.prepare("INSERT INTO relationships VALUES (1, 1, 2, 80, 70, 'friends'), (2, 3, 4, 10, 10, 'acquaintances')").run();
    sqlite.prepare('INSERT INTO shared_knowledge (id, sensitivity, is_public) VALUES (1, 3, 0)').run();
    sqlite.prepare("INSERT INTO goals VALUES (1, 'active'), (2, 'active')").run();
    const tracker = createHealthTracker({ sqlite, ...noArcs });
    expect(tracker.startPopulation()).toBe(4);

    // ── Day 1 ──
    const log = sqlite.prepare('INSERT INTO activity_log (type, importance, initiator_id, target_id, agent_ids, metadata) VALUES (?, ?, ?, ?, ?, ?)');
    log.run('drama', 0.8, 1, 2, '[1,2]', '{"beat":"fight"}');
    log.run('drama', 0.8, 1, null, '[1]', '{"beat":"gossip"}');
    log.run('interaction_resolved', 0.6, 3, null, '[3]', null);      // makes Cy visible, but not "strict"
    log.run('conversation_ended', 0.2, 4, 3, '[4,3]', null);          // below the floor: Di stays invisible
    log.run('proposal', 0.6, 1, 2, '[1,2]', null);
    log.run('social_call', 0.5, 3, 4, '[3,4]', '{"beat":"sick_visit","callKind":"sick_visit"}');
    sqlite.prepare("UPDATE relationships SET status = 'partners' WHERE id = 1").run();
    sqlite.prepare('INSERT INTO shared_knowledge (id, sensitivity, is_public) VALUES (2, 1, 0), (3, 2, 0)').run();
    sqlite.prepare('UPDATE shared_knowledge SET is_public = 1 WHERE id = 1').run();
    sqlite.prepare("UPDATE goals SET status = 'completed' WHERE id = 1").run();
    sqlite.prepare("UPDATE goals SET status = 'abandoned' WHERE id = 2").run();
    tracker.sampleMood(60); tracker.sampleMood(80);
    tracker.recordTick({ totalMs: 100, phaseMs: [['needs', 30], ['states', 50]] });
    tracker.recordTick({ totalMs: 200, phaseMs: [['needs', 60], ['states', 60]] });
    const d1 = tracker.endDay(1);

    expect(d1.population).toBe(4);
    expect(d1.beats).toEqual({ fight: 1, gossip: 1, sick_visit: 1 });
    expect(d1.newBeats).toEqual(['fight', 'gossip', 'sick_visit']);
    expect(d1.beatsSeenTotal).toBe(3);
    expect(d1.calls).toEqual({ sick_visit: 1 });
    expect(d1.proposals).toBe(1);
    expect(d1.storyTypes).toBe(3); // drama, interaction_resolved, proposal
    expect(d1.statusChanges).toBe(1);
    expect(d1.statusFlows).toEqual({ 'friends>partners': 1 });
    expect(d1.factsCreated).toBe(2);
    expect(d1.secretsCreated).toBe(1);
    expect(d1.secretsPublic).toBe(1);
    expect(d1.goalsCompleted).toBe(1);
    expect(d1.goalsAbandoned).toBe(1);
    expect(d1.invisibleNames).toEqual(['Di']);
    expect(d1.invisibleStrict).toBe(2); // Cy and Di
    expect(d1.friendShare).toBeCloseTo(1 / 6, 5); // 1 of the 6 pairs of four residents is friends both ways
    expect(d1.pairsWithRow).toBe(2);
    expect(d1.mood).toBe(70);
    expect(d1.moodStd).toBe(10); // readings 60 and 80
    expect(d1.tick).toMatchObject({ ticks: 2, max: 200 });
    // `other` is what the phases do not account for.
    expect(d1.phases.other.mean).toBeCloseTo((20 + 80) / 2, 5);

    // ── Day 2: nothing carried over from day 1, and the same beat is no longer new ──
    log.run('drama', 0.8, 2, 4, '[2,4]', '{"beat":"fight"}');
    log.run('drama', 0.9, 3, null, '[3]', '{"beat":"death"}');
    sqlite.prepare('UPDATE agents SET is_active = 0 WHERE id = 3').run();
    sqlite.prepare("INSERT INTO agents VALUES (5, 'Ed', 1)").run();
    const d2 = tracker.endDay(2);
    expect(d2.newBeats).toEqual(['death']);
    expect(d2.beatsSeenTotal).toBe(4);
    expect(d2.calls).toEqual({});
    expect(d2.proposals).toBe(0);
    expect(d2.statusChanges).toBe(0);
    expect(d2.secretsPublic).toBe(0);
    expect(d2.goalsCompleted).toBe(0);
    expect(d2.deaths).toBe(1);
    expect(d2.departures).toBe(0); // the death is not double-counted as a departure
    expect(d2.arrivals).toBe(1);
    expect(d2.population).toBe(4);
    expect(d2.startPopulation).toBe(4);
    expect(d2.tick.ticks).toBe(0);
    expect(d2.mood).toBe(0);
    expect(d2.moodStd).toBe(0);
  });

  it('counts a resident who left without dying as a departure, and reads the arcs the chronicle gives it', () => {
    const sqlite = fixtureDb();
    let reset = 0;
    const tracker = createHealthTracker({
      sqlite,
      resetChronicleCache: () => { reset++; },
      detectStoryArcs: () => [
        { kind: 'rivalry', heat: 0.9 }, { kind: 'romance', heat: 0.1 }, { kind: 'rivalry', heat: 0.3 },
      ] as ReturnType<Parameters<typeof createHealthTracker>[0]['detectStoryArcs']>,
    });
    sqlite.prepare('UPDATE agents SET is_active = 0 WHERE id = 4').run();
    const d = tracker.endDay(1);
    expect(d.departures).toBe(1);
    expect(d.deaths).toBe(0);
    expect(reset).toBe(1);
    expect(d.arcs).toBe(3);
    expect(d.arcsHot).toBe(2);
    expect(d.arcKinds).toEqual({ rivalry: 2, romance: 1 });
  });
});

describe('buildSoakCast', () => {
  it('keeps the wizard default at 13 and trims below it', () => {
    expect(buildSoakCast(13, 's').agents).toHaveLength(13);
    const small = buildSoakCast(5, 's');
    expect(small.agents).toHaveLength(5);
    const names = new Set(small.agents.map((a) => a.name));
    expect(small.relationships.every((r) => names.has(r.agentAName) && names.has(r.agentBName))).toBe(true);
  });

  it('grows to 32 with unique names, at most two per home, real workplaces, deterministically', () => {
    const cast = buildSoakCast(32, 'seed-a');
    expect(cast.agents).toHaveLength(32);
    expect(new Set(cast.agents.map((a) => a.name)).size).toBe(32);
    const perHome = new Map<string, number>();
    for (const a of cast.agents) perHome.set(a.homeName, (perHome.get(a.homeName) ?? 0) + 1);
    expect(Math.max(...perHome.values())).toBeLessThanOrEqual(2);
    const defaultWorkplaces = new Set(buildSoakCast(13, 'x').agents.map((a) => a.workplaceName));
    for (const a of cast.agents.slice(13)) expect(defaultWorkplaces.has(a.workplaceName)).toBe(true);
    expect(buildSoakCast(32, 'seed-a')).toEqual(cast);
    expect(buildSoakCast(32, 'seed-b').agents[20].name).not.toBe(cast.agents[20].name);
  });

  it('rejects sizes outside 2..32', () => {
    expect(() => buildSoakCast(1, 's')).toThrow(/2 to 32/);
    expect(() => buildSoakCast(33, 's')).toThrow(/2 to 32/);
    expect(() => buildSoakCast(12.5, 's')).toThrow();
  });
});
