import { db } from '../db';
import { worldState } from '../db/schema';
import { gameMinutes } from './gameClock';
import { CONFIG } from './constants';

/**
 * The world's clock right now, in whole GAME MINUTES (`gameMinutes`). The unit
 * every game-time stamp is written in: agent actions and states, world events,
 * goals and aspirations, and the in-memory cooldowns of the engines that run
 * outside a phase's world row. For code that doesn't already hold the world
 * row; phases that do should call `gameMinutes(world.time)` instead of paying
 * for a read.
 *
 * Kept apart from gameClock.ts because that module is pure and imported by the
 * client.
 */
export function gameMinutesNow(): number {
  const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  return world?.time ? gameMinutes(world.time) : 0;
}

/** Speed 0 only ever comes with the world paused (no phase runs); treat it as 1x. */
function effectiveSpeed(tickSpeed: number): number {
  return tickSpeed > 0 ? tickSpeed : 1;
}

/**
 * Wall-clock milliseconds the tick loop takes to live `minutes` game minutes at
 * `tickSpeed`: one tick per TICK_INTERVAL_MS, `tickSpeed` game minutes per tick.
 *
 * For "in the last N game minutes" windows over tables stamped with Date.now()
 * (conversations, relationship_events). Written
 * as a fixed number of ms, those windows covered four times the game time at 4x.
 * Approximate: it assumes the current speed held across the window and counts
 * paused time as elapsed, which is fine for "recently".
 */
export function gameMinutesToMs(minutes: number, tickSpeed: number): number {
  return (minutes / effectiveSpeed(tickSpeed)) * CONFIG.TICK_INTERVAL_MS;
}
