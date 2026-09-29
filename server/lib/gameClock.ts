/**
 * Game-time helpers.
 *
 * The sim has two clocks and they only agree at tick_speed 1:
 *
 * - TICKS (`world.time.totalTicks`): one per loop iteration, i.e. one per real
 *   second. Right for things that are about the loop itself (perf windows,
 *   per-tick animation like the 5-tick interior lerp).
 * - GAME MINUTES (`gameMinutes(world.time)`): the in-world clock. One tick
 *   advances it by `tick_speed` minutes (1, 2 or 4 in the UI).
 *
 * Anything a player reads as "how long" or "how often" — a night's sleep, a
 * shift, "once per game hour" — has to be measured in game minutes. Counting
 * ticks instead made sleep last 24 game hours at 4x (the whole town slept a
 * full day), and gating on `minute === 0` never fired at 2x/4x once the clock
 * started off an even minute.
 */

export interface ClockTime {
  day: number;
  hour: number;
  minute: number;
}

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 1440;

/**
 * Absolute whole game minutes since day 0, 00:00. Monotonic, unlike
 * `minute`/`hour`, and the one conversion every system uses (the planning
 * layer's former `gameMinuteOf` counted from day 1; its stamps are in-memory
 * and relative, so the one-day shift is invisible).
 *
 * Floored: at tick_speed 0.5 the clock's `minute` is fractional, and these
 * values are stored in INTEGER columns (`agents.action_started`,
 * `agent_states.started_at`, `world_events.started_at`, `needs.last_updated`).
 * SQLite would quietly keep 90.5 as a REAL under INTEGER affinity, so nothing
 * broke, but the column types would lie. Durations lose nothing: at 0.5x two
 * consecutive ticks share a minute, and elapsed time is still exact at every
 * whole minute.
 */
export function gameMinutes(time: ClockTime): number {
  return Math.floor(time.day * MINUTES_PER_DAY + time.hour * MINUTES_PER_HOUR + time.minute);
}

/**
 * True when the clock crossed a `period`-minute boundary (shifted by `offset`)
 * on the step from `prevMinutes` to `nowMinutes`.
 *
 * This is the speed-independent replacement for `minute === 0` and
 * `totalTicks % N === 0`: at 4x the clock steps 15, 19, 23, ... and never lands
 * on minute 0, but it crosses every hour boundary exactly once. A boundary
 * landed on exactly counts as crossed; the previous position does not, so a
 * boundary is never counted twice across consecutive steps. A step that does
 * not move the clock (speed 0) crosses nothing.
 *
 * `offset` places the boundary inside the period — e.g. `period = 1440,
 * offset = 6 * 60` is "06:00 every day".
 */
export function crossedBoundary(
  prevMinutes: number,
  nowMinutes: number,
  period: number,
  offset = 0,
): boolean {
  if (nowMinutes <= prevMinutes || period <= 0) return false;
  return Math.floor((nowMinutes - offset) / period) !== Math.floor((prevMinutes - offset) / period);
}

type Transitions = ReadonlyArray<{ type?: unknown }> | null | undefined;

/**
 * Did this tick's clock advance cross an hour boundary? Reads the
 * `pending_transitions` tick.ts computes from the old and new clock before any
 * phase runs, so it is exact even if `tick_speed` changes mid-tick (the speed
 * mutation can land while the async conversations phase is awaited, and a
 * phase that re-derived "previous time" from the stored speed would be off).
 */
export function hourChanged(transitions: Transitions): boolean {
  return transitions?.some((t) => t.type === 'hour_changed') ?? false;
}

/** Did this tick's clock advance roll over to a new game day? See `hourChanged`. */
export function dayChanged(transitions: Transitions): boolean {
  return transitions?.some((t) => t.type === 'day_changed') ?? false;
}
