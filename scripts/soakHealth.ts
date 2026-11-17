/**
 * Story-health metrics for `scripts/soak.ts`: what a long run says about whether the town
 * stays interesting, not just solvent.
 *
 * The economy soak (7 days, 13 residents) answered "does the money loop hold". A player
 * watches for weeks, so the questions here are the long-run ones: do the story beats dry up
 * (stagnation), do residents die off or go broke (collapse), does every pair end up friends
 * (saturation), and which tick phase grows with the cast (scale).
 *
 * Split in two on purpose. The pure half (`percentile`, `evaluateHealthWarnings`,
 * `formatHealthTable`) takes plain numbers and is unit-tested. `createHealthTracker` reads
 * the database, and receives the sqlite handle and the chronicle from the caller instead of
 * importing them: the soak must point DATABASE_PATH at its temp file before any `server/db`
 * module loads, so nothing here may import one.
 *
 * Every counter is a DAILY DELTA between two snapshots (ids seen, statuses, public secrets),
 * not a sum of events, so a relationship that flips friends -> partners -> friends inside one
 * day reads as no change. The soak wants the day's net movement of the town, and snapshots
 * cost one query each instead of a listener in every phase.
 */
import type { TickTiming } from '../server/engine/tick';
import type { StoryArc } from '../server/lib/chronicle';

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Nearest-rank percentile (p in 0..100) of an unsorted list; 0 for an empty one. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export interface PhaseStat { p50: number; p95: number; mean: number }

/** Bucket name for everything a tick does outside its eleven phases (perception, tavern, milestones, day-change work). */
export const POST_PHASES = 'other';

/** The metrics of one game day. Everything here is JSON-serialisable (`--json`). */
export interface DayHealth {
  day: number;
  /** Residents alive at the end of the day / at the start of the run. */
  population: number;
  startPopulation: number;
  /** Count of `metadata.beat` drama rows by beat, today. */
  beats: Record<string, number>;
  /** Beat types seen for the first time today, and how many distinct ones the run has seen so far. */
  newBeats: string[];
  beatsSeenTotal: number;
  /** Distinct activity `type`s logged at importance >= 0.6 today: the wider vocabulary the beat tag does not cover (proposals, goals, interactions...). */
  storyTypes: number;
  /** Net relationship status changes today, and the top `from>to` flows. */
  statusChanges: number;
  statusFlows: Record<string, number>;
  /** New shared_knowledge rows today / of which sensitivity >= 2 (secrets, not sightings) / crossed into common knowledge. */
  factsCreated: number;
  secretsCreated: number;
  secretsPublic: number;
  goalsCompleted: number;
  goalsAbandoned: number;
  proposals: number;
  engagements: number;
  rejections: number;
  weddings: number;
  engagementsEnded: number;
  deaths: number;
  arrivals: number;
  departures: number;
  /** Living residents with no importance >= 0.6 row involving them today (and the same without `interaction_resolved`). */
  invisible: number;
  invisibleNames: string[];
  invisibleStrict: number;
  /** `detectStoryArcs()` (capped at 12 by the chronicle), how many are hot (heat >= 0.25), by kind. */
  arcs: number;
  arcsHot: number;
  arcKinds: Record<string, number>;
  /** Share of living pairs whose friendship is >= 60 in BOTH directions; and the mean of both directions over pairs with a row. */
  friendShare: number;
  meanFriendship: number;
  pairsWithRow: number;
  /** Relationship status mix at the end of the day. */
  statusMix: Record<string, number>;
  /** Mean of the residents' `needs.mood` over the day's ticks. */
  mood: number;
  /**
   * Standard deviation of the same readings (every resident, every tick): how far the town's
   * moods spread. A town where everyone sits at 91 all day reads near 0 — the stagnation the
   * mean alone can't show.
   */
  moodStd: number;
  /** `arrest` beats today (also in `beats`; broken out because a serial-arrest loop is a failure mode). */
  arrests: number;
  /**
   * Social calls today (server/lib/socialCalls), by the feed row's beat: one `social_call` row
   * per visit made, plus the loan repaid / gone sour and the birthday nobody marked. Also in
   * `beats`; broken out because the calls must not flood (a handful a day in a small town).
   */
  calls: Record<string, number>;
  /** Whole-tick and per-phase wall time in ms. */
  tick: PhaseStat & { max: number; ticks: number };
  phases: Record<string, PhaseStat>;
}

