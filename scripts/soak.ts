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
 *   npm run soak -- --trace "Elena Voss"  # print one agent's every action change
 *   npm run soak -- --agents 32 --days 30 --tick-speed 4 --json out.json   # scale / long-run story health
 *   npm run soak -- --adult --agents 24 --days 6 --tick-speed 4   # adult layer on: per-day intimacy table + minors check
 *
 * `--agents N` (2..32) sizes the cast of a fresh world: the wizard's default residents,
 * trimmed or grown with plausible extras (scripts/soakCast.ts). After the economy tables the
 * soak prints a story-health table (beats, relationship changes, secrets, goals, weddings,
 * deaths, invisible residents, arcs, friendship saturation, mood, tick p50/p95 per phase) and
 * warnings for stagnation, collapse and saturation (scripts/soakHealth.ts); `--json FILE`
 * writes the same numbers for comparing two runs.
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
 * embedding call fails at once like a refused connection. Planning falls back
 * to routine plans, and every conversation is forced onto the template tier
 * (see `forceTemplateTier`): left to the LLM tiers, each one opened, failed its
 * first turn and ended empty, so the social numbers (E10) measured nothing.
 *
 * Speed: ticks are driven back-to-back through `gameTick()` (exported for this
 * script), not the 1 s setTimeout loop.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildSoakCast } from './soakCast';
