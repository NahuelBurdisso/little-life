/**
 * Headless economy soak: run N game days as fast as the CPU allows against a
 * THROWAWAY database and print a daily economy summary with anomaly flags.
 *
 *   npm run soak                          # fresh 12-agent world, 5 days
 *   npm run soak -- --days 10 --seed abc  # deterministic worldgen seed
 *   npm run soak -- --db data/verify.db   # soak a COPY of an existing save
 *   npm run soak -- --tick-speed 5 --keep --verbose
 *
 * Safety: the database is always a temp file under the OS temp dir. `--db` is
 * copied, never opened; `data/little-life.db` (the live world) is refused
 * outright — copy it to data/verify.db first if you want to soak your world.
 *
 * LLM: `fetch` is replaced before any server module loads, so every chat and
 * embedding call fails at once like a refused connection. Conversations fall
 * back to the template tier and planning to routine plans — exactly what
 * happens when Ollama is down, minus the timeouts.
 *
 * Speed: ticks are driven back-to-back through `gameTick()` (exported for this
 * script), not the 1 s setTimeout loop.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// ─── Args ─────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const DAYS = Number(arg('days') ?? 5);
const SEED = arg('seed') ?? 'soak';
const TICK_SPEED = arg('tick-speed') ? Number(arg('tick-speed')) : undefined;
const SOURCE_DB = arg('db');
const KEEP = flag('keep');
const VERBOSE = flag('verbose');

// ─── Throwaway database ───────────────────────────────────────────────────────

const LIVE_DB = path.resolve('data/little-life.db');
const tmpDb = path.join(os.tmpdir(), `little-life-soak-${process.pid}.db`);

if (SOURCE_DB) {
  const src = path.resolve(SOURCE_DB);
  if (src.toLowerCase() === LIVE_DB.toLowerCase()) {
    console.error('Refusing to soak data/little-life.db (the live world). Copy it first:\n'
      + '  cp data/little-life.db data/verify.db && npm run soak -- --db data/verify.db');
    process.exit(1);
  }
  if (!fs.existsSync(src)) { console.error(`No such database: ${src}`); process.exit(1); }
  fs.copyFileSync(src, tmpDb);
  // A WAL-mode save keeps recent commits in -wal until checkpoint; without it
  // the copy is missing them.
  for (const sfx of ['-wal', '-shm']) {
    if (fs.existsSync(src + sfx)) fs.copyFileSync(src + sfx, tmpDb + sfx);
  }
} else {
  // Same schema path as the test suite (server/db/testSetup.ts): the migration
  // chain is stale, drizzle-kit push derives the tables from schema.ts.
  execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
    env: { ...process.env, DATABASE_PATH: tmpDb },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}
// server/db reads this once at import; every server import below is dynamic
// so it happens after this line. dotenv does not override an existing value.
process.env.DATABASE_PATH = tmpDb;

// ─── LLM off ──────────────────────────────────────────────────────────────────

globalThis.fetch = (async () => {
  throw new TypeError('fetch failed (soak: LLM disabled)');
}) as typeof fetch;

// ─── Quiet server logs, but keep a tally for the anomaly report ──────────────

const logTally = new Map<string, number>();
const realLog = console.log;
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (level === 'warn' || level === 'error') {
      // Digits normalised so "conversation 17" and "conversation 25" tally together.
      const key = `${level}: ${args.map(String).join(' ').replace(/\d+/g, '#').slice(0, 110)}`;
      logTally.set(key, (logTally.get(key) ?? 0) + 1);
    }
    if (VERBOSE) original(...args);
  };
}
const out = (...args: unknown[]) => realLog(...args);

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { db, sqlite } = await import('../server/db');
  const schema = await import('../server/db/schema');
  const { eq, gt, and, inArray, sql } = await import('drizzle-orm');
  const { gameTick, stopTickLoopAndWait } = await import('../server/engine/tick');
  const { CONFIG } = await import('../server/lib/constants');
  const { TRADE_RULES } = await import('../server/data/economyData');
  // Registers the gift / jealousy listeners the server gets from index.ts.
  await import('../server/lib/giftEngine');
  // Food made per day (farm output, bread, drinks): meals are real food now, so
  // supply is part of the economy picture.
  const { simEvents } = await import('../server/lib/simEvents');
  const produced = new Map<string, number>();
  simEvents.on('economy:production', (p: { item: string; quantity: number }) => {
    produced.set(p.item, (produced.get(p.item) ?? 0) + p.quantity);
  });

  const { worldState, agents, economy, economyTransactions, locations, activityLog, conversations, needs } = schema;

  if (!SOURCE_DB) {
    const { AGENT_SEEDS } = await import('../server/data/agents');
    const { setupRouter } = await import('../server/routers/setup');
    const seen = new Set<string>();
    const relationships: any[] = [];
    for (const s of AGENT_SEEDS) {
      for (const rel of s.initialRelationships) {
        const key = [s.name, rel.otherName].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        relationships.push({ agentAName: s.name, agentBName: rel.otherName, ...rel, otherName: undefined });
      }
    }
    await setupRouter.createCaller({} as any).initialize({
      agents: AGENT_SEEDS.map((s, i) => ({
        id: `agent-${i + 1}`, name: s.name, age: s.age, gender: s.gender, bio: s.bio,
        traits: s.traits, job: s.job, jobTitle: s.jobTitle, salary: s.salary,
        homeName: s.homeName, workplaceName: s.workplaceName, schedule: s.schedule,
        personality: s.personality, backstoryMemories: s.backstoryMemories,
      })),
      relationships,
      world: { season: 'spring', weather: 'sunny', startHour: 8, startDay: 1 },
      rules: {
        deathEnabled: true, sicknessRate: 'low', contagionRate: 'low',
        dramaIntensity: 'high', tickSpeed: 1, startingMoney: 50,
      },
      worldgen: { sizeTier: 'auto', overrides: {}, seed: SEED },
    } as any);
    // initialize restarts the real tick loop; this script drives ticks itself.
    await stopTickLoopAndWait();
  }

  const world0 = db.select().from(worldState).get();
  if (!world0) throw new Error('No world in the database');
  db.update(worldState)
    .set({ is_paused: false, ...(TICK_SPEED ? { tick_speed: TICK_SPEED } : {}) })
    .where(eq(worldState.id, world0.id)).run();
  const tickSpeed = TICK_SPEED ?? world0.tick_speed;
  const ticksPerDay = Math.ceil(1440 / tickSpeed);

  const maxId = (table: any) => Number(db.select({ m: sql<number>`coalesce(max(id), 0)` }).from(table).get()?.m ?? 0);
  let txMark = maxId(economyTransactions);
  let logMark = maxId(activityLog);
  let convoMark = maxId(conversations);

  out(`soak: ${DAYS} day(s), tick_speed ${tickSpeed}, ${ticksPerDay} ticks/day, db ${tmpDb}${SOURCE_DB ? ` (copy of ${SOURCE_DB})` : ` (fresh world, seed "${SEED}")`}`);
  out('');
  out('day | agents | $/capita | min$ | ratio | tax pool | salary | buys (n/$) | covers (n/$) | wholesale $ | gifts (n/$) | convos');
  out('----+--------+----------+------+-------+----------+--------+------------+--------------+-------------+-------------+-------');
  // Second table, printed after the run: needs and meals per day. Needs are
  // averaged over every agent-tick (time-weighted, not a daily snapshot), so a
  // town pinned at 100 and one that dips at lunch read differently.
  const needsRows: string[] = [];

  const anomalies: string[] = [];
  const t0 = performance.now();
  let ticks = 0;

  for (let d = 0; d < DAYS; d++) {
    const dayStart = db.select().from(worldState).get()!.time;
    const activeAtStart = new Set(db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all().map((a) => a.id));
    const locTypeById = new Map(db.select({ id: locations.id, type: locations.type }).from(locations).all().map((l) => [l.id, l.type]));
    const needSum = { hunger: 0, energy: 0, social: 0, fun: 0 };
    let needSamples = 0;
    let eatingSamples = 0;
    let minHunger = 100;
    const starving = new Set<number>(); // hunger < 15 at any tick of the day
    // One eating action = one meal, keyed like economy.ts keys a meal.
    const meals = new Map<string, 'home' | 'out' | 'other'>();
    for (let i = 0; i < ticksPerDay; i++) {
      await gameTick();
      ticks++;
      const rows = db.select({
        id: agents.id, home: agents.home, loc: agents.current_location,
        action: agents.current_action, started: agents.action_started,
      }).from(agents).where(eq(agents.is_active, true)).all();
      const needByAgent = new Map(db.select().from(needs).all().map((n) => [n.agent_id, n]));
      for (const r of rows) {
        const n = needByAgent.get(r.id);
        if (!n) continue;
        needSum.hunger += n.hunger; needSum.energy += n.energy; needSum.social += n.social; needSum.fun += n.fun;
        needSamples++;
        minHunger = Math.min(minHunger, n.hunger);
        if (n.hunger < 15) starving.add(r.id);
        if ((r.action as any)?.type === 'eating' && r.loc != null) {
          eatingSamples++;
          const where = r.loc === r.home ? 'home' : TRADE_RULES[locTypeById.get(r.loc) ?? ''] ? 'out' : 'other';
          meals.set(`${r.id}:${r.started}`, where);
        }
      }
      // Let rejected LLM promises and queued task-runner work settle between ticks.
      if (ticks % 20 === 0) await new Promise((r) => setImmediate(r));
    }

    // ── Daily summary ───────────────────────────────────────────────────────
    const world = db.select().from(worldState).get()!;
    const active = db.select().from(agents).where(eq(agents.is_active, true)).all();
    const nameOf = new Map(db.select({ id: agents.id, name: agents.name }).from(agents).all().map((a) => [a.id, a.name]));
    const allEcon = db.select().from(economy).all();
    const activeIds = new Set(active.map((a) => a.id));
    const activeEcon = allEcon.filter((e) => activeIds.has(e.agent_id));
    const totalMoney = allEcon.reduce((s, e) => s + e.money, 0);
    const perCapita = activeEcon.reduce((s, e) => s + e.money, 0) / Math.max(1, activeEcon.length);
    const minMoney = Math.min(...activeEcon.map((e) => e.money));
    // Same ratio economy.ts balances on at day change.
    const ratio = totalMoney / Math.max(1, active.length * CONFIG.ECONOMY.TARGET_PER_CAPITA_MONEY);

    const txs = db.select().from(economyTransactions).where(gt(economyTransactions.id, txMark)).all();
    txMark = maxId(economyTransactions);
    const sum = (rows: typeof txs) => rows.reduce((s, t) => s + t.amount, 0);
    const salary = txs.filter((t) => t.reason === 'salary');
    const buys = txs.filter((t) => t.reason.startsWith('purchase:'));
    const covers = txs.filter((t) => t.reason.startsWith('entertainment:'));
    const wholesale = txs.filter((t) => t.reason.startsWith('wholesale:'));
    const gifts = txs.filter((t) => ['gift', 'drunk_gift', 'euphoric_gift'].includes(t.reason));

    const errors = db.select().from(activityLog)
      .where(and(gt(activityLog.id, logMark), eq(activityLog.type, 'error'))).all();
    // Deaths log as 'drama' ("X has died. <cause>. The town mourns.").
    const deathCauses = db.select().from(activityLog)
      .where(and(gt(activityLog.id, logMark), eq(activityLog.type, 'drama'))).all()
      .map((r) => String((r.template_data as any)?.description ?? ''))
      .filter((d) => d.includes(' has died. '))
      .map((d) => d.replace(/ has died\. /, ': ').replace(/\. The town mourns\.$/, ''));
    logMark = maxId(activityLog);
    const convos = db.select({ n: sql<number>`count(*)` }).from(conversations)
      .where(and(gt(conversations.id, convoMark), inArray(conversations.status, ['ended', 'completed']))).get()?.n ?? 0;
    convoMark = maxId(conversations);

    const f = (n: number) => n.toFixed(0);
    const avg = (k: keyof typeof needSum) => f(needSum[k] / Math.max(1, needSamples));
    const mealCount = (w: string) => [...meals.values()].filter((v) => v === w).length;
    const died = [...activeAtStart].filter((id) => !active.some((a) => a.id === id));
    needsRows.push([
      String(dayStart.day).padStart(3),
      avg('hunger').padStart(6), avg('energy').padStart(6), avg('social').padStart(6), avg('fun').padStart(4),
      f(minHunger).padStart(5),
      String(starving.size).padStart(6),
      `${(100 * eatingSamples / Math.max(1, needSamples)).toFixed(1)}%`.padStart(7),
      `${mealCount('home')}/${mealCount('out')}/${mealCount('other')}`.padStart(15),
      String(died.length).padStart(6) + (died.length ? ` (${deathCauses.join('; ') || died.map((id) => nameOf.get(id)).join(', ')})` : ''),
    ].join(' | ') + `  | made: ${[...produced].map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
    produced.clear();
    out([
      String(dayStart.day).padStart(3),
      String(active.length).padStart(6),
      f(perCapita).padStart(8),
      f(minMoney).padStart(4),
      ratio.toFixed(2).padStart(5),
      f(world.tax_pool).padStart(8),
      f(sum(salary)).padStart(6),
      `${buys.length}/${f(sum(buys))}`.padStart(10),
      `${covers.length}/${f(sum(covers))}`.padStart(12),
      f(sum(wholesale)).padStart(11),
      `${gifts.length}/${f(sum(gifts))}`.padStart(11),
      String(convos).padStart(6),
    ].join(' | '));

    const shops = db.select().from(locations).all().filter((l) => l.owner && TRADE_RULES[l.type]);
    const ownerLine = shops.map((l) => {
      const e = allEcon.find((x) => x.agent_id === l.owner);
      return `${l.name} (${nameOf.get(l.owner!) ?? l.owner}) $${f(e?.money ?? 0)}`;
    });
    out(`      shop owners: ${ownerLine.join(' · ') || '(none)'}`);

    // ── Anomalies ───────────────────────────────────────────────────────────
    const note = (msg: string) => anomalies.push(`day ${dayStart.day}: ${msg}`);
    if (ratio > 1.5) note(`money ratio ${ratio.toFixed(2)} > 1.5 (inflation balancer engaged)`);
    if (ratio < 0.5) note(`money ratio ${ratio.toFixed(2)} < 0.5 (deflation)`);
    for (const e of activeEcon) {
      if (e.money < 0) note(`${nameOf.get(e.agent_id)} has negative money ($${e.money.toFixed(2)})`);
      else if (e.money < 5) note(`${nameOf.get(e.agent_id)} is broke ($${e.money.toFixed(2)})`);
    }
    const perAgent = (rows: typeof txs) => {
      const m = new Map<number, number>();
      for (const t of rows) if (t.from_agent != null) m.set(t.from_agent, (m.get(t.from_agent) ?? 0) + 1);
      return m;
    };
    for (const [id, n] of perAgent(buys)) if (n > 8) note(`${nameOf.get(id)} made ${n} purchases`);
    for (const [id, n] of perAgent(covers)) if (n > 4) note(`${nameOf.get(id)} paid ${n} tavern covers`);
    for (const [id, n] of perAgent(gifts)) if (n > 2) note(`${nameOf.get(id)} gave ${n} gifts`);
    for (const l of shops) {
      const e = allEcon.find((x) => x.agent_id === l.owner);
      if (e && e.money < 5) note(`shop owner of ${l.name} is down to $${e.money.toFixed(2)}`);
    }
    if (world.tax_pool > totalMoney * 0.25) note(`tax pool $${f(world.tax_pool)} is >25% of all agent money ($${f(totalMoney)}) — money sink`);
    if (buys.length === 0) note('no shop purchases all day');
    if (convos === 0) note('no conversations ended all day (template tier not running?)');
    if (errors.length > 0) {
      const kinds = new Map<string, number>();
      for (const e of errors) {
        const msg = String((e.template_data as any)?.message ?? '').slice(0, 100);
        // The LLM is off on purpose; outage notices about it are expected.
        if (/LLM/.test(msg)) continue;
        kinds.set(msg, (kinds.get(msg) ?? 0) + 1);
      }
      for (const [msg, n] of kinds) note(`error ×${n}: ${msg}`);
    }
  }

  const ms = performance.now() - t0;
  out('');
  out('day | hunger | energy | social | fun | min h | h<15 | eating | meals h/out/oth | deaths');
  out('----+--------+--------+--------+-----+-------+------+---------+-----------------+-------');
  for (const r of needsRows) out(r);
  out('');
  out(`${ticks} ticks in ${(ms / 1000).toFixed(1)} s (${(ms / ticks).toFixed(1)} ms/tick)`);
  out('');
  out(anomalies.length ? `ANOMALIES (${anomalies.length}):` : 'No anomalies flagged.');
  for (const a of anomalies) out(`  - ${a}`);
  const noisy = [...logTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (noisy.length) {
    out('');
    out('Top server warnings/errors (suppressed; --verbose to see them live):');
    for (const [msg, n] of noisy) out(`  ×${n}  ${msg}`);
  }

  sqlite.close();
}

main()
  .catch((err) => {
    realLog('soak failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (KEEP) {
      realLog(`\nkept: ${tmpDb}`);
    } else {
      for (const sfx of ['', '-wal', '-shm']) {
        try { fs.rmSync(tmpDb + sfx, { force: true }); } catch { /* still open on a crash path */ }
      }
    }
    // Background task-runner / embedding timers would keep the process alive.
    process.exit();
  });
