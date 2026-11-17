/**
 * Headless tick profiler: build a throwaway world, run N ticks back-to-back and
 * report, per tick slice (each of the 11 phases, the bookkeeping between them,
 * and everything after the phase loop), wall time p50/p95/max and how many SQL
 * statements it executed.
 *
 *   npx tsx scripts/tick-profile.ts                         # 720 ticks at 4x (2 game days), seed "soak"
 *   npx tsx scripts/tick-profile.ts --ticks 1440 --tick-speed 1
 *   npx tsx scripts/tick-profile.ts --warmup 120 --seed abc
 *   npx tsx scripts/tick-profile.ts --db data/verify.db     # profile a COPY of a save
 *   npx tsx scripts/tick-profile.ts --top 15                # also list the hottest SQL
 *   npx tsx scripts/tick-profile.ts --json out.json         # machine-readable summary
 *
 * The world is built the way scripts/soak.ts builds it (the wizard's defaults via
 * setup.initialize), on a temp DB under the OS temp dir; the live world is never
 * opened. The LLM is off the same way too: `fetch` throws before any server
 * module loads, and queued conversations are forced onto the template tier after
 * every tick so the conversations phase does real (model-free) work instead of
 * failing its first turn.
 *
 * SQL counting: better-sqlite3's Statement prototype is patched before
 * server/db is imported, so every execution is counted — drizzle queries (which
 * prepare a fresh statement per call; `prepare` is counted separately because it
 * is a real SQLite compile each time) and raw module-level prepared statements
 * alike. Each count goes to whichever slice `setPhaseProbe` announced last.
 *
 * Numbers are for comparing before/after on the same machine and seed: absolute
 * milliseconds move with the CPU, statement counts do not (for a given seed and
 * tick count the simulation is deterministic apart from Math.random use).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// ─── Args ─────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TICKS = Number(arg('ticks') ?? 720);
const WARMUP = Number(arg('warmup') ?? 60);
const TICK_SPEED = Number(arg('tick-speed') ?? 4);
const SEED = arg('seed') ?? 'soak';
const SOURCE_DB = arg('db');
const TOP = Number(arg('top') ?? 0);
const JSON_OUT = arg('json');

// ─── Throwaway database (same rules as soak.ts) ───────────────────────────────

const LIVE_DB = path.resolve('data/little-life.db');
const tmpDb = path.join(os.tmpdir(), `little-life-profile-${process.pid}.db`);

if (SOURCE_DB) {
  const src = path.resolve(SOURCE_DB);
  if (src.toLowerCase() === LIVE_DB.toLowerCase()) {
    console.error('Refusing to profile data/little-life.db (the live world). Copy it to data/verify.db first.');
    process.exit(1);
  }
  if (!fs.existsSync(src)) { console.error(`No such database: ${src}`); process.exit(1); }
  fs.copyFileSync(src, tmpDb);
  for (const sfx of ['-wal', '-shm']) {
    if (fs.existsSync(src + sfx)) fs.copyFileSync(src + sfx, tmpDb + sfx);
  }
}
// No source DB: server/db builds the empty file from the migration chain on import.
process.env.DATABASE_PATH = tmpDb;
process.env.AUTOSAVE = '0';

globalThis.fetch = (async () => {
  throw new TypeError('fetch failed (tick-profile: LLM disabled)');
}) as typeof fetch;

// Server logs are noise here; keep only this script's output.
const realLog = console.log;
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[level] = () => {};
}
const out = (...args: unknown[]) => realLog(...args);

// ─── SQL counters ─────────────────────────────────────────────────────────────

let slice = 'setup';
let counting = false;
type SliceStats = { stmts: number; prepares: number; sqlMs: number; bySql: Map<string, number> };
const sqlBySlice = new Map<string, SliceStats>();
const statsFor = (s: string): SliceStats => {
  let st = sqlBySlice.get(s);
  if (!st) { st = { stmts: 0, prepares: 0, sqlMs: 0, bySql: new Map() }; sqlBySlice.set(s, st); }
  return st;
};

{
  // Patch the prototypes, not one connection: server/db opens its own, and
  // several modules prepare statements once at import.
  const probeDb = new Database(':memory:');
  const stmtProto = Object.getPrototypeOf(probeDb.prepare('SELECT 1'));
  probeDb.close();
  for (const method of ['run', 'get', 'all', 'iterate'] as const) {
    const original = stmtProto[method];
    stmtProto[method] = function (this: { source: string }, ...args: unknown[]) {
      if (!counting) return original.apply(this, args);
      const st = statsFor(slice);
      st.stmts++;
      if (TOP) {
        const key = this.source.replace(/\s+/g, ' ').slice(0, 140);
        st.bySql.set(key, (st.bySql.get(key) ?? 0) + 1);
      }
      // SQLite time only (drizzle's row mapping and JSON parsing happen after
      // this returns, so they land in the slice's JS time).
      const t = performance.now();
      try { return original.apply(this, args); } finally { st.sqlMs += performance.now() - t; }
    };
  }
  const dbProto = Database.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const originalPrepare = dbProto.prepare;
  dbProto.prepare = function (this: unknown, ...args: unknown[]) {
    if (!counting) return originalPrepare.apply(this, args);
    const st = statsFor(slice);
    st.prepares++;
    const t = performance.now();
    try { return originalPrepare.apply(this, args); } finally { st.sqlMs += performance.now() - t; }
  };
}

// ─── Run ──────────────────────────────────────────────────────────────────────

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

async function main(): Promise<void> {
  const { db, sqlite } = await import('../server/db');
  const schema = await import('../server/db/schema');
  const { eq, ne } = await import('drizzle-orm');
  const { gameTick, stopTickLoopAndWait, setPhaseProbe } = await import('../server/engine/tick');
  // The listeners server/index.ts wires at boot. soak.ts skips most of them
  // (its concern is the economy), but without initCascade the cascade phase
  // returns on its first line and without the memory observer / plan adapter /
  // favor / drift listeners every phase that emits simEvents looks cheaper than
  // it is on a real server.
  await import('../server/lib/giftEngine');
  await import('../server/lib/secretSharing');
  await import('../server/lib/playerOutcomes');
  const { memoryService } = await import('../server/lib/memory/instance');
  (await import('../server/lib/memory/MemoryObserver')).initMemoryObserver(memoryService);
  (await import('../server/lib/agingEngine')).initBirthdays();
  (await import('../server/lib/personalityDrift')).initPersonalityDrift();
  (await import('../server/lib/favorEngine')).initFavorTracking();
  (await import('../server/lib/planning/PlanEventAdapter')).initPlanEventAdapter();
  (await import('../server/lib/cascade')).initCascade();
  const { worldState, conversationQueue } = schema;

  if (!SOURCE_DB) {
    const { getDefaultAgents, getDefaultRelationships } = await import('../src/components/setup/defaults');
    const { DEFAULT_WORLD, DEFAULT_RULES, DEFAULT_WORLDGEN, DEFAULT_PRESET } = await import('../src/components/setup/types');
    const { setupRouter } = await import('../server/routers/setup');
    await setupRouter.createCaller({}).initialize({
      agents: getDefaultAgents(),
      relationships: getDefaultRelationships(),
      world: DEFAULT_WORLD,
      rules: DEFAULT_RULES,
      scenario: { ...DEFAULT_PRESET.values, seed: SEED },
      worldgen: { ...DEFAULT_WORLDGEN, seed: SEED },
    });
    await stopTickLoopAndWait();
  } else {
    // A save carries positions but the zone occupancy singleton is in-memory
    // (server/index.ts rebuilds it at boot the same way).
    const { reconstructZoneOccupancy } = await import('../server/lib/interiorGrid');
    reconstructZoneOccupancy(
      db.select({ id: schema.agents.id, current_location: schema.agents.current_location, position: schema.agents.position }).from(schema.agents).all(),
      db.select({ id: schema.locations.id, type: schema.locations.type, position: schema.locations.position }).from(schema.locations).all(),
    );
  }

  const world0 = db.select().from(worldState).get();
  if (!world0) throw new Error('No world in the database');
  db.update(worldState).set({ is_paused: false, tick_speed: TICK_SPEED }).where(eq(worldState.id, world0.id)).run();
  const forceTemplateTier = () => {
    db.update(conversationQueue).set({ tier: 'template' }).where(ne(conversationQueue.tier, 'template')).run();
  };

  // Per tick: ms and statement count per slice.
  const msSamples = new Map<string, number[]>();
  const stmtSamples = new Map<string, number[]>();
  const tickMs: number[] = [];
  const tickStmts: number[] = [];

  let sliceStart = 0;
  let tickSliceMs = new Map<string, number>();
  const enter = (next: string) => {
    const now = performance.now();
    tickSliceMs.set(slice, (tickSliceMs.get(slice) ?? 0) + (now - sliceStart));
    slice = next;
    sliceStart = now;
  };
  setPhaseProbe(enter);

  out(`tick-profile: ${WARMUP} warmup + ${TICKS} measured ticks at tick_speed ${TICK_SPEED}, `
    + `${SOURCE_DB ? `copy of ${SOURCE_DB}` : `fresh world seed "${SEED}"`}`);

  for (let i = 0; i < WARMUP + TICKS; i++) {
    const measuring = i >= WARMUP;
    const before = new Map([...sqlBySlice].map(([k, v]) => [k, v.stmts]));
    counting = measuring;
    tickSliceMs = new Map();
    slice = 'pre';
    sliceStart = performance.now();
    const t0 = sliceStart;
    await gameTick();
    enter('idle');
    const total = performance.now() - t0;
    counting = false;
    forceTemplateTier();
    if (measuring) {
      tickMs.push(total);
      let stmtsThisTick = 0;
      const seen = new Set<string>([...tickSliceMs.keys(), ...sqlBySlice.keys()]);
      for (const s of seen) {
        if (s === 'idle' || s === 'setup') continue;
        const ms = tickSliceMs.get(s) ?? 0;
        const n = (sqlBySlice.get(s)?.stmts ?? 0) - (before.get(s) ?? 0);
        stmtsThisTick += n;
        if (!msSamples.has(s)) { msSamples.set(s, []); stmtSamples.set(s, []); }
        msSamples.get(s)!.push(ms);
        stmtSamples.get(s)!.push(n);
      }
      tickStmts.push(stmtsThisTick);
    }
    // Let rejected LLM promises and task-runner work settle, like soak.ts.
    if (i % 20 === 0) await new Promise((r) => setImmediate(r));
  }
  setPhaseProbe(null);

  const order = ['pre', 'needs', 'states', 'economy', 'relationships', 'conversations', 'goals',
    'decisions', 'movement', 'events', 'gossip', 'cascade', 'overhead', 'post'];
  const rows = [...msSamples.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const fmt = (n: number, w = 7, d = 2) => n.toFixed(d).padStart(w);
  const summary: Record<string, unknown> = {};
  out('');
  // "sql ms" = mean time per tick inside SQLite (prepare + step), the rest of
  // the slice's mean is JS: drizzle query building, row mapping, sim logic.
  out('slice          |  p50 ms |  p95 ms |  max ms | mean ms | sql ms | SQL/tick | prepares/tick');
  out('---------------+---------+---------+---------+---------+--------+----------+--------------');
  for (const s of rows) {
    const ms = [...msSamples.get(s)!].sort((a, b) => a - b);
    const mean = ms.reduce((x, y) => x + y, 0) / ms.length;
    const stmts = stmtSamples.get(s)!.reduce((x, y) => x + y, 0) / TICKS;
    const prepares = (sqlBySlice.get(s)?.prepares ?? 0) / TICKS;
    const sqlMs = (sqlBySlice.get(s)?.sqlMs ?? 0) / TICKS;
    summary[s] = { p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: ms[ms.length - 1], mean, sqlMs, sqlPerTick: stmts, preparesPerTick: prepares };
    out(`${s.padEnd(15)}|${fmt(pct(ms, 0.5))}  |${fmt(pct(ms, 0.95))}  |${fmt(ms[ms.length - 1])}  |${fmt(mean)}  |${fmt(sqlMs, 6)}  |${fmt(stmts, 9, 1)} |${fmt(prepares, 13, 1)}`);
  }
  const sortedTick = [...tickMs].sort((a, b) => a - b);
  const meanTick = tickMs.reduce((x, y) => x + y, 0) / tickMs.length;
  const meanStmts = tickStmts.reduce((x, y) => x + y, 0) / tickStmts.length;
  const totalSqlMs = [...sqlBySlice.entries()].filter(([k]) => k !== 'setup' && k !== 'idle')
    .reduce((sum, [, v]) => sum + v.sqlMs, 0) / TICKS;
  out('---------------+---------+---------+---------+---------+--------+----------+');
  out(`${'TICK'.padEnd(15)}|${fmt(pct(sortedTick, 0.5))}  |${fmt(pct(sortedTick, 0.95))}  |${fmt(sortedTick[sortedTick.length - 1])}  |${fmt(meanTick)}  |${fmt(totalSqlMs, 6)}  |${fmt(meanStmts, 9, 1)} |`);
  summary.TICK = { p50: pct(sortedTick, 0.5), p95: pct(sortedTick, 0.95), max: sortedTick[sortedTick.length - 1], mean: meanTick, sqlMs: totalSqlMs, sqlPerTick: meanStmts };

  if (TOP) {
    for (const s of rows) {
      const st = sqlBySlice.get(s);
      if (!st || st.bySql.size === 0) continue;
      out(`\n${s}: top ${TOP} statements (executions per tick)`);
      for (const [q, n] of [...st.bySql].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
        out(`  ${(n / TICKS).toFixed(1).padStart(7)}  ${q}`);
      }
    }
  }

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
  sqlite.close();
}

main()
  .catch((err) => {
    realLog('tick-profile failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const sfx of ['', '-wal', '-shm']) {
      try { fs.rmSync(tmpDb + sfx, { force: true }); } catch { /* still open on a crash path */ }
    }
    // Background task-runner / embedding timers would keep the process alive.
    process.exit();
  });
