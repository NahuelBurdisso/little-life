/**
 * Headless economy soak: run N game days as fast as the CPU allows against a
 * THROWAWAY database and print a daily economy summary with anomaly flags.
 *
 *   npm run soak                          # fresh wizard-default world, 5 days
 *   npm run soak -- --days 10 --seed abc  # deterministic worldgen seed
 *   npm run soak -- --db data/verify.db   # soak a COPY of an existing save
 *   npm run soak -- --tick-speed 5 --keep --verbose
 *   npm run soak -- --season winter       # start in another season (fresh world or --db copy)
 *   npm run soak -- --preset soap         # drama preset for a fresh world (default: the wizard's)
 *
 * A fresh world is built exactly as the setup wizard's Start button builds it
 * with nothing edited: the wizard's default cast and relationships, its default
 * world/rules/worldgen, and its default drama preset — `--seed` seeds both the
 * worldgen and the scenario. It used to post `AGENT_SEEDS` with its own rules
 * and no scenario, which is a town no player ever starts, so the early-days
 * numbers it printed described nothing real.
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
const SEASON = arg('season');
const PRESET = arg('preset');
if (SEASON && !['spring', 'summer', 'autumn', 'winter'].includes(SEASON)) {
  console.error(`--season must be spring, summer, autumn or winter (got "${SEASON}")`);
  process.exit(1);
}
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
  const { getCheapestFoodPrice } = await import('../server/lib/economyEngine');
  // Registers the gift / jealousy listeners the server gets from index.ts.
  await import('../server/lib/giftEngine');
  // Food made per day (farm output, bread, drinks): meals are real food now, so
  // supply is part of the economy picture.
  const { simEvents } = await import('../server/lib/simEvents');
  const produced = new Map<string, number>();
  simEvents.on('economy:production', (p: { item: string; quantity: number }) => {
    produced.set(p.item, (produced.get(p.item) ?? 0) + p.quantity);
  });
  // Meal sources per day (economy.ts serveMeal emits once per meal). The
  // pantry feeds the broke and the starving; only the broke ones are the E5
  // signal ("lives on the pantry"), a starving agent with money just didn't
  // reach a vendor in time.
  const mealSources = new Map<string, number>();
  const brokePantryToday = new Set<number>();
  let brokePantryMeals = 0;
  simEvents.on('economy:meal', (m: { agentId: number; source: string; money: number }) => {
    mealSources.set(m.source, (mealSources.get(m.source) ?? 0) + 1);
    if (m.source === 'pantry' && m.money < getCheapestFoodPrice()) {
      brokePantryToday.add(m.agentId);
      brokePantryMeals++;
    }
  });

  const { worldState, agents, economy, economyTransactions, locations, activityLog, conversations, needs, agentStates } = schema;

  if (!SOURCE_DB) {
    // The wizard's own defaults, imported rather than restated so the soak
    // follows them when they change.
    const { getDefaultAgents, getDefaultRelationships } = await import('../src/components/setup/defaults');
    const { DEFAULT_WORLD, DEFAULT_RULES, DEFAULT_WORLDGEN, DEFAULT_PRESET, PRESETS } = await import('../src/components/setup/types');
    const { setupRouter } = await import('../server/routers/setup');
    const preset = PRESET ? PRESETS.find((p) => p.id === PRESET) : DEFAULT_PRESET;
    if (!preset) throw new Error(`--preset must be one of ${PRESETS.map((p) => p.id).join(', ')} (got "${PRESET}")`);
    await setupRouter.createCaller({} as any).initialize({
      agents: getDefaultAgents(),
      relationships: getDefaultRelationships(),
      world: { ...DEFAULT_WORLD, ...(SEASON ? { season: SEASON } : {}) },
      rules: DEFAULT_RULES,
      scenario: { ...preset.values, seed: SEED },
      worldgen: { ...DEFAULT_WORLDGEN, seed: SEED },
    } as any);
    // initialize restarts the real tick loop; this script drives ticks itself.
    await stopTickLoopAndWait();
  }

  const world0 = db.select().from(worldState).get();
  if (!world0) throw new Error('No world in the database');
  db.update(worldState)
    .set({
      is_paused: false,
      ...(TICK_SPEED ? { tick_speed: TICK_SPEED } : {}),
      // A --db copy keeps its own clock; --season overrides just the season.
      ...(SEASON && SOURCE_DB ? { time: { ...world0.time!, season: SEASON as any } } : {}),
    })
    .where(eq(worldState.id, world0.id)).run();
  const tickSpeed = TICK_SPEED ?? world0.tick_speed;
  const ticksPerDay = Math.ceil(1440 / tickSpeed);

  const maxId = (table: any) => Number(db.select({ m: sql<number>`coalesce(max(id), 0)` }).from(table).get()?.m ?? 0);
  let txMark = maxId(economyTransactions);
  let logMark = maxId(activityLog);
  let convoMark = maxId(conversations);

  out(`soak: ${DAYS} day(s), tick_speed ${tickSpeed}, ${ticksPerDay} ticks/day, db ${tmpDb}${SOURCE_DB ? ` (copy of ${SOURCE_DB})` : ` (fresh world, seed "${SEED}")`}`);
  out(`money target $${world0.money_target_per_capita ?? CONFIG.ECONOMY.TARGET_PER_CAPITA_MONEY}/resident, treasury $${Math.round(world0.tax_pool)}`);
  out('');
  // pantry = pantry meals / of which the eater was broke (E5).
  out('day | agents | $/capita | min$ | ratio | tax pool | salary | upkeep | stipend | buys (n/$) | covers (n/$) | wholesale $ | gifts (n/$) | broke | pantry | convos');
  out('----+--------+----------+------+-------+----------+--------+--------+---------+------------+--------------+-------------+-------------+-------+--------+-------');
  // Second table, printed after the run: needs and meals per day. Needs are
  // averaged over every agent-tick (time-weighted, not a daily snapshot), so a
  // town pinned at 100 and one that dips at lunch read differently.
  const needsRows: string[] = [];
  // Third table: who talks to whom, and who is exposed to the workplace-accident
  // roll (lifeEventsEngine: farmer / farmhand / handyperson while 'working').
  // A town whose chats all run through two or three pairs reads as a town of
  // strangers even when the conversation count looks healthy.
  const socialRows: string[] = [];
  const RISKY_JOBS = new Set(['farmer', 'farmhand', 'handyperson']);
  // Minutes each agent has currently spent at hunger 0 without a break — the
  // starvation death clock (lifeEventsEngine: 4320). Carried across days.
  const hungerZeroRun = new Map<number, number>();
  // Consecutive days each agent ate a pantry meal (E5: "living on the pantry").
  const pantryRun = new Map<number, number>();
  const maxPantryRun = new Map<number, number>();
  // End-of-day cash per agent, printed as a trajectory table after the run.
  const cashByDay: { day: number; cash: Map<number, number> }[] = [];

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
    // Agents who carried these states at any tick of the day: the needs-driven
    // ones that a hungrier town could push up (stressed: 3 needs < 35).
    const stateHolders = { stressed: new Set<number>(), lonely: new Set<number>() };
    let maxZeroRun = 0;
    const jobOf = new Map(db.select({ id: economy.agent_id, job: economy.job }).from(economy).all().map((e) => [e.id, e.job]));
    // Game minutes each risky-job agent spent in the 'working' action today.
    const riskyWork = new Map<number, number>();
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
      for (const st of db.select({ agent: agentStates.agent_id, type: agentStates.type }).from(agentStates)
        .where(inArray(agentStates.type, ['stressed', 'lonely'])).all()) {
        stateHolders[st.type as 'stressed' | 'lonely'].add(st.agent);
      }
      for (const r of rows) {
        const n = needByAgent.get(r.id);
        if (!n) continue;
        needSum.hunger += n.hunger; needSum.energy += n.energy; needSum.social += n.social; needSum.fun += n.fun;
        needSamples++;
        minHunger = Math.min(minHunger, n.hunger);
        if (n.hunger < 15) starving.add(r.id);
        const run = n.hunger <= 0 ? (hungerZeroRun.get(r.id) ?? 0) + tickSpeed : 0;
        hungerZeroRun.set(r.id, run);
        maxZeroRun = Math.max(maxZeroRun, run);
        if ((r.action as any)?.type === 'working' && RISKY_JOBS.has(jobOf.get(r.id) ?? '')) {
          riskyWork.set(r.id, (riskyWork.get(r.id) ?? 0) + tickSpeed);
        }
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
    const short = (id: number) => (nameOf.get(id) ?? String(id)).replace(/^Dr\.? +/, '').split(' ')[0];
    const allEcon = db.select().from(economy).all();
    const activeIds = new Set(active.map((a) => a.id));
    const activeEcon = allEcon.filter((e) => activeIds.has(e.agent_id));
    const totalMoney = activeEcon.reduce((s, e) => s + e.money, 0);
    const perCapita = activeEcon.reduce((s, e) => s + e.money, 0) / Math.max(1, activeEcon.length);
    const minMoney = Math.min(...activeEcon.map((e) => e.money));
    // Same ratio economy.ts balances on at day change.
    const target = world.money_target_per_capita ?? CONFIG.ECONOMY.TARGET_PER_CAPITA_MONEY;
    const ratio = totalMoney / Math.max(1, active.length * target);

    const txs = db.select().from(economyTransactions).where(gt(economyTransactions.id, txMark)).all();
    txMark = maxId(economyTransactions);
    const sum = (rows: typeof txs) => rows.reduce((s, t) => s + t.amount, 0);
    const salary = txs.filter((t) => t.reason === 'salary');
    const buys = txs.filter((t) => t.reason.startsWith('purchase:'));
    const covers = txs.filter((t) => t.reason.startsWith('entertainment:'));
    const wholesale = txs.filter((t) => t.reason.startsWith('wholesale:'));
    const gifts = txs.filter((t) => ['gift', 'drunk_gift', 'euphoric_gift'].includes(t.reason));
    // Treasury payouts to residents other than wages (town:stipend).
    const welfare = txs.filter((t) => t.reason.startsWith('town:'));
    const upkeep = txs.filter((t) => t.reason === 'upkeep');
    const broke = activeEcon.filter((e) => e.money < getCheapestFoodPrice()).length;
    for (const id of activeIds) {
      const run = brokePantryToday.has(id) ? (pantryRun.get(id) ?? 0) + 1 : 0;
      pantryRun.set(id, run);
      maxPantryRun.set(id, Math.max(maxPantryRun.get(id) ?? 0, run));
    }
    const pantryMeals = `${mealSources.get('pantry') ?? 0}/${brokePantryMeals}`;
    brokePantryMeals = 0;
    const mealMix = [...mealSources].map(([k, v]) => `${k} ${v}`).join(', ');
    mealSources.clear();
    brokePantryToday.clear();
    cashByDay.push({ day: dayStart.day, cash: new Map(activeEcon.map((e) => [e.agent_id, e.money])) });

    const errors = db.select().from(activityLog)
      .where(and(gt(activityLog.id, logMark), eq(activityLog.type, 'error'))).all();
    // Deaths log as 'drama' ("X has died. <cause>. The town mourns.").
    const deathCauses = db.select().from(activityLog)
      .where(and(gt(activityLog.id, logMark), eq(activityLog.type, 'drama'))).all()
      .map((r) => String((r.template_data as any)?.description ?? ''))
      .filter((d) => d.includes(' has died. '))
      .map((d) => d.replace(/ has died\. /, ': ').replace(/\. The town mourns\.$/, ''));
    // Money-supply crisis events (economy.ts balancer, ratio > 2 / > 3).
    const crisis = db.select().from(activityLog)
      .where(and(gt(activityLog.id, logMark), inArray(activityLog.type, ['drama', 'system']))).all()
      .map((r) => String((r.template_data as any)?.description ?? (r.template_data as any)?.message ?? ''))
      .filter((d) => /during the economic crisis|traveling scammer|Emergency tax!|Hyperinflation!|is hoarding supplies/.test(d));
    logMark = maxId(activityLog);
    const endedConvos = db.select({ participants: conversations.participants }).from(conversations)
      .where(and(gt(conversations.id, convoMark), inArray(conversations.status, ['ended', 'completed']))).all();
    const convos = endedConvos.length;
    convoMark = maxId(conversations);
    const pairCounts = new Map<string, number>();
    const talked = new Set<number>();
    for (const c of endedConvos) {
      const ids = [...new Set(c.participants)].sort((a, b) => a - b);
      ids.forEach((id) => talked.add(id));
      const key = ids.map(short).join('+');
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    const topPairs = [...pairCounts].sort((a, b) => b[1] - a[1]);
    const top3 = topPairs.slice(0, 3).reduce((s, [, n]) => s + n, 0);
    socialRows.push([
      String(dayStart.day).padStart(3),
      String(convos).padStart(6),
      String(pairCounts.size).padStart(5),
      `${(100 * top3 / Math.max(1, convos)).toFixed(0)}%`.padStart(9),
      String([...activeAtStart].filter((id) => !talked.has(id)).length).padStart(9),
      ` ${topPairs.slice(0, 3).map(([k, n]) => `${k} ${n}`).join(', ') || '-'}`,
      ` | risky work min: ${[...riskyWork].map(([id, m]) => `${short(id)} ${m}`).join(', ') || '-'}`,
    ].join(' |'));

    const f = (n: number) => n.toFixed(0);
    const avg = (k: keyof typeof needSum) => f(needSum[k] / Math.max(1, needSamples));
    const mealCount = (w: string) => [...meals.values()].filter((v) => v === w).length;
    const died = [...activeAtStart].filter((id) => !active.some((a) => a.id === id));
    needsRows.push([
      String(dayStart.day).padStart(3),
      avg('hunger').padStart(6), avg('energy').padStart(6), avg('social').padStart(6), avg('fun').padStart(4),
      f(minHunger).padStart(5),
      String(starving.size).padStart(6),
      `${(maxZeroRun / 60).toFixed(1)}h`.padStart(8),
      String(stateHolders.stressed.size).padStart(8),
      String(stateHolders.lonely.size).padStart(6),
      `${(100 * eatingSamples / Math.max(1, needSamples)).toFixed(1)}%`.padStart(7),
      `${mealCount('home')}/${mealCount('out')}/${mealCount('other')}`.padStart(15),
      String(died.length).padStart(6) + (died.length ? ` (${deathCauses.join('; ') || died.map((id) => nameOf.get(id)).join(', ')})` : ''),
    ].join(' | ') + `  | made: ${[...produced].map(([k, v]) => `${k} ${v}`).join(', ') || '-'}  | meals: ${mealMix || '-'}`);
    produced.clear();
    out([
      String(dayStart.day).padStart(3),
      String(active.length).padStart(6),
      f(perCapita).padStart(8),
      f(minMoney).padStart(4),
      ratio.toFixed(2).padStart(5),
      f(world.tax_pool).padStart(8),
      f(sum(salary)).padStart(6),
      f(sum(upkeep)).padStart(6),
      f(sum(welfare)).padStart(7),
      `${buys.length}/${f(sum(buys))}`.padStart(10),
      `${covers.length}/${f(sum(covers))}`.padStart(12),
      f(sum(wholesale)).padStart(11),
      `${gifts.length}/${f(sum(gifts))}`.padStart(11),
      String(broke).padStart(5),
      pantryMeals.padStart(6),
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
    // The treasury pays wages and holds a reserve (server/lib/townTreasury.ts);
    // it should stay between zero and its cap.
    const treasuryCap = active.length * CONFIG.ECONOMY.TREASURY_CAP_PER_CAPITA;
    if (world.tax_pool < 0) note(`treasury in debt ($${f(world.tax_pool)})`);
    else if (world.tax_pool > treasuryCap) note(`treasury $${f(world.tax_pool)} above its cap $${f(treasuryCap)}`);
    for (const c of crisis) note(`crisis event: ${c.slice(0, 100)}`);
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
  out('day | hunger | energy | social | fun | min h | h<15 | h=0 run | stressed | lonely | eating | meals h/out/oth | deaths');
  out('----+--------+--------+--------+-----+-------+------+---------+----------+--------+---------+-----------------+-------');
  for (const r of needsRows) out(r);
  out('');
  out('day | convos | pairs | top3 share | no convo | top pairs | risky work');
  out('----+--------+-------+-----------+----------+-----------+-----------');
  for (const r of socialRows) out(r);
  out('');
  // Cash trajectory: one row per agent (everyone active at some point), one
  // column per day's closing balance; `pantry run` is the longest run of
  // consecutive days with a pantry meal eaten broke.
  const everyone = db.select({ id: agents.id, name: agents.name }).from(agents).all();
  const econRows = new Map(db.select().from(economy).all().map((e) => [e.agent_id, e]));
  out(`agent              | job               | salary | ${cashByDay.map((c) => `d${c.day}`.padStart(6)).join(' | ')} | pantry run`);
  for (const a of everyone) {
    const e = econRows.get(a.id);
    const cells = cashByDay.map((c) => (c.cash.has(a.id) ? c.cash.get(a.id)!.toFixed(0) : '-').padStart(6));
    out([
      a.name.slice(0, 18).padEnd(18), (e?.job ?? '').slice(0, 17).padEnd(17), String(e?.salary ?? '').padStart(6),
      ...cells, String(maxPantryRun.get(a.id) ?? 0).padStart(10),
    ].join(' | '));
  }
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
