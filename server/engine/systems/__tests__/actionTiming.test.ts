import { describe, it, expect } from 'vitest';
import { advanceClock } from '../../tick';
import { isActionComplete } from '../decisions';
import { interiorTransitionDuration } from '../movement';
import { gameMinutes } from '../../../lib/gameClock';
import { CONFIG } from '../../../lib/constants';

type Time = Parameters<typeof advanceClock>[0];

const START: Time = { day: 1, hour: 22, minute: 15, totalTicks: 5000, seasonDay: 1, season: 'spring' };

function sleeper(time: Time, duration: number) {
  // Only the fields isActionComplete reads; `sleeping` never hits the DB path.
  return {
    current_action: { type: 'sleeping' },
    current_destination: null,
    action_started: gameMinutes(time),
    action_duration: duration,
  } as unknown as Parameters<typeof isActionComplete>[0];
}

/** Advance the real clock at `speeds[i]` for tick i (last speed repeats) until the action ends. */
function ticksUntilComplete(duration: number, speeds: number[]): { ticks: number; minutes: number } {
  let time = START;
  const agent = sleeper(time, duration);
  let ticks = 0;
  while (!isActionComplete(agent, gameMinutes(time))) {
    time = advanceClock(time, speeds[Math.min(ticks, speeds.length - 1)]);
    ticks++;
    if (ticks > 10_000) throw new Error('action never completed');
  }
  return { ticks, minutes: gameMinutes(time) - gameMinutes(START) };
}

describe('action durations are game minutes', () => {
  const sleep = CONFIG.DECISIONS.ACTION_MIN_DURATIONS.sleeping; // 360

  it('ends a night of sleep after 360 game minutes at every speed', () => {
    // Before the fix both sides were ticks: at 4x a 360 "minute" sleep took 360
    // ticks = 1440 game minutes, and the whole town slept round the clock.
    expect(ticksUntilComplete(sleep, [1])).toEqual({ ticks: 360, minutes: 360 });
    expect(ticksUntilComplete(sleep, [2])).toEqual({ ticks: 180, minutes: 360 });
    expect(ticksUntilComplete(sleep, [4])).toEqual({ ticks: 90, minutes: 360 });
  });

  it('survives a speed change mid-action', () => {
    // 100 ticks at 1x (100 min), then 4x for the remaining 260 min = 65 ticks.
    const speeds = [...Array(100).fill(1), 4];
    expect(ticksUntilComplete(sleep, speeds)).toEqual({ ticks: 165, minutes: 360 });
  });

  it('does not advance while the clock is frozen at speed 0', () => {
    let time = START;
    const agent = sleeper(time, 10);
    for (let i = 0; i < 50; i++) time = advanceClock(time, 0);
    expect(isActionComplete(agent, gameMinutes(time))).toBe(false);
  });
});

describe('interior transition padding', () => {
  it('is a whole number of game minutes covering the 5-tick lerp at every speed', () => {
    for (const speed of [0.5, 1, 2, 4]) {
      const duration = interiorTransitionDuration(30, speed)!;
      expect(Number.isInteger(duration)).toBe(true);
      expect(duration - 30).toBeGreaterThanOrEqual(5 * speed);
    }
    expect(interiorTransitionDuration(30, 0.5)).toBe(33); // 2.5 rounded up, not a REAL 32.5
    expect(interiorTransitionDuration(30, 1)).toBe(35);
    expect(interiorTransitionDuration(0, 1)).toBeNull();
  });
});
