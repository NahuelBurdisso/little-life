import { describe, it, expect } from 'vitest';
import { startingNeeds } from '../startingNeeds';
import { CONFIG } from '../constants';

describe('startingNeeds', () => {
  it('draws every need inside its configured range', () => {
    const lo = startingNeeds(() => 0);
    const hi = startingNeeds(() => 0.999999);
    for (const k of ['hunger', 'energy', 'social', 'comfort', 'fun'] as const) {
      const [min, max] = CONFIG.NEEDS.STARTING_RANGES[k];
      expect(lo[k]).toBe(min);
      expect(hi[k]).toBe(max - 1);
    }
  });

  it('never opens anyone near the loneliness or stress lines (E7)', () => {
    // lonely fires under social 20; stressed needs three needs under 35. A
    // fresh agent should be a full day of decay away from either.
    const { THRESHOLDS } = CONFIG.NEEDS;
    const worst = startingNeeds(() => 0);
    expect(worst.social).toBeGreaterThanOrEqual(THRESHOLDS.low + 15);
    expect(worst.fun).toBeGreaterThanOrEqual(THRESHOLDS.low + 15);
    const lowCount = Object.values(worst).filter((v) => v < THRESHOLDS.low).length;
    expect(lowCount).toBe(0);
  });
});