export interface HealthWarningContext {
  tickIntervalMs: number;
  tickSpeed: number;
}

/**
 * Turn the daily rows into human warnings. A warning names the day it fired and the number
 * behind it, so a reader of a 30-day table can jump straight to the row.
 *
 * Thresholds (from the soak brief): no new beat type in 3 days, >= 40% of residents
 * invisible in a day, population under 60% of the start, tick p95 above the tick interval,
 * >= 70% of pairs friends, money-supply ratio drifting.
 */
export function evaluateHealthWarnings(
  days: readonly DayHealth[],
  ctx: HealthWarningContext,
  ratios: ReadonlyArray<{ day: number; ratio: number }> = [],
): string[] {
  const out: string[] = [];
  let dry = 0;
  for (const d of days) {
    // A dry spell is reported when it reaches 3 days and again every week it lasts, not on
    // every day of it: a town that ran out of beats on day 9 would otherwise print 20 lines.
    dry = d.newBeats.length === 0 ? dry + 1 : 0;
    if (dry === 3 || (dry > 3 && dry % 7 === 0)) {
      out.push(`day ${d.day}: no new beat type for ${dry} days (${d.beatsSeenTotal} distinct seen so far)`);
    }
    const invisibleShare = d.population > 0 ? d.invisible / d.population : 0;
    if (invisibleShare >= 0.4) {
      out.push(`day ${d.day}: ${d.invisible}/${d.population} residents invisible (${Math.round(invisibleShare * 100)}%): `
        + `${d.invisibleNames.slice(0, 6).join(', ')}${d.invisibleNames.length > 6 ? ', ...' : ''}`);
    }
    if (d.startPopulation > 0 && d.population < 0.6 * d.startPopulation) {
      out.push(`day ${d.day}: population ${d.population} is under 60% of the starting ${d.startPopulation}`);
    }
    if (d.tick.ticks > 0 && d.tick.p95 > ctx.tickIntervalMs) {
      out.push(`day ${d.day}: tick p95 ${d.tick.p95.toFixed(0)} ms is above the ${ctx.tickIntervalMs} ms tick interval `
        + `(the clock would fall behind at ${ctx.tickSpeed}x)`);
    }
    if (d.friendShare >= 0.7) {
      out.push(`day ${d.day}: relationships saturating: ${Math.round(d.friendShare * 100)}% of pairs are mutual friends`);
    }
  }
  // Money drift: compare the first and last stretch of the run rather than any single day
  // (the balancer legitimately swings a day's ratio); the per-day out-of-range flags stay in
  // the economy anomalies.
  if (ratios.length >= 8) {
    const mean = (rows: typeof ratios) => rows.reduce((s, r) => s + r.ratio, 0) / rows.length;
    const first = mean(ratios.slice(0, 4));
    const last = mean(ratios.slice(-4));
    if (Math.abs(last - first) > 0.3) {
      out.push(`money supply ratio drifted from ${first.toFixed(2)} (days ${ratios[0].day}-${ratios[3].day}) `
        + `to ${last.toFixed(2)} (days ${ratios[ratios.length - 4].day}-${ratios[ratios.length - 1].day})`);
    }
  }
  return out;
}

const pad = (v: string | number, n: number) => String(v).padStart(n);

/** The daily health table, one row per day. */
export function formatHealthTable(days: readonly DayHealth[]): string[] {
  const head = 'day | pop | beats new/kinds/all | story types | rel chg | facts/secr/public | goals ok/gave up | prop/eng/rej/wed | die/arr/dep | invisible | arcs (hot) | friends% | mood (sd) | arrests | tick p50/p95 ms';
  const rows = days.map((d) => [
    pad(d.day, 3),
    pad(d.population, 3),
    pad(`${d.newBeats.length}/${Object.keys(d.beats).length}/${d.beatsSeenTotal}`, 19),
    pad(d.storyTypes, 11),
    pad(d.statusChanges, 7),
    pad(`${d.factsCreated}/${d.secretsCreated}/${d.secretsPublic}`, 17),
    pad(`${d.goalsCompleted}/${d.goalsAbandoned}`, 15),
    pad(`${d.proposals}/${d.engagements}/${d.rejections}/${d.weddings}`, 17),
    pad(`${d.deaths}/${d.arrivals}/${d.departures}`, 11),
    pad(`${d.invisible} (${d.invisibleStrict})`, 9),
    pad(`${d.arcs} (${d.arcsHot})`, 10),
    pad(`${(100 * d.friendShare).toFixed(0)}%`, 8),
    pad(`${d.mood.toFixed(0)} (${d.moodStd.toFixed(0)})`, 9),
    pad(d.arrests, 7),
    pad(`${d.tick.p50.toFixed(0)}/${d.tick.p95.toFixed(0)}`, 14),
  ].join(' | '));
  return [head, head.replace(/[^|]/g, '-').replace(/\|/g, '+'), ...rows];
}

