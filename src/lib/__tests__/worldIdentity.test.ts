import { describe, it, expect } from 'vitest';
import { isWorldReplaced } from '../worldIdentity';

describe('isWorldReplaced', () => {
  it('is false while the clock moves forward or stands still (paused)', () => {
    expect(isWorldReplaced(100, 101)).toBe(false);
    expect(isWorldReplaced(100, 100)).toBe(false);
  });

  it('is true when the clock runs backwards (restart / reseed / reset)', () => {
    expect(isWorldReplaced(5000, 0)).toBe(true);
    expect(isWorldReplaced(5000, 12)).toBe(true);
  });

  it('never fires without a previous or current reading', () => {
    expect(isWorldReplaced(null, 0)).toBe(false);
    expect(isWorldReplaced(5000, null)).toBe(false);
    expect(isWorldReplaced(null, null)).toBe(false);
  });
});
