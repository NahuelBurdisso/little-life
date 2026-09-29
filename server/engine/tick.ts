import { db } from '../db';
import { worldState, agents } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { logActivity, pruneActivityLog } from '../lib/activityLogger';
import { emitter } from './emitter';
import { runGuarded } from './runGuarded';
import { needsTick } from './systems/needs';
import { statesTick } from './systems/states';
import { economyTick } from './systems/economy';
import { tick as relationshipsTick, pruneRelationshipEvents } from './systems/relationships';
import { conversationsTick, pruneEndedConversations } from './systems/conversations';
import { tick as decisionsTick } from './systems/decisions';
import { tick as movementTick } from './systems/movement';
import { eventsTick } from './systems/events';
import { gossipTick } from './systems/gossipEngine';
import { goalsTick } from './systems/goals';
import { cascadeTick } from '../lib/cascade';
import { CONFIG } from '../lib/constants';
import { crossedBoundary, gameMinutes, hourChanged } from '../lib/gameClock';
import { cacheAllAgentStates, clearAgentStatesCache, invalidateAgentStatesCache } from '../lib/states';
import { reflectionTrigger, reflectionRunner, memoryConsolidator, selfDescriptionGenerator, memoryService } from '../lib/memory/instance';
import { runEmbeddingBackfill } from '../lib/memory/embeddingBackfill';
import { writeIssue } from '../lib/gazette';
import { perceptionSystem } from '../lib/perception/instance';
import { refreshAllReputations } from '../lib/reputationEngine';
import { processAllMoodMomentum } from '../lib/moodMomentum';
import { tavernTick } from '../lib/tavernEngine';
import { lonelinessCheck } from '../lib/lonelinessEngine';
import { confrontationCheck } from '../lib/confrontationEngine';
import { agingTick } from '../lib/agingEngine';
import { saveWorldCaches } from './worldCaches';
import crypto from 'crypto';
import { autoPlayer } from '../autoplay';
import { conversationQueue, conversationSchedulerState } from '../db/schema';

// ─── Types ────────────────────────────────────────────────────────────────────

type Season = 'spring' | 'summer' | 'autumn' | 'winter';
type DayPhase = 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night';

type ClockTransition =
  | { type: 'hour_changed'; hour: number }
  | { type: 'day_changed'; day: number }
  | { type: 'phase_changed'; from: DayPhase; to: DayPhase }
  | { type: 'season_changed'; from: Season; to: Season };

type WorldRow = typeof worldState.$inferSelect;

// ─── Constants ────────────────────────────────────────────────────────────────

const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];

// ─── Clock helpers ────────────────────────────────────────────────────────────

/** Exported for tests. */
export function computeDayPhase(hour: number): DayPhase {
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'evening';
  return 'night';
}

/** Exported for tests. */
export function advanceClock(time: WorldRow['time'], tickSpeed: number): WorldRow['time'] {
  let { day, hour, minute, totalTicks, seasonDay, season } = time;

  minute += tickSpeed;

  if (minute >= 60) {
    hour += Math.floor(minute / 60);
    minute = minute % 60;
  }

  if (hour >= 24) {
    day += Math.floor(hour / 24);
    hour = hour % 24;
  }

  seasonDay = day % CONFIG.TIME.SEASON_LENGTH_DAYS;
  const seasonIndex = Math.floor(day / CONFIG.TIME.SEASON_LENGTH_DAYS) % 4;
  season = SEASONS[seasonIndex];

  return { day, hour, minute, totalTicks: totalTicks + 1, seasonDay, season };
}

