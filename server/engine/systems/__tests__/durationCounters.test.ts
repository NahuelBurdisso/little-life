import { describe, it, expect, beforeEach } from 'vitest';
import { updateWorkTracking, clearConsecutiveWorkMinutes } from '../needs';
import { updateHungerTracking, hungerZeroMinutes, clearHungerTracking } from '../../../lib/lifeEventsEngine';

// These run once per tick and used to add 1, so every gate behind them
// (6 hours of overwork, 3 days of starvation) stretched by tick_speed.
describe('per-tick duration counters accumulate game minutes', () => {
  beforeEach(() => {
    clearConsecutiveWorkMinutes();
    clearHungerTracking();
  });

  it('reaches the 6-hour overwork gate after 6 game hours at 4x', () => {
    let minutes = 0;
    let ticks = 0;
    while (minutes <= 360) {
      minutes = updateWorkTracking(1, true, 4);
      ticks++;
    }
    expect(ticks).toBe(91); // 364 game minutes, the first tick past 360
    expect(updateWorkTracking(1, false, 4)).toBe(0); // a break resets it
  });

  it('counts starvation in game minutes', () => {
    for (let i = 0; i < 1080; i++) updateHungerTracking(7, 0, 4);
    expect(hungerZeroMinutes.get(7)).toBe(4320); // 3 game days in 1080 ticks at 4x
    updateHungerTracking(7, 5, 4);
    expect(hungerZeroMinutes.has(7)).toBe(false);
  });
});