import { createIntimacyTally, findMinorsInIntimacy, formatIntimacyReport } from './soakIntimacy';
import {
  createHealthTracker, evaluateHealthWarnings, formatCallsTable, formatGatheringsTable, formatHealthTable,
  type DayHealth,
} from './soakHealth';

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
// Checked against the four seasons just below, before anything reads it.
const SEASON = arg('season') as 'spring' | 'summer' | 'autumn' | 'winter' | undefined;
const PRESET = arg('preset');
const AGENT_COUNT = arg('agents') ? Number(arg('agents')) : undefined;
const JSON_OUT = arg('json');
if (AGENT_COUNT !== undefined && SOURCE_DB) {
  console.error('--agents sizes the cast of a fresh world; it cannot be combined with --db (the copy has its own cast)');
  process.exit(1);
}
if (SEASON && !['spring', 'summer', 'autumn', 'winter'].includes(SEASON)) {
  console.error(`--season must be spring, summer, autumn or winter (got "${SEASON}")`);
  process.exit(1);
}
// --adult turns the "Adult content (18+)" rule on (fresh world: in the wizard's rules; --db copy: a live
// override) and adds the intimacy table + the minors check to the report. Off by default, like the game.
const ADULT = flag('adult');
const KEEP = flag('keep');
const VERBOSE = flag('verbose');
// --trace "Name": print every action change of one agent (time, action, place).
const TRACE = arg('trace');

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
}
// No source DB: nothing to do here. Importing server/db on a path with no file
// creates it from the migration chain (server/db/schemaMigrations.ts), the same
// way the game builds a new player's database.
// server/db reads this once at import; every server import below is dynamic
// so it happens after this line. dotenv does not override an existing value.
process.env.DATABASE_PATH = tmpDb;
// No day-change autosaves (lib/saves.ts): a throwaway world, and a save pauses
// and resumes the tick loop, which the soak does not run.
process.env.AUTOSAVE = '0';

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
  const { eq, gt, ne, and, inArray, sql } = await import('drizzle-orm');
  const { gameTick, stopTickLoopAndWait, setTickTimingObserver } = await import('../server/engine/tick');
  const { detectStoryArcs, resetChronicleCache } = await import('../server/lib/chronicle');
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

  const { worldState, agents, economy, economyTransactions, locations, activityLog, conversations, conversationQueue, needs, agentStates } = schema;

  // With the LLM off, an llm_standard / llm_deep queue entry still opens a
  // conversation, fails its first turn against the dead `fetch` and ends with no
  // lines, so the soak counted empty chats and none of the template chats a
  // town without a model really has (the shipped fallback when no slot is free).
  // Entries are queued by several phases (decisions, perception, nudges), so
  // flip them all after each tick: the next tick's conversations phase then only
  // ever sees the template tier, which it runs immediately and without a model.
  const forceTemplateTier = () => {
    db.update(conversationQueue).set({ tier: 'template' }).where(ne(conversationQueue.tier, 'template')).run();
  };

  if (!SOURCE_DB) {
    // The wizard's own defaults, imported rather than restated so the soak
    // follows them when they change.
    const { getDefaultAgents, getDefaultRelationships } = await import('../src/components/setup/defaults');
    const { DEFAULT_WORLD, DEFAULT_RULES, DEFAULT_WORLDGEN, DEFAULT_PRESET, PRESETS } = await import('../src/components/setup/types');
    const { setupRouter } = await import('../server/routers/setup');
    // The wizard's own defaults when --agents is absent (or 13), grown or trimmed otherwise.
    const cast = AGENT_COUNT !== undefined ? buildSoakCast(AGENT_COUNT, SEED) : null;
    const preset = PRESET ? PRESETS.find((p) => p.id === PRESET) : DEFAULT_PRESET;
    if (!preset) throw new Error(`--preset must be one of ${PRESETS.map((p) => p.id).join(', ')} (got "${PRESET}")`);
    await setupRouter.createCaller({}).initialize({
      agents: cast ? cast.agents : getDefaultAgents(),
      relationships: cast ? cast.relationships : getDefaultRelationships(),
      world: { ...DEFAULT_WORLD, ...(SEASON ? { season: SEASON } : {}) },
      rules: ADULT ? { ...DEFAULT_RULES, adultContent: true } : DEFAULT_RULES,
      scenario: { ...preset.values, seed: SEED },
      worldgen: { ...DEFAULT_WORLDGEN, seed: SEED },
    });
    // initialize restarts the real tick loop; this script drives ticks itself.
    await stopTickLoopAndWait();
  }

  const world0 = db.select().from(worldState).get();
  if (!world0) throw new Error('No world in the database');
  if (ADULT) {
    // A fresh world got the rule from the wizard's rules above; a --db copy gets a live override
    // (merged, so the copy's other overrides survive). Idempotent either way.
    const { setRuleOverrides, isAdultContent } = await import('../server/lib/worldRules');
    setRuleOverrides({ adultContent: true });
    if (!isAdultContent()) throw new Error('--adult: the adultContent rule did not take');
  }
  db.update(worldState)
    .set({
      is_paused: false,
      ...(TICK_SPEED ? { tick_speed: TICK_SPEED } : {}),
      // A --db copy keeps its own clock; --season overrides just the season.
      ...(SEASON && SOURCE_DB ? { time: { ...world0.time!, season: SEASON } } : {}),
    })
    .where(eq(worldState.id, world0.id)).run();
  const tickSpeed = TICK_SPEED ?? world0.tick_speed;
  const ticksPerDay = Math.ceil(1440 / tickSpeed);

  // ── Movement / work instrumentation (E6, P1) ──────────────────────────────
  // Every straight-line fallback, labelled by the place its destination tile is
  // in. World-grid tiles map to the smallest location rectangle containing them;
  // interior-grid tiles (building-relative) to the building type + zone.
  const { setPathFallbackObserver, computeAStarPath } = await import('../server/lib/pathfinding');
  const { INTERIOR_ZONES } = await import('../server/data/interiors');
  const TILE = CONFIG.MOVEMENT.TILE_SIZE;
  const allLocs = db.select().from(locations).all();
  const worldRow = () => db.select().from(worldState).get()!;
  const placeOfTile = (tx: number, ty: number): string => {
    const px = tx * TILE + TILE / 2, py = ty * TILE + TILE / 2;
    const hits = allLocs.filter((l) => px >= l.position.x && px < l.position.x + l.position.width
      && py >= l.position.y && py < l.position.y + l.position.height)
      .sort((a, b) => a.position.width * a.position.height - b.position.width * b.position.height);
    return hits[0] ? `${hits[0].type}` : 'open ground';
  };
  const fallbackDay = new Map<string, number>();   // reason -> count, reset daily
  const fallbackWhere = new Map<string, number>(); // "reason @ place" -> count, whole run
  setPathFallbackObserver((f) => {
    fallbackDay.set(f.kind, (fallbackDay.get(f.kind) ?? 0) + 1);
    let where: string;
    if (f.context === 'world') {
      where = `world ${placeOfTile(f.end[0], f.end[1])}`
        + (f.kind === 'no-route' ? ` (from ${placeOfTile(f.start[0], f.start[1])})` : '');
    } else {
      const zone = (INTERIOR_ZONES[f.context] ?? []).find((z) => z.center[0] === f.end[0] && z.center[1] === f.end[1]);
      where = `interior ${f.context} (${f.end[0]},${f.end[1]})${zone ? ` ${zone.id}` : ''}`;
    }
    const k = `${f.kind} @ ${where}`;
    fallbackWhere.set(k, (fallbackWhere.get(k) ?? 0) + 1);
  });

  // Commute: A* length (tiles walked) and minutes at base walking speed, door to door.
  {
    const w = worldRow();
    const locById = new Map(allLocs.map((l) => [l.id, l]));
    const lens: number[] = [];
    const rows: string[] = [];
    for (const a of db.select().from(agents).where(eq(agents.is_active, true)).all()) {
      const home = locById.get(a.home), work = a.workplace != null ? locById.get(a.workplace) : undefined;
      if (!home || !work || home.id === work.id) continue;
      const p = computeAStarPath(home.entry_point, work.entry_point, w.collision_grid, w.map_width, w.map_height, TILE);
      let len = 0, prev = home.entry_point as { x: number; y: number };
      for (const [x, y] of p) { len += Math.hypot(x - prev.x, y - prev.y); prev = { x, y }; }
      lens.push(len / TILE);
      rows.push(`${a.name} ${(len / TILE).toFixed(0)}`);
    }
    fallbackDay.clear(); fallbackWhere.clear();
    const avgLen = lens.reduce((x, y) => x + y, 0) / Math.max(1, lens.length);
    const tilesPerMin = CONFIG.MOVEMENT.PIXELS_PER_GAME_MINUTE / TILE;
    out(`map ${w.map_width}x${w.map_height} tiles · walk ${tilesPerMin} tiles/game min · commute (tiles, door to door): `
      + `avg ${avgLen.toFixed(0)} = ${(avgLen / tilesPerMin).toFixed(0)} min, max ${Math.max(0, ...lens).toFixed(0)}`);
    out(`  ${rows.join(' · ')}`);
    out('');
  }
  // Per-agent walk bookkeeping carried across ticks.
  const walkKey = new Map<number, string>(); // agent -> action_started of the current walk
  type WalkCat = 'trip' | 'same-place' | 'hop' | 'approach';
  const walkCat = new Map<number, WalkCat>();
  const lastPos = new Map<number, { x: number; y: number }>();
  const nameById = new Map(db.select({ id: agents.id, name: agents.name }).from(agents).all().map((a) => [a.id, a.name]));
  const locName = new Map(allLocs.map((l) => [l.id, `${l.type}#${l.id}`]));
  let traceLast = '';
  const maxId = (table: typeof economyTransactions | typeof activityLog | typeof conversations) => Number(db.select({ m: sql<number>`coalesce(max(id), 0)` }).from(table).get()?.m ?? 0);
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
  // Third and fourth tables: movement and time at work (E6/P1).
  const moveRows: string[] = [];
  const workRows: string[] = [];
  // Minutes each agent has currently spent at hunger 0 without a break — the
  // starvation death clock (lifeEventsEngine: 4320). Carried across days.
  const hungerZeroRun = new Map<number, number>();
  // Consecutive days each agent ate a pantry meal (E5: "living on the pantry").
  const pantryRun = new Map<number, number>();
  const maxPantryRun = new Map<number, number>();
  // End-of-day cash per agent, printed as a trajectory table after the run.
  const cashByDay: { day: number; cash: Map<number, number> }[] = [];

  const anomalies: string[] = [];
  // Story health (scripts/soakHealth.ts): snapshots start here, after the world exists.
  const health = createHealthTracker({ sqlite, detectStoryArcs, resetChronicleCache });
  setTickTimingObserver((t) => health.recordTick(t));
  const healthDays: DayHealth[] = [];
  const intimacy = ADULT ? createIntimacyTally(sqlite) : null;
  // Per-day economy and needs numbers kept for --json and the money-drift warning.
  const econDays: Array<Record<string, number>> = [];
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
    // Movement/work, in game minutes per agent.
    const walkMin = new Map<number, number>();
    const walkByCat: Record<WalkCat, number> = { trip: 0, 'same-place': 0, hop: 0, approach: 0 };
    const trips: Record<WalkCat, number> = { trip: 0, 'same-place': 0, hop: 0, approach: 0 };
    const nightWalkMin = new Map<number, number>();
    let tilesWalked = 0;
    const shift = new Map<number, { job: string; shift: number; atWork: number; working: number }>();
    const awayWhy = new Map<string, number>(); // shift minutes away from work, by action
    fallbackDay.clear();
    for (let i = 0; i < ticksPerDay; i++) {
      await gameTick();
      forceTemplateTier();
      ticks++;
      const rows = db.select({
        id: agents.id, home: agents.home, loc: agents.current_location,
        action: agents.current_action, started: agents.action_started,
        dest: agents.current_destination, pos: agents.position, schedule: agents.schedule,
        workplace: agents.workplace, queue: agents.action_queue,
      }).from(agents).where(eq(agents.is_active, true)).all();
      const needByAgent = new Map(db.select().from(needs).all().map((n) => [n.agent_id, n]));
      const clock = worldRow().time;
      const hourF = clock.hour + clock.minute / 60;
      const inWindow = (from: number, to: number) => from <= to ? hourF >= from && hourF < to : hourF >= from || hourF < to;
      for (const r of rows) {
        const type = r.action?.type;
        const prev = lastPos.get(r.id);
        lastPos.set(r.id, r.pos);
        if (r.workplace != null && r.workplace !== r.home && r.schedule) {
          const s = shift.get(r.id) ?? { job: jobOf.get(r.id) ?? '?', shift: 0, atWork: 0, working: 0 };
          if (inWindow(r.schedule.workStart, r.schedule.workEnd)) {
            s.shift += tickSpeed;
            if (r.loc === r.workplace && type !== 'walking') s.atWork += tickSpeed;
            if (type === 'working') s.working += tickSpeed;
            // Where shift time goes when it is not spent at work: the action, or
            // for a walk the action it is walking to.
            if (r.loc !== r.workplace || type === 'walking') {
              const k = type === 'walking' ? `walk>${r.queue?.[0]?.type ?? '?'}` : String(type);
              awayWhy.set(k, (awayWhy.get(k) ?? 0) + tickSpeed);
            }
          }
          shift.set(r.id, s);
        }
        if (TRACE && nameById.get(r.id) === TRACE) {
          const a = r.action;
          const q = r.queue?.[0];
          const desc = type === 'walking'
            ? `walking${a?.reason ? `(${a.reason})` : ''} -> ${q?.type ?? '?'}${q?.source ? `/${q.source}` : ''} @ ${(r.dest?.locationId != null ? locName.get(r.dest.locationId) : undefined) ?? 'point'}`
            : `${type}${a?.source ? `/${a.source}` : ''}${a?.zoneActivity ? `/${a.zoneActivity}` : ''}`;
          const line = `${desc} [at ${locName.get(r.loc as number) ?? 'outside'}]`;
          if (line !== traceLast) {
            const n = needByAgent.get(r.id);
            out(`  trace d${clock.day} ${String(clock.hour).padStart(2, '0')}:${String(Math.floor(clock.minute)).padStart(2, '0')} ${line}`
              + (n ? `  h${n.hunger.toFixed(0)} e${n.energy.toFixed(0)} s${n.social.toFixed(0)}` : ''));
            traceLast = line;
          }
        }
        if (type !== 'walking') { walkKey.delete(r.id); continue; }
        walkMin.set(r.id, (walkMin.get(r.id) ?? 0) + tickSpeed);
        if (r.schedule && inWindow(r.schedule.sleepTime, r.schedule.wakeTime)) {
          nightWalkMin.set(r.id, (nightWalkMin.get(r.id) ?? 0) + tickSpeed);
        }
        if (prev) tilesWalked += Math.hypot(r.pos.x - prev.x, r.pos.y - prev.y) / TILE;
        const key = String(r.started);
        if (walkKey.get(r.id) !== key) {
          walkKey.set(r.id, key);
          const locId = r.dest?.locationId;
          const cat: WalkCat = r.action?.reason === 'approaching_conversation' ? 'approach'
            : locId == null ? 'hop' : locId === r.loc ? 'same-place' : 'trip';
          walkCat.set(r.id, cat);
          trips[cat]++;
        }
        walkByCat[walkCat.get(r.id) ?? 'hop'] += tickSpeed;
      }
      for (const st of db.select({ agent: agentStates.agent_id, type: agentStates.type }).from(agentStates)
        .where(inArray(agentStates.type, ['stressed', 'lonely'])).all()) {
        stateHolders[st.type as 'stressed' | 'lonely'].add(st.agent);
      }
      for (const r of rows) {
        const n = needByAgent.get(r.id);
        if (!n) continue;
        needSum.hunger += n.hunger; needSum.energy += n.energy; needSum.social += n.social; needSum.fun += n.fun;
        needSamples++;
        health.sampleMood(n.mood);
        minHunger = Math.min(minHunger, n.hunger);
        if (n.hunger < 15) starving.add(r.id);
        const run = n.hunger <= 0 ? (hungerZeroRun.get(r.id) ?? 0) + tickSpeed : 0;
        hungerZeroRun.set(r.id, run);
        maxZeroRun = Math.max(maxZeroRun, run);
        if (r.action?.type === 'working' && RISKY_JOBS.has(jobOf.get(r.id) ?? '')) {
          riskyWork.set(r.id, (riskyWork.get(r.id) ?? 0) + tickSpeed);
        }
        if (r.action?.type === 'eating' && r.loc != null) {
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
      .map((r) => String(r.template_data?.description ?? ''))
      .filter((d) => d.includes(' has died. '))
      .map((d) => d.replace(/ has died\. /, ': ').replace(/\. The town mourns\.$/, ''));
    // Money-supply crisis events (economy.ts balancer, ratio > 2 / > 3).
    const crisis = db.select().from(activityLog)
      .where(and(gt(activityLog.id, logMark), inArray(activityLog.type, ['drama', 'system']))).all()
      .map((r) => String(r.template_data?.description ?? r.template_data?.message ?? ''))
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
    {
      const n = Math.max(1, active.length);
      const wm = [...walkMin.entries()].sort((a, b) => b[1] - a[1]);
      const totalWalk = wm.reduce((x, [, v]) => x + v, 0);
      const h = (m: number) => (m / 60).toFixed(1);
      const nights = [...nightWalkMin.values()];
      const byJob = new Map<string, { n: number; shift: number; atWork: number; working: number }>();
      for (const s of shift.values()) {
        const j = byJob.get(s.job) ?? { n: 0, shift: 0, atWork: 0, working: 0 };
        j.n++; j.shift += s.shift; j.atWork += s.atWork; j.working += s.working;
        byJob.set(s.job, j);
      }
      const all = [...shift.values()];
      const sumK = (k: 'shift' | 'atWork' | 'working') => all.reduce((x, s) => x + s[k], 0);
      moveRows.push([
        String(dayStart.day).padStart(3),
        h(totalWalk / n).padStart(6),
        `${h(wm[0]?.[1] ?? 0)} ${nameOf.get(wm[0]?.[0] ?? -1) ?? ''}`.padEnd(14),
        `${(trips.trip / n).toFixed(1)}/${(trips['same-place'] / n).toFixed(1)}/${(trips.hop / n).toFixed(1)}/${(trips.approach / n).toFixed(1)}`.padStart(18),
        `${h(walkByCat.trip / n)}/${h(walkByCat['same-place'] / n)}/${h(walkByCat.hop / n)}/${h(walkByCat.approach / n)}`.padStart(18),
        (tilesWalked / n).toFixed(0).padStart(5),
        `${h(Math.max(0, ...nights))}`.padStart(7),
        `${h(sumK('atWork') / Math.max(1, all.length))}/${h(sumK('shift') / Math.max(1, all.length))}`.padStart(8),
        `${fallbackDay.get('unroutable-destination') ?? 0}/${fallbackDay.get('no-route') ?? 0}`.padStart(7)
          + ` (${(fallbackDay.get('snapped-destination') ?? 0) + (fallbackDay.get('snapped-start') ?? 0)})`,
      ].join(' | '));
      workRows.push(`${String(dayStart.day).padStart(3)} | ` + [...byJob.entries()].sort()
        .map(([job, j]) => `${job}x${j.n} ${h(j.atWork / j.n)}/${h(j.shift / j.n)} (w ${h(j.working / j.n)})`).join(' · '));
      workRows.push('    | away from work, h per worker: ' + [...awayWhy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, v]) => `${k} ${h(v / Math.max(1, all.length))}`).join(' · '));
    }
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
        const msg = String(e.template_data?.message ?? '').slice(0, 100);
        // The LLM is off on purpose; outage notices about it are expected.
        if (/LLM/.test(msg)) continue;
        kinds.set(msg, (kinds.get(msg) ?? 0) + 1);
      }
      for (const [msg, n] of kinds) note(`error ×${n}: ${msg}`);
    }

    healthDays.push(health.endDay(dayStart.day));
    intimacy?.endDay(dayStart.day);
    econDays.push({
      day: dayStart.day, residents: active.length, perCapita, minMoney, ratio, taxPool: world.tax_pool,
      broke, convos, salary: sum(salary), buys: buys.length,
      hunger: needSum.hunger / Math.max(1, needSamples), energy: needSum.energy / Math.max(1, needSamples),
      social: needSum.social / Math.max(1, needSamples), fun: needSum.fun / Math.max(1, needSamples),
      starving: starving.size,
    });
  }
  setTickTimingObserver(null);

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
  out('Movement, per agent per day. trips = walks started, t/s/h/a: trip to another place / same-place (a walk to');
  out('the door of the place the agent is already in) / hop (interior walk to a zone) / approach (walking over to');
  out('talk). walk h split the same way. tiles = distance walked. night h = max h one agent walked in its sleep');
  out('window. at work = h at the workplace during the shift / shift h. fallback = straight lines: unroutable');
  out('destination / no route (in brackets: routes snapped to the nearest open tile, not straight lines).');
  out('day | walk h | max walk h     |   trips t/s/h/a    |  walk h t/s/h/a    | tiles | night h | at work  | fallback u/n (s)');
  out('----+--------+----------------+--------------------+--------------------+-------+---------+----------+-------------');
  for (const r of moveRows) out(r);
  out('');
  out('Time at workplace during shift by job: at/shift h (w = h on a working action)');
  for (const r of workRows) out(r);
  out('');
  if (fallbackWhere.size) {
    out('Path fallbacks and snaps by reason and destination (whole run):');
    for (const [k, v] of [...fallbackWhere.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) out(`  x${v}  ${k}`);
    out('');
  }
  out(`${ticks} ticks in ${(ms / 1000).toFixed(1)} s (${(ms / ticks).toFixed(1)} ms/tick)`);
  out('');

  // ── Story health (scripts/soakHealth.ts) ──────────────────────────────────
  if (intimacy) {
    const minorCount = Number((sqlite.prepare('select count(*) c from agents where age < 18').get() as { c: number }).c);
    for (const r of formatIntimacyReport(intimacy.days, findMinorsInIntimacy(sqlite), minorCount)) out(r);
    out('');
  }
  out('Story health per day. beats new/kinds/all = beat types seen for the first time today / distinct today /');
  out('distinct so far; story types = distinct activity types logged at importance >= 0.6; rel chg = net relationship');
  out('status changes; facts/secr/public = new shared facts / of them sensitivity >= 2 / turned common knowledge;');
  out('invisible = residents with no importance >= 0.6 row today (in brackets: ignoring interaction_resolved);');
  out('arcs = detectStoryArcs, capped at 12 by the chronicle (hot = heat >= 0.25); friends% = pairs friends both ways.');
  for (const r of formatHealthTable(healthDays)) out(r);
  out('');
  out('Social calls per day (server/lib/socialCalls): one feed row per visit made, by beat; loan_repaid /');
  out('loan_unpaid / forgotten_birthday are the calls\' after-effects, not visits.');
  for (const r of formatCallsTable(healthDays)) out(r);
  // How the promises ended, per kind: a kind that is scheduled but never made is a
  // walking problem; one never scheduled is a rare trigger (or a broken producer).
  const { socialCallTally } = await import('../server/lib/socialCalls/engine');
  const tally = Object.entries(socialCallTally()).sort(([a], [b]) => a.localeCompare(b));
  out(tally.length === 0
    ? 'calls promised: none'
    : `calls promised/made/expired/dropped: ${tally.map(([k, t]) => `${k} ${t.scheduled}/${t.made}/${t.expired}/${t.dropped}`).join(' · ')}`);
  out('');
  // Gatherings (server/lib/gatherings): per kind, how many were held, how many came on
  // average, and of those asked at `must`/`should`, how many came. A kind scheduled but
  // never held was called off (the leaver died, the couple's event vanished).
  out('Gatherings (server/lib/gatherings): held / called off; avg came = everyone seen at the venue;');
  out('asked/came = invited at must or should, and of them who came (the rest are the "may" crowd).');
  for (const r of formatGatheringsTable((await import('../server/lib/gatherings/engine')).gatheringTally())) out(r);
  out('');
  // Taking sides (server/lib/factions) and reciprocity (server/lib/socialCalls/reciprocity.ts):
  // whole-run counts, then the feud feed rows per game day by beat.
  const { factionTally } = await import('../server/lib/factions/store');
  const { reciprocityTally } = await import('../server/lib/socialCalls/reciprocity');
  const ft = factionTally();
  const rt = reciprocityTally();
  out('Taking sides (server/lib/factions) and reciprocity, whole run:');
  out(`feuds started ${ft.started} · sides taken ${ft.sided} · neutral ${ft.neutral} · torn ${ft.torn} · `
    + `mediations tried/succeeded ${ft.mediationsTried}/${ft.mediationsSucceeded} · town feuds started/ended ${ft.townStarted}/${ft.townEnded} · `
    + `ended reconciled/gone/faded ${ft.ended.reconciled}/${ft.ended.gone}/${ft.ended.faded}`);
  out(`favours returned ${rt.favoursReturned} · ingratitude slights ${rt.ingratitude}`);
  const feudRows = sqlite.prepare("select game_minute as m, metadata as md from activity_log where type = 'feud'").all() as Array<{ m: number | null; md: string | null }>;
  const feudByDay = new Map<number, Record<string, number>>();
  for (const r of feudRows) {
    if (r.m == null) continue;
    const day = Math.floor(r.m / 1440);
    const beat = (JSON.parse(r.md ?? '{}') as { beat?: string }).beat ?? '?';
    const t = feudByDay.get(day) ?? {};
    t[beat] = (t[beat] ?? 0) + 1;
    feudByDay.set(day, t);
  }
  out(feudByDay.size === 0
    ? 'feud rows: none'
    : `feud rows by day: ${[...feudByDay].sort(([a], [b]) => a - b).map(([d, t]) => `d${d} ${Object.entries(t).map(([k, v]) => `${k}×${v}`).join(',')}`).join(' · ')}`);
  out('');
  const tickSummary = health.runTickSummary();
  const phaseSummary = health.runPhaseSummary();
  out(`Tick time over ${tickSummary.ticks} ticks at ${health.startPopulation()} residents: p50 ${tickSummary.p50.toFixed(1)} ms, p95 ${tickSummary.p95.toFixed(1)} ms, max ${tickSummary.max.toFixed(0)} ms `
    + `(loop interval ${CONFIG.TICK_INTERVAL_MS} ms; "other" = perception, tavern, milestones, day-change work)`);
  out('phase          |   p50 ms |   p95 ms |  mean ms | share of tick');
  for (const p of phaseSummary) {
    out(`${p.phase.padEnd(14)} | ${p.p50.toFixed(2).padStart(8)} | ${p.p95.toFixed(2).padStart(8)} | ${p.mean.toFixed(2).padStart(8)} | ${(100 * p.share).toFixed(0).padStart(6)}%`);
  }
  out('');
  const healthWarnings = evaluateHealthWarnings(
    healthDays,
    { tickIntervalMs: CONFIG.TICK_INTERVAL_MS, tickSpeed },
    econDays.map((e) => ({ day: e.day, ratio: e.ratio })),
  );
  out(healthWarnings.length ? `STORY HEALTH WARNINGS (${healthWarnings.length}):` : 'No story-health warnings.');
  for (const w of healthWarnings) out(`  - ${w}`);
  out('');
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      config: { days: DAYS, agents: health.startPopulation(), seed: SEED, tickSpeed, preset: PRESET ?? 'default', season: SEASON ?? null, sourceDb: SOURCE_DB ?? null, tickIntervalMs: CONFIG.TICK_INTERVAL_MS },
      wallSeconds: ms / 1000,
      economy: econDays,
      health: healthDays,
      ticks: tickSummary,
      phases: phaseSummary,
      warnings: healthWarnings,
      anomalies,
    }, null, 1));
    out(`wrote ${JSON_OUT}`);
    out('');
  }
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