/** Exported for tests. */
export function detectTransitions(
  oldTime: WorldRow['time'],
  oldDayPhase: DayPhase,
  newTime: WorldRow['time'],
  newDayPhase: DayPhase,
): ClockTransition[] {
  const transitions: ClockTransition[] = [];

  if (newTime.hour !== oldTime.hour) {
    transitions.push({ type: 'hour_changed', hour: newTime.hour });
  }
  if (newTime.day !== oldTime.day) {
    transitions.push({ type: 'day_changed', day: newTime.day });
  }
  if (newDayPhase !== oldDayPhase) {
    transitions.push({ type: 'phase_changed', from: oldDayPhase, to: newDayPhase });
  }
  if (newTime.season !== oldTime.season) {
    transitions.push({
      type: 'season_changed',
      from: oldTime.season as Season,
      to: newTime.season as Season,
    });
  }

  return transitions;
}

// ─── System phases ────────────────────────────────────────────────────────────

const SYSTEM_PHASES: Array<{
  name: string;
  run: (world: WorldRow) => void | Promise<void>;
}> = [
  { name: 'needs',         run: () => needsTick() },
  { name: 'states',        run: () => statesTick() },
  { name: 'economy',       run: () => economyTick() },
  { name: 'relationships', run: (w) => relationshipsTick(w) },
  { name: 'conversations', run: () => conversationsTick() },
  { name: 'goals',         run: () => goalsTick() },
  { name: 'decisions',     run: (w) => decisionsTick(w) },
  { name: 'movement',      run: (w) => movementTick(w) },
  { name: 'events',        run: () => eventsTick() },
  { name: 'gossip',        run: (w) => gossipTick(gameMinutes(w.time)) },
  { name: 'cascade',       run: () => cascadeTick() },
];

/**
 * Run one system phase, logging (not propagating) any throw. Returns false when
 * the phase failed. Exported for tests.
 */
export async function runSystemPhase(
  phase: { name: string; run: (world: WorldRow) => void | Promise<void> },
  world: WorldRow,
  phaseNumber: number,
): Promise<boolean> {
  try {
    // Run phase. conversationsTick is async (dispatches LLM tasks) so we
    // await it — its synchronous DB work runs inside a transaction, but
    // the actual LLM dispatch happens asynchronously in the TaskRunner.
    if (phase.name === 'conversations') {
      // Async phase: conversationsTick queues LLM tasks outside the transaction
      await phase.run(world);
    } else {
      // Synchronous phases: wrap in a transaction for atomicity
      db.transaction(() => {
        phase.run(world);
      });
    }
    return true;
  } catch (error) {
    // A throw means the phase's transaction rolled back (conversationsTick runs
    // its own). The agent-states cache counts writes through triggers, but no
    // trigger fires on ROLLBACK: if the phase inserted a state and anything read
    // it before the throw, the snapshot now holds a state that was never
    // committed. Force a rebuild so later phases see the DB as it really is.
    invalidateAgentStatesCache();
    const message = error instanceof Error ? error.message : String(error);
    logActivity({
      type: 'error',
      templateData: { system: phase.name, message: `System phase ${phaseNumber} (${phase.name}) error: ${message}` },
    });
    return false;
  }
}

// ─── Main gameTick ────────────────────────────────────────────────────────────

/** Guards against overlapping autoplay analysis windows (see step 9 below). */
let isAnalyzing = false;

/**
 * One full tick: advance the clock, run every phase, finalize. Exported so
 * `scripts/soak.ts` can drive ticks back-to-back without the setTimeout loop;
 * the server only ever calls it through `startTickLoop`.
 */
