import { describe, it, expect } from 'vitest';
import { gameMinutesToMs } from '../worldClock';
import { chancePerTick, eventMinutesLeft } from '../gameClock';
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

describe('chancePerTick (per-game-minute hazards)', () => {
  it('is the authored chance, bit for bit, at 1x', () => {
    for (const p of [0.0001, 0.005, 0.01, 0.02, 0.3]) expect(chancePerTick(p, 1)).toBe(p);
  });

  for (const speed of [0.5, 2, 4]) {
    it(`gives the same odds per game hour at ${speed}x as at 1x`, () => {
      const p = 0.01;
      const ticksPerHour = 60 / speed;
      const perHour = 1 - Math.pow(1 - chancePerTick(p, speed), ticksPerHour);
      expect(perHour).toBeCloseTo(1 - Math.pow(1 - p, 60), 10);
    });
  }

  it('rolls nothing while paused and saturates at certainty', () => {
    expect(chancePerTick(0.5, 0)).toBe(0);
    expect(chancePerTick(0, 4)).toBe(0);
    expect(chancePerTick(1, 4)).toBe(1);
  });
});

describe('eventMinutesLeft (EventMenu "time left")', () => {
  it('counts down from started_at + duration hours, in game minutes', () => {
    const storm = { started_at: 5000, duration: 3 }; // 3 game hours
    expect(eventMinutesLeft(storm, 5000)).toBe(180);
    expect(eventMinutesLeft(storm, 5135)).toBe(45);
    expect(eventMinutesLeft(storm, 5180)).toBe(0);
    expect(eventMinutesLeft(storm, 6000)).toBe(0); // overdue, not negative
  });
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
