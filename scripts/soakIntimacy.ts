/**
 * Intimacy section of the soak (`npm run soak -- --adult`): what the adult layer did per game day, and
 * the one check that must never fail — nobody under 18 anywhere in it.
 *
 * Read-only SQL over the soak's throwaway database. Per-day rows are the rows created since the previous
 * `endDay` (max-id marks, like the soak's own economy tally), so they do not depend on which clock a table
 * stamps. The minors check joins every place an intimacy fact can name a person (feed rows, pair events,
 * shared facts as subject / target / knower, agent states, relationships, the checkpointed in-memory pair
 * and longing state) against `agents.age < 18` and returns the offending rows (empty = clean).
 */
import type Database from 'better-sqlite3';

/** Relationship events that are intimacy: kisses (PG), rebuffs, nights together, and a partner's doubt. */
const PAIR_EVENT_TYPES = ['first_kiss', 'kiss', 'kiss_rebuffed', 'first_tryst', 'tryst'] as const;
/** Feed rows the layer writes. */
const FEED_TYPES = ['first_kiss', 'kiss', 'kiss_rebuffed', 'tryst', 'caught', 'suspicion', 'scandal'] as const;
/** Shared-knowledge types the layer creates (`affair` is also born from acts). */
const FACT_TYPES = ['kiss_seen', 'tryst_seen', 'affair', 'illegitimate_pregnancy'] as const;
/** Agent states the layer sets. */
const STATE_TYPES = ['afterglow', 'guilty', 'suspicious', 'infatuated'] as const;

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');

export interface IntimacyDay {
  day: number;
  kisses: number;
  firstKisses: number;
  rebuffs: number;
  trysts: number;
  caught: number;
  suspicions: number;
  scandals: number;
  facts: Record<string, number>;
}

export interface MinorsFinding {
  source: string;
  rows: unknown[];
}

export function createIntimacyTally(sqlite: Database.Database) {
  const maxId = (table: string) => Number((sqlite.prepare(`select coalesce(max(id),0) m from ${table}`).get() as { m: number }).m);
  let evMark = maxId('relationship_events');
  let logMark = maxId('activity_log');
  let factMark = maxId('shared_knowledge');
  const days: IntimacyDay[] = [];

  const count = (sql: string, ...params: unknown[]) => Number((sqlite.prepare(sql).get(...params) as { c: number }).c);

  return {
    /** Close the game day just simulated. */
    endDay(day: number): void {
      const events = (types: string[]) => count(
        `select count(*) c from relationship_events where id > ? and event_type in (${list(types)})`, evMark);
      const feed = (types: string[]) => count(
        `select count(*) c from activity_log where id > ? and type in (${list(types)})`, logMark);
      const facts: Record<string, number> = {};
      for (const t of FACT_TYPES) facts[t] = count('select count(*) c from shared_knowledge where id > ? and type = ?', factMark, t);
      days.push({
        day,
        kisses: events(['first_kiss', 'kiss']),
        firstKisses: events(['first_kiss']),
        rebuffs: events(['kiss_rebuffed']),
        trysts: events(['first_tryst', 'tryst']),
        caught: feed(['caught']),
        suspicions: feed(['suspicion']),
        scandals: feed(['scandal']),
        facts,
      });
      evMark = maxId('relationship_events');
      logMark = maxId('activity_log');
      factMark = maxId('shared_knowledge');
    },
    days,
  };
}