export async function gameTick(): Promise<void> {
  // Whole-tick budget: `perfCollector.flush` compares this against
  // TICK_INTERVAL_MS, so it has to include the world read and clock advance,
  // not just the phase loop.
  const tickStart = performance.now();

  // 1. Read world state (better-sqlite3 is synchronous; use select for simplicity)
  const rows = db.select().from(worldState).limit(1).all();
  const world = rows[0];
  if (!world || world.is_paused) return;

  // 2. Advance clock
  const oldTime = world.time;
  const oldDayPhase = computeDayPhase(oldTime.hour);
  const newTime = advanceClock(oldTime, world.tick_speed);
  const newDayPhase = computeDayPhase(newTime.hour);

  // 3. Detect transitions
  const transitions = detectTransitions(oldTime, oldDayPhase, newTime, newDayPhase);

  // 4. Generate tick ID
  const tickId = crypto.randomBytes(6).toString('hex');

  // 5. Update world state with new clock + transitions
  db.update(worldState)
    .set({
      time: newTime,
      day_phase: newDayPhase,
      pending_transitions: transitions,
      tick_id: tickId,
      current_tick_phase: 1,
    })
    .where(eq(worldState.id, world.id))
    .run();

  // 6. Build updated world object for systems that need it (with new time)
  const worldWithNewTime: WorldRow = {
    ...world,
    time: newTime,
    day_phase: newDayPhase,
    pending_transitions: transitions,
    tick_id: tickId,
    current_tick_phase: 1,
  };

  // 7. Run the system phases sequentially
  const phaseMs: Array<[string, number]> = [];
  for (let i = 0; i < SYSTEM_PHASES.length; i++) {
    const phase = SYSTEM_PHASES[i];
    const phaseNumber = i + 1;
    const phaseStart = performance.now();

    await runSystemPhase(phase, worldWithNewTime, phaseNumber);
    phaseMs.push([phase.name, performance.now() - phaseStart]);

    // Only the autoplay analyzer drains these samples, and it only runs when
    // AUTOPLAY is enabled — recording unconditionally accumulated ~950k phase
    // samples a day in a process meant to stay up for days.
    if (CONFIG.AUTOPLAY.ENABLED) {
      autoPlayer.perf.recordPhase(phase.name, performance.now() - phaseStart);
    }

    // After the states phase completes, build the tick-level cache so that all
    // subsequent phases (economy, relationships, conversations, decisions,
    // movement, events) avoid per-agent DB round-trips for getAgentStates().
    if (phase.name === 'states') {
      cacheAllAgentStates();
    }

    // Update current_tick_phase after each successful phase
    db.update(worldState)
      .set({ current_tick_phase: phaseNumber })
      .where(eq(worldState.id, world.id))
      .run();
  }

  // Perception scan every 10 game minutes: agents observe and react to nearby
  // agents. Each step is guarded: unguarded, one throw here skipped the cache
  // clear, tick finalize and emitter flush below.
  //
  // Cadences are game-time boundaries, not `totalTicks % N`: counting ticks ran
  // these every 40 game minutes / 4 game hours at 4x, and nested the hourly
  // checks inside the 10-tick gate.
  const totalTicks = worldWithNewTime.time.totalTicks;
  const nowMinutes = gameMinutes(newTime);
  if (crossedBoundary(gameMinutes(oldTime), nowMinutes, 10)) {
    runGuarded('perception', () => perceptionSystem.scan(worldWithNewTime));
    runGuarded('tavern', () => tavernTick(nowMinutes));
  }
  // Loneliness and confrontation once per game hour.
  if (hourChanged(transitions)) {
    runGuarded('loneliness', () => lonelinessCheck(nowMinutes));
    runGuarded('confrontation', () => confrontationCheck(totalTicks));
  }

  // A tick longer than the loop interval slows the game clock itself (the next
  // tick waits for this one): at 4x a 3 s tick runs the town at ~1.3x. Say
  // which phase ate the time, at most once a minute.
  reportSlowTick(performance.now() - tickStart, phaseMs);

  // Record tick timing + LLM slot state for the autoplay profiler. Both the
  // samples and these two DB round-trips are pure overhead while autoplay is
  // off, which is the default.
  if (CONFIG.AUTOPLAY.ENABLED) {
    autoPlayer.perf.recordTick(performance.now() - tickStart);
    try {
      const scheduler = db.select({
        active_llm_conversations: conversationSchedulerState.active_llm_conversations,
      }).from(conversationSchedulerState).limit(1).get();
      const slotsInUse = (scheduler?.active_llm_conversations ?? []).length;
      const queueDepth = db.select({ n: sql<number>`count(*)` })
        .from(conversationQueue).get()?.n ?? 0;
      autoPlayer.perf.recordSlotState(slotsInUse, queueDepth);
    } catch { /* fresh DB */ }
  }

  // AutoPlay analysis window. Deliberately TICKS, not game time: the window is
  // a profiler sample of the loop itself (tick durations, slot state), and its
  // size is set in ticks from the autoplay router. `analyze` is not awaited, so a window that takes
  // longer than WINDOW_SIZE ticks would otherwise start a second run that
  // interleaves with the first over the same `perf.flush()` (which resets) and
  // history state. markDirty has to wait for the report it announces.
  if (
    CONFIG.AUTOPLAY.ENABLED &&
    newTime.totalTicks % CONFIG.AUTOPLAY.WINDOW_SIZE === 0 &&
    !isAnalyzing
  ) {
    isAnalyzing = true;
    // No markDirty here: nothing subscribes to an 'autoplay.report' channel, and
    // markDirty/flush no-op on unknown channels, so announcing the report only
    // read like a live-update path that does not exist. The UI polls instead.
    autoPlayer.analyze(worldWithNewTime)
      .catch(err => {
        console.warn('[autoplay] Analysis failed:', (err as Error).message);
      })
      .finally(() => {
        isAnalyzing = false;
      });
  }

  // Discard the tick-level cache before returning so stale data never leaks.
  clearAgentStatesCache();

  // Check if any agents should reflect (async, doesn't block tick)
  runGuarded('reflection', () => {
    const agentsToReflect = reflectionTrigger.check(nowMinutes);
    for (const agentId of agentsToReflect) {
      reflectionRunner.queueReflection(agentId);
    }
  });

  // On day change: run memory archival (tiered retention + summaries)
  const dayChanged = transitions.some(t => t.type === 'day_changed');
  // Memories and activity rows are stamped in ticks; their game-day retention is
  // converted at this speed (TickClock in gameClock.ts).
  const tickClock = { nowTicks: newTime.totalTicks, nowMinutes, tickSpeed: world.tick_speed };
  if (dayChanged) {
    runGuarded('memoryConsolidation', () => memoryConsolidator.consolidate(tickClock));
    // Regenerate self-descriptions for all agents (async, non-blocking)
    // Active only: self-description regeneration is an LLM call, and the dead
    // never change. Unfiltered, every corpse cost one generation per game day
    // for the rest of the run, and the result was never read by anything.
    runGuarded('selfDescriptions', () => {
      const allAgentIds = db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.is_active, true))
        .all();
      for (const { id } of allAgentIds) {
        void selfDescriptionGenerator.maybeRegenerate(id, newTime.day);
      }
    });
    // Memories written without a vector (a new world's seeded backstory).
    runGuarded('embeddingBackfill', () => { void runEmbeddingBackfill(() => memoryService.invalidateEmbeddings()); });
    // The Town Crier: yesterday's edition (async LLM call, low priority).
    if (CONFIG.AI.GAZETTE) runGuarded('gazette', () => { void writeIssue(); });
    // Refresh community reputation scores from accumulated facts
    runGuarded('reputation', () => refreshAllReputations());
    // Process mood momentum: yesterday's mood affects today's emotional baseline
    runGuarded('moodMomentum', () => processAllMoodMomentum());
    // Check for birthdays and handle aging
    runGuarded('aging', () => agingTick(newTime.day));
    // Enforce the activity log's declared retention tiers
    runGuarded('pruneActivityLog', () => pruneActivityLog(newTime.totalTicks, world.tick_speed));
    // Drop ordinary relationship events past their game-day retention (story
    // turning points are kept, capped per pair)
    runGuarded('pruneRelationshipEvents', () => pruneRelationshipEvents(gameMinutes(newTime)));
    // Cap the conversation archive (each row holds its full transcript)
    runGuarded('pruneEndedConversations', () => pruneEndedConversations());
    // A copy of the town as the new day starts (lib/saves.ts), last 3 kept.
    // Not awaited: the save pauses the loop itself, and it has to wait for
    // this very tick to finish first — awaiting it here would deadlock on
    // `stopTickLoopAndWait`. `autosave` never throws (it logs).
    //
    // A dynamic import because saves.ts imports this module (to pause and
    // resume the loop): a static import both ways made the pair a cycle, and
    // whichever loaded second saw the other half-initialised.
    if (CONFIG.SAVES.AUTOSAVE) {
      const day = newTime.day;
      runGuarded('autosave', () => {
        void import('../lib/saves')
          .then(({ autosave }) => autosave(day))
          .catch((err) => console.warn('[saves] autosave failed:', (err as Error).message));
      });
    }
  }

  // Checkpoint the in-memory sim state (hobbies, favors, tension, momentum,
  // drift baselines, trackers — see worldCaches.ts) once per game hour, so a
  // crash costs at most an hour of it. Game time, so the cadence holds at every
  // speed; after the day-change block, so the midnight checkpoint already holds
  // the new day's mood momentum.
  if (hourChanged(transitions)) {
    runGuarded('simSnapshots', () => { saveWorldCaches(); });
  }

  // 8. Finalize tick
  db.update(worldState)
    .set({
      pending_transitions: [],
      last_tick_completed: Date.now(),
      current_tick_phase: 0,
    })
    .where(eq(worldState.id, world.id))
    .run();

  // 9. Mark emitter dirty and flush
  emitter.markDirty('world.state');
  emitter.markDirty('activity.all');
  emitter.flush();
}

