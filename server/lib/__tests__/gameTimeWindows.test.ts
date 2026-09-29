import { describe, it, expect } from 'vitest';
import { gameMinutesToMs } from '../worldClock';
import { dailyChancePerTick } from '../../engine/systems/goals';
import { ReflectionTrigger } from '../memory/ReflectionTrigger';

describe('wall-clock windows in game time', () => {
  it('shrinks a game-time window in real time as the sim speeds up', () => {
    // One tick per second, tick_speed game minutes per tick.
    expect(gameMinutesToMs(60, 1)).toBe(60_000);
    expect(gameMinutesToMs(60, 4)).toBe(15_000);
    expect(gameMinutesToMs(60, 0.5)).toBe(120_000);
  });

  it('treats a frozen clock as 1x instead of dividing by zero', () => {
    expect(gameMinutesToMs(60, 0)).toBe(60_000);
  });
});

describe('goal abandonment chance per game day', () => {
  for (const speed of [1, 2, 4]) {
    it(`compounds back to the daily chance over a game day at ${speed}x`, () => {
      const perTick = dailyChancePerTick(0.3, speed);
      const ticksPerDay = 1440 / speed;
      expect(1 - Math.pow(1 - perTick, ticksPerDay)).toBeCloseTo(0.3, 10);
    });
  }
});

describe('ReflectionTrigger cooldown', () => {
  it('is 60 game minutes whatever the speed', () => {
    const trigger = new ReflectionTrigger(() => 10);
    trigger.onMemoryCreated(1, 20);
    expect(trigger.check(1000)).toEqual([1]);
    trigger.onMemoryCreated(1, 20);
    // It counted ticks: at 4x the cooldown lasted 4 game hours.
    expect(trigger.check(1059)).toEqual([]);
    expect(trigger.check(1060)).toEqual([1]);
  });
});
