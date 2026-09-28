import { describe, it, expect } from 'vitest';
import { gatheringBonus } from '../decisions';

const AVERAGE = 50;

describe('gatheringBonus', () => {
  it('gives an empty venue no pull at all', () => {
    expect(gatheringBonus(0, AVERAGE)).toBe(0);
  });

  it('makes a busier venue more inviting than a quieter one', () => {
    expect(gatheringBonus(3, AVERAGE)).toBeGreaterThan(gatheringBonus(1, AVERAGE));
  });

  it('stops rewarding extra bodies once the venue is packed', () => {
    expect(gatheringBonus(20, AVERAGE)).toBe(gatheringBonus(4, AVERAGE));
  });

  it('pulls harder on the warm than on the withdrawn', () => {
    expect(gatheringBonus(4, 90)).toBeGreaterThan(gatheringBonus(4, 10));
  });

  it('still nudges a recluse rather than exempting them', () => {
    expect(gatheringBonus(4, 0)).toBeGreaterThan(0);
  });

  it('stays small enough not to swamp a need-driven score', () => {
    // Needs contribute up to ~140 to the tavern score; the crowd must colour
    // the choice, not decide it.
    expect(gatheringBonus(20, 100)).toBeLessThan(40);
  });

  it('survives personality values outside the nominal range', () => {
    expect(gatheringBonus(2, -20)).toBe(gatheringBonus(2, 0));
    expect(gatheringBonus(2, 500)).toBe(gatheringBonus(2, 100));
  });
});