/** Every row that puts a minor into the adult layer. Empty = clean. */
export function findMinorsInIntimacy(sqlite: Database.Database): MinorsFinding[] {
  const q = (sql: string) => sqlite.prepare(sql).all();
  const minors = 'select id from agents where age < 18';
  const findings: MinorsFinding[] = [
    {
      source: 'relationship_events (agent_a / agent_b)',
      rows: q(`select id, event_type, agent_a, agent_b from relationship_events
               where event_type in (${list(PAIR_EVENT_TYPES)}) and (agent_a in (${minors}) or agent_b in (${minors}))`),
    },
    {
      source: 'activity_log (initiator / target / agent_ids)',
      rows: q(`select l.id, l.type from activity_log l
               where l.type in (${list(FEED_TYPES)})
                 and (l.initiator_id in (${minors}) or l.target_id in (${minors})
                      or exists (select 1 from json_each(l.agent_ids) j where j.value in (${minors})))`),
    },
    {
      source: 'shared_knowledge (subject / target / known_by)',
      rows: q(`select k.id, k.type from shared_knowledge k
               where k.type in (${list(FACT_TYPES)})
                 and (k.subject_id in (${minors}) or k.target_id in (${minors})
                      or exists (select 1 from json_each(k.known_by) j where j.value in (${minors})))`),
    },
    {
      source: 'agent_states (holder / target)',
      rows: q(`select id, type, agent_id, target_agent_id from agent_states
               where type in (${list(STATE_TYPES)}) and (agent_id in (${minors}) or target_agent_id in (${minors}))`),
    },
    {
      source: 'relationships (kissed / lovers tag, or romance, with a minor)',
      rows: q(`select r.id, r.agent_a, r.agent_b from relationships r
               where (r.agent_a in (${minors}) or r.agent_b in (${minors}))
                 and (r.romance_ab > 0 or r.romance_ba > 0
                      or exists (select 1 from json_each(r.tags) j where j.value in ('kissed','lovers')))`),
    },
  ];

  // The checkpointed in-memory state: pairs that kissed or spent a night, and any longing at all.
  const snap = sqlite.prepare("select data from sim_snapshots where key = 'intimacy'").get() as { data: string } | undefined;
  const minorIds = new Set((q(minors) as Array<{ id: number }>).map((r) => r.id));
  const snapRows: unknown[] = [];
  if (snap) {
    try {
      const s = JSON.parse(snap.data) as {
        pairs?: Record<string, { kisses?: number; trysts?: number }>;
        agents?: Record<string, { longing?: number }>;
      };
      for (const [key, p] of Object.entries(s.pairs ?? {})) {
        const [x, y] = key.split('-').map(Number);
        if ((minorIds.has(x) || minorIds.has(y)) && ((p.kisses ?? 0) > 0 || (p.trysts ?? 0) > 0)) snapRows.push({ pair: key, ...p });
      }
      for (const [id, a] of Object.entries(s.agents ?? {})) {
        if (minorIds.has(Number(id)) && (a.longing ?? 0) > 0) snapRows.push({ agent: id, longing: a.longing });
      }
    } catch { /* an unreadable checkpoint has nothing to check */ }
  }
  findings.push({ source: 'sim_snapshots.intimacy (pairs / longing)', rows: snapRows });
  return findings;
}

export function formatIntimacyReport(days: readonly IntimacyDay[], findings: readonly MinorsFinding[], minors: number): string[] {
  const out: string[] = [];
  out.push('Intimacy per game day (adult layer). kisses (of them first) / rebuffs / trysts / caught / suspicion rows / scandals; facts: kiss_seen tryst_seen affair unwed_preg');
  out.push('day | kisses (1st) | rebuffs | trysts | caught | suspicion | scandal | kiss_seen | tryst_seen | affair | unwed_preg');
  out.push('----+--------------+---------+--------+--------+-----------+---------+-----------+------------+--------+-----------');
  for (const d of days) {
    out.push(`${String(d.day).padStart(3)} | ${`${d.kisses} (${d.firstKisses})`.padStart(12)} | ${String(d.rebuffs).padStart(7)} | ${String(d.trysts).padStart(6)} | ${String(d.caught).padStart(6)} | ${String(d.suspicions).padStart(9)} | ${String(d.scandals).padStart(7)} | ${String(d.facts.kiss_seen).padStart(9)} | ${String(d.facts.tryst_seen).padStart(10)} | ${String(d.facts.affair).padStart(6)} | ${String(d.facts.illegitimate_pregnancy).padStart(10)}`);
  }
  out.push('');
  const bad = findings.filter((f) => f.rows.length > 0);
  out.push(`Minors check (${minors} resident(s) under 18 in this town): ${bad.length === 0 ? 'CLEAN, 0 rows in any source' : `VIOLATION in ${bad.length} source(s)`}`);
  for (const f of findings) out.push(`  ${f.rows.length === 0 ? 'ok  ' : 'FAIL'} ${f.source}: ${f.rows.length} row(s)${f.rows.length ? ` ${JSON.stringify(f.rows.slice(0, 5))}` : ''}`);
  return out;
}
