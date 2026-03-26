import { db } from '../db';
import { worldState, activityLog } from '../db/schema';
import { eq } from 'drizzle-orm';
import { emitter } from './emitter';
import { needsTick } from './systems/needs';
import { statesTick } from './systems/states';
import { economyTick } from './systems/economy';
import { tick as relationshipsTick } from './systems/relationships';
import { conversationsTick } from './systems/conversations';
import { tick as decisionsTick } from './systems/decisions';
import { tick as movementTick } from './systems/movement';
import { eventsTick } from './systems/events';
import { CONFIG } from '../lib/constants';
import { cacheAllAgentStates, clearAgentStatesCache } from '../lib/states';
import crypto from 'crypto';

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

function computeDayPhase(hour: number): DayPhase {
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'evening';
  return 'night';
}

function advanceClock(time: WorldRow['time'], tickSpeed: number): WorldRow['time'] {
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

function detectTransitions(
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
  { name: 'decisions',     run: (w) => decisionsTick(w) },
  { name: 'movement',      run: (w) => movementTick(w) },
  { name: 'events',        run: () => eventsTick() },
];

// ─── Main gameTick ────────────────────────────────────────────────────────────

async function gameTick(): Promise<void> {
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

  // 7. Run 7 system phases sequentially
  for (let i = 0; i < SYSTEM_PHASES.length; i++) {
    const phase = SYSTEM_PHASES[i];
    const phaseNumber = i + 1;

    try {
      // Run phase. conversationsTick is async (dispatches LLM tasks) so we
      // await it — its synchronous DB work runs inside a transaction, but
      // the actual LLM dispatch happens asynchronously in the TaskRunner.
      if (phase.name === 'conversations') {
        // Async phase: conversationsTick queues LLM tasks outside the transaction
        await phase.run(worldWithNewTime);
      } else {
        // Synchronous phases: wrap in a transaction for atomicity
        db.transaction(() => {
          phase.run(worldWithNewTime);
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const realNow = Date.now();
      db.insert(activityLog)
        .values({
          type: 'error',
          message: `System phase ${phaseNumber} (${phase.name}) error: ${message}`,
          agent_ids: [],
          timestamp: newTime.totalTicks,
          real_timestamp: realNow,
        })
        .run();
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

  // Discard the tick-level cache before returning so stale data never leaks.
  clearAgentStatesCache();

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

export function startTickLoop(): void {
  if (running) return;
  running = true;

  function loop() {
    if (!running) return;
    const start = Date.now();

    gameTick()
      .catch((err) => {
        console.error('[tick] Unhandled error in gameTick:', err);
      })
      .finally(() => {
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
