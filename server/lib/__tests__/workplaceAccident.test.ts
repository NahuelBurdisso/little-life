import { describe, it, expect, afterEach, vi } from 'vitest';
import { accidentChancePerMinute, ACCIDENT_HAZARD, checkDeathTriggers } from '../lifeEventsEngine';

const rested = { currentAction: 'working', job: 'farmhand', energy: 70, activeStates: [] as Array<{ type: string; started_at: number; severity: number; metadata: Record<string, unknown> | null }> };

describe('workplace accident hazard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('only exposes risky jobs while working', () => {
    expect(accidentChancePerMinute({ ...rested, currentAction: 'idle' })).toBe(0);
    expect(accidentChancePerMinute({ ...rested, job: 'baker' })).toBe(0);
    expect(accidentChancePerMinute(rested)).toBe(ACCIDENT_HAZARD.BASE_PER_MINUTE);
  });

  it('is a rare event for a rested town, not a near-certain early death', () => {
    // The default cast has three risky workers. At full 9 h shifts the town
    // should see well under one accident death a season (28 days); the old flat
    // 0.005%/min made it ~90%.
    const perDay = 1 - Math.pow(1 - accidentChancePerMinute(rested), 540);
    const townPerSeason = 1 - Math.pow(1 - perDay, 3 * 28);
    expect(townPerSeason).toBeLessThan(0.3);
    // ...but not zero: the drama is still possible.
    expect(townPerSeason).toBeGreaterThan(0.05);
  });

  it('rises when the worker is exhausted or impaired', () => {
    const base = accidentChancePerMinute(rested);
    const tired = accidentChancePerMinute({ ...rested, energy: 10 });
    const hungover = accidentChancePerMinute({
      ...rested, activeStates: [{ type: 'hungover', started_at: 0, severity: 0.5, metadata: null }],
    });
    expect(tired).toBe(base * ACCIDENT_HAZARD.EXHAUSTED_MULTIPLIER);
    expect(hungover).toBe(base * ACCIDENT_HAZARD.IMPAIRED_MULTIPLIER);
  });

  it('rolls through checkDeathTriggers per game minute', () => {
    const roll = (energy: number, speed: number) => checkDeathTriggers(
      { id: 9101, name: 'Hand', age: 58 }, 10 * 1440, [], { mood: 60, hunger: 60, energy },
      'farmhand', 'working', true, 'spring', speed,
    );
    // Just above one rested minute's hazard: survives a 1x tick, not a 4x one.
    vi.spyOn(Math, 'random').mockReturnValue(ACCIDENT_HAZARD.BASE_PER_MINUTE * 1.5);
    expect(roll(70, 1)).toBeNull();
    expect(roll(70, 4)).toBe('accident');
    // Exhaustion alone is enough at 1x.
    expect(roll(10, 1)).toBe('accident');
  });
});