/**
 * Social calls per day by kind (feed beat), one column per beat the run saw, plus a
 * total column and a run-total row. Later passes (gatherings, factions) log their own
 * `social_call` beats and get columns here for free.
 */
export function formatCallsTable(days: readonly DayHealth[]): string[] {
  const kinds = [...new Set(days.flatMap((d) => Object.keys(d.calls ?? {})))].sort();
  if (kinds.length === 0) return ['(no social calls)'];
  const width = (k: string) => Math.max(k.length, 3);
  const head = ['day', ...kinds, 'total'].map((k, i) => (i === 0 ? pad(k, 3) : pad(k, width(k)))).join(' | ');
  const line = (label: string, get: (k: string) => number) => {
    const counts = kinds.map(get);
    return [pad(label, 3), ...kinds.map((k, i) => pad(counts[i], width(k))), pad(counts.reduce((s, n) => s + n, 0), 5)].join(' | ');
  };
  return [
    head,
    head.replace(/[^|]/g, '-').replace(/\|/g, '+'),
    ...days.map((d) => line(String(d.day), (k) => d.calls?.[k] ?? 0)),
    line('all', (k) => days.reduce((s, d) => s + (d.calls?.[k] ?? 0), 0)),
  ];
}

/** Run-level p50/p95/mean per phase over every tick of every day, plus each phase's share of the mean tick. */
export function summarizePhases(perTick: Record<string, readonly number[]>, totals: readonly number[]): Array<{ phase: string } & PhaseStat & { share: number }> {
  const meanTotal = totals.length ? totals.reduce((s, v) => s + v, 0) / totals.length : 0;
  return Object.entries(perTick)
    .map(([phase, values]) => {
      const mean = values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
      return { phase, p50: percentile(values, 50), p95: percentile(values, 95), mean, share: meanTotal > 0 ? mean / meanTotal : 0 };
    })
    .sort((a, b) => b.mean - a.mean);
}

// ─── The tracker (reads the database) ────────────────────────────────────────

/** Just the slice of better-sqlite3 the tracker uses, so tests can hand it a real in-memory database. */
export interface SqliteLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

export interface TrackerDeps {
  sqlite: SqliteLike;
  detectStoryArcs: () => StoryArc[];
  resetChronicleCache: () => void;
}

const BEAT_FLOOR = 0.6;
const HOT_ARC = 0.25;
const FRIEND_LEVEL = 60;

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

