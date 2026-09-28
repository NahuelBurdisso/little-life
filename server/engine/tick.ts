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
import { cacheAllAgentStates, clearAgentStatesCache, invalidateAgentStatesCache } from '../lib/states';
import { reflectionTrigger, reflectionRunner, memoryConsolidator, selfDescriptionGenerator } from '../lib/memory/instance';
import { perceptionSystem } from '../lib/perception/instance';
import { refreshAllReputations } from '../lib/reputationEngine';
import { processAllMoodMomentum } from '../lib/moodMomentum';
import { tavernTick } from '../lib/tavernEngine';
import { lonelinessCheck } from '../lib/lonelinessEngine';
import { confrontationCheck } from '../lib/confrontationEngine';
import { agingTick } from '../lib/agingEngine';
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
  { name: 'gossip',        run: (w) => gossipTick(w.time.totalTicks) },
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
  for (let i = 0; i < SYSTEM_PHASES.length; i++) {
    const phase = SYSTEM_PHASES[i];
    const phaseNumber = i + 1;
    const phaseStart = performance.now();

    await runSystemPhase(phase, worldWithNewTime, phaseNumber);

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

  // Perception scan every 10 ticks: agents observe and react to nearby agents
  // Each step is guarded: unguarded, one throw here skipped the cache clear,
  // tick finalize and emitter flush below.
  const totalTicks = worldWithNewTime.time.totalTicks;
  if (totalTicks % 10 === 0) {
    runGuarded('perception', () => perceptionSystem.scan(worldWithNewTime));
    runGuarded('tavern', () => tavernTick(totalTicks));
    // Check loneliness every 60 ticks (~1 game hour)
    if (totalTicks % 60 === 0) {
      runGuarded('loneliness', () => lonelinessCheck(totalTicks));
      runGuarded('confrontation', () => confrontationCheck(totalTicks));
    }
  }

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

  // AutoPlay analysis window. `analyze` is not awaited, so a window that takes
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
    const agentsToReflect = reflectionTrigger.check(totalTicks);
    for (const agentId of agentsToReflect) {
      reflectionRunner.queueReflection(agentId);
    }
  });

  // On day change: run memory archival (tiered retention + summaries)
  const dayChanged = transitions.some(t => t.type === 'day_changed');
  if (dayChanged) {
    runGuarded('memoryConsolidation', () => memoryConsolidator.consolidate(newTime.day, newTime.totalTicks));
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
    // Refresh community reputation scores from accumulated facts
    runGuarded('reputation', () => refreshAllReputations());
    // Process mood momentum: yesterday's mood affects today's emotional baseline
    runGuarded('moodMomentum', () => processAllMoodMomentum());
    // Check for birthdays and handle aging
    runGuarded('aging', () => agingTick(newTime.day));
    // Enforce the activity log's declared retention tiers
    runGuarded('pruneActivityLog', () => pruneActivityLog(newTime.totalTicks));
    // Drop processed relationship events older than every reader's window
    runGuarded('pruneRelationshipEvents', () => pruneRelationshipEvents());
    // Cap the conversation archive (each row holds its full transcript)
    runGuarded('pruneEndedConversations', () => pruneEndedConversations());
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