// ─── Tick loop ────────────────────────────────────────────────────────────────

let running = false;
let lastSlowTickReport = 0;
let slowTicksSinceReport = 0;

function reportSlowTick(totalMs: number, phaseMs: Array<[string, number]>): void {
  if (totalMs <= CONFIG.TICK_INTERVAL_MS) return;
  slowTicksSinceReport++;
  const now = Date.now();
  if (now - lastSlowTickReport < 60_000) return;
  lastSlowTickReport = now;
  const top = [...phaseMs].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([name, ms]) => `${name} ${Math.round(ms)} ms`).join(', ');
  console.warn(`[tick] ${slowTicksSinceReport} slow tick(s) in the last minute; latest ${Math.round(totalMs)} ms (${top})`);
  slowTicksSinceReport = 0;
}

let tickTimer: ReturnType<typeof setTimeout> | null = null;
let tickInFlight: Promise<void> | null = null;

export function startTickLoop(): void {
  if (running) return;
  running = true;

  function loop() {
    if (!running) return;
    const start = Date.now();

    tickInFlight = gameTick()
      .catch((err) => {
        console.error('[tick] Unhandled error in gameTick:', err);
      })
      .finally(() => {
        tickInFlight = null;
        if (!running) return;
        const elapsed = Date.now() - start;
        tickTimer = setTimeout(loop, Math.max(0, CONFIG.TICK_INTERVAL_MS - elapsed));
      });
  }

  loop();
}

/**
 * Whether the loop is scheduled to keep ticking. A save pauses it and must
 * resume only what it paused: after `resetToWizard` the loop is deliberately
 * left stopped, and a save taken then must not start it.
 */
export function isTickLoopRunning(): boolean {
  return running;
}

export function stopTickLoop(): void {
  running = false;
  if (tickTimer !== null) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

/** Stop the tick loop and wait for any in-flight tick to finish. */
export async function stopTickLoopAndWait(): Promise<void> {
  stopTickLoop();
  if (tickInFlight) {
    await tickInFlight;
  }
}