export function createHealthTracker(deps: TrackerDeps) {
  const { sqlite } = deps;
  // Raw SQL on purpose (the tracker also runs on a bare in-memory database in its tests),
  // so each call names the columns it selected: `all<{ id: number }>(...)`.
  const all = <Row>(sql: string, ...p: unknown[]) => sqlite.prepare(sql).all(...p) as Row[];
  const maxId = (table: string): number =>
    Number((sqlite.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number } | undefined)?.m ?? 0);

  const activeIds = () => new Set<number>(all<{ id: number }>('SELECT id FROM agents WHERE is_active = 1').map((r) => r.id));
  const statuses = () => new Map<string, string>(all<{ agent_a: number; agent_b: number; status: string }>('SELECT agent_a, agent_b, status FROM relationships')
    .map((r) => [pairKey(r.agent_a, r.agent_b), String(r.status)]));
  const publicFacts = () => new Set<number>(all<{ id: number }>('SELECT id FROM shared_knowledge WHERE is_public = 1').map((r) => r.id));
  const goalStates = () => new Map<number, string>(all<{ id: number; status: string }>('SELECT id, status FROM goals').map((r) => [r.id, String(r.status)]));

  const seenBeats = new Set<string>();
  let activeBefore = activeIds();
  const startPopulation = activeBefore.size;
  let statusBefore = statuses();
  let publicBefore = publicFacts();
  let goalsBefore = goalStates();
  let logMark = maxId('activity_log');
  let factMark = maxId('shared_knowledge');

  // Per-day tick buffers, and the same over the whole run.
  let dayTotals: number[] = [];
  let dayPhases: Record<string, number[]> = {};
  const runTotals: number[] = [];
  const runPhases: Record<string, number[]> = {};
  let moodSum = 0;
  let moodSq = 0;
  let moodN = 0;

  return {
    /** Feed one finished tick (from `setTickTimingObserver`). */
    recordTick(t: TickTiming): void {
      let phaseSum = 0;
      for (const [name, ms] of t.phaseMs) {
        (dayPhases[name] ??= []).push(ms);
        (runPhases[name] ??= []).push(ms);
        phaseSum += ms;
      }
      const rest = Math.max(0, t.totalMs - phaseSum);
      (dayPhases[POST_PHASES] ??= []).push(rest);
      (runPhases[POST_PHASES] ??= []).push(rest);
      dayTotals.push(t.totalMs);
      runTotals.push(t.totalMs);
    },

    /** Add one resident's mood reading (the soak already walks every resident's needs each tick). */
    sampleMood(mood: number): void { moodSum += mood; moodSq += mood * mood; moodN++; },

    startPopulation: () => startPopulation,
    runPhaseSummary: () => summarizePhases(runPhases, runTotals),
    runTickSummary: () => ({ p50: percentile(runTotals, 50), p95: percentile(runTotals, 95), max: Math.max(0, ...runTotals), ticks: runTotals.length }),

    /** Close the day: diff every snapshot against the previous one and roll them forward. */
    endDay(day: number): DayHealth {
      const activeNow = activeIds();
      const nameOf = new Map<number, string>(all<{ id: number; name: string }>('SELECT id, name FROM agents').map((r) => [r.id, String(r.name)]));

      // ── The day's activity rows ──
      const rows = all<{
        type: string; importance: number; initiator_id: number | null; target_id: number | null;
        agent_ids: string | null; metadata: string | null;
      }>('SELECT type, importance, initiator_id, target_id, agent_ids, metadata FROM activity_log WHERE id > ?', logMark);
      logMark = maxId('activity_log');
      const beats: Record<string, number> = {};
      const storyTypes = new Set<string>();
      const seen = new Set<number>();
      const seenStrict = new Set<number>();
      const count = { proposal: 0, engagement: 0, rejection: 0, wedding: 0, engagement_ended: 0 } as Record<string, number>;
      let deaths = 0;
      const calls: Record<string, number> = {};
      for (const r of rows) {
        if (r.type in count) count[r.type]++;
        let beat: unknown;
        try { beat = r.metadata ? JSON.parse(r.metadata)?.beat : undefined; } catch { /* malformed metadata is not a beat */ }
        if (typeof beat === 'string') {
          beats[beat] = (beats[beat] ?? 0) + 1;
          if (beat === 'death') deaths++;
          if (r.type === 'social_call') calls[beat] = (calls[beat] ?? 0) + 1;
        }
        if (r.importance < BEAT_FLOOR) continue;
        storyTypes.add(r.type);
        let ids: number[] = [];
        try { ids = JSON.parse(r.agent_ids ?? '[]'); } catch { /* ignore */ }
        for (const id of [r.initiator_id, r.target_id, ...ids]) {
          if (typeof id !== 'number') continue;
          seen.add(id);
          if (r.type !== 'interaction_resolved') seenStrict.add(id);
        }
      }
      const newBeats = Object.keys(beats).filter((b) => !seenBeats.has(b)).sort();
      for (const b of Object.keys(beats)) seenBeats.add(b);

      // ── Relationships ──
      const statusNow = statuses();
      const flows: Record<string, number> = {};
      let statusChanges = 0;
      for (const [key, status] of statusNow) {
        const before = statusBefore.get(key);
        if (before !== undefined && before !== status) {
          statusChanges++;
          flows[`${before}>${status}`] = (flows[`${before}>${status}`] ?? 0) + 1;
        }
      }
      statusBefore = statusNow;
      const statusMix: Record<string, number> = {};
      const friendRows = all<{ agent_a: number; agent_b: number; friendship_ab: number; friendship_ba: number; status: string }>(
        'SELECT agent_a, agent_b, friendship_ab, friendship_ba, status FROM relationships',
      )
        .filter((r) => activeNow.has(r.agent_a) && activeNow.has(r.agent_b));
      let mutualFriends = 0;
      let friendSum = 0;
      for (const r of friendRows) {
        statusMix[r.status] = (statusMix[r.status] ?? 0) + 1;
        if (r.friendship_ab >= FRIEND_LEVEL && r.friendship_ba >= FRIEND_LEVEL) mutualFriends++;
        friendSum += (r.friendship_ab + r.friendship_ba) / 2;
      }
      // Denominator: every living pair, so a pair that never met counts as "not friends".
      const pairs = (activeNow.size * (activeNow.size - 1)) / 2;

      // ── Knowledge ──
      const newFacts = all<{ sensitivity: number }>('SELECT sensitivity FROM shared_knowledge WHERE id > ?', factMark);
      factMark = maxId('shared_knowledge');
      const publicNow = publicFacts();
      const madePublic = [...publicNow].filter((id) => !publicBefore.has(id)).length;
      publicBefore = publicNow;

      // ── Goals ──
      const goalsNow = goalStates();
      let completed = 0;
      let abandoned = 0;
      for (const [id, status] of goalsNow) {
        if (goalsBefore.get(id) === status) continue;
        if (status === 'completed') completed++;
        else if (status === 'abandoned') abandoned++;
      }
      goalsBefore = goalsNow;

      // ── Who is missing from the story, and the arcs ──
      const invisible = [...activeNow].filter((id) => !seen.has(id));
      const invisibleStrict = [...activeNow].filter((id) => !seenStrict.has(id));
      deps.resetChronicleCache();
      const arcs = deps.detectStoryArcs();
      const arcKinds: Record<string, number> = {};
      for (const a of arcs) arcKinds[a.kind] = (arcKinds[a.kind] ?? 0) + 1;

      const departedNow = [...activeBefore].filter((id) => !activeNow.has(id)).length;
      const arrivals = [...activeNow].filter((id) => !activeBefore.has(id)).length;
      activeBefore = activeNow;

      const phases: Record<string, PhaseStat> = {};
      for (const [name, values] of Object.entries(dayPhases)) {
        phases[name] = { p50: percentile(values, 50), p95: percentile(values, 95), mean: values.reduce((s, v) => s + v, 0) / Math.max(1, values.length) };
      }
      const health: DayHealth = {
        day,
        population: activeNow.size,
        startPopulation,
        beats,
        newBeats,
        beatsSeenTotal: seenBeats.size,
        storyTypes: storyTypes.size,
        statusChanges,
        statusFlows: flows,
        factsCreated: newFacts.length,
        secretsCreated: newFacts.filter((f) => f.sensitivity >= 2).length,
        secretsPublic: madePublic,
        goalsCompleted: completed,
        goalsAbandoned: abandoned,
        proposals: count.proposal,
        engagements: count.engagement,
        rejections: count.rejection,
        weddings: count.wedding,
        engagementsEnded: count.engagement_ended,
        deaths,
        arrivals,
        // A death is a departure too; only report the ones that were not deaths.
        departures: Math.max(0, departedNow - deaths),
        invisible: invisible.length,
        invisibleNames: invisible.map((id) => nameOf.get(id) ?? String(id)),
        invisibleStrict: invisibleStrict.length,
        arcs: arcs.length,
        arcsHot: arcs.filter((a) => a.heat >= HOT_ARC).length,
        arcKinds,
        friendShare: pairs > 0 ? mutualFriends / pairs : 0,
        meanFriendship: friendRows.length ? friendSum / friendRows.length : 0,
        pairsWithRow: friendRows.length,
        statusMix,
        mood: moodN ? moodSum / moodN : 0,
        moodStd: moodN ? Math.sqrt(Math.max(0, moodSq / moodN - (moodSum / moodN) ** 2)) : 0,
        arrests: beats.arrest ?? 0,
        calls,
        tick: {
          p50: percentile(dayTotals, 50),
          p95: percentile(dayTotals, 95),
          mean: dayTotals.reduce((s, v) => s + v, 0) / Math.max(1, dayTotals.length),
          max: Math.max(0, ...dayTotals),
          ticks: dayTotals.length,
        },
        phases,
      };
      dayTotals = [];
      dayPhases = {};
      moodSum = 0;
      moodSq = 0;
      moodN = 0;
      return health;
    },
  };
}
