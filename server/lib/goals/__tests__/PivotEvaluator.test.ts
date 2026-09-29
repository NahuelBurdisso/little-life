import { describe, it, expect } from 'vitest';
import { shouldPivot, shouldAbandonStale, computeEmotionalImportance } from '../PivotEvaluator';
import { PIVOT_THRESHOLD_MINUTES, STALE_ABANDON_MINUTES } from '../types';

describe('shouldPivot', () => {
  it('returns true when goal has no progress and exceeds threshold', () => {
    expect(shouldPivot(0, 0, PIVOT_THRESHOLD_MINUTES + 100)).toBe(true);
  });
  it('returns false when goal has progress', () => {
    expect(shouldPivot(0.5, 0, PIVOT_THRESHOLD_MINUTES + 100)).toBe(false);
  });
  it('returns false when already pivoted', () => {
    expect(shouldPivot(0, 1, PIVOT_THRESHOLD_MINUTES + 100)).toBe(false);
  });
  it('returns false when not stale enough', () => {
    expect(shouldPivot(0, 0, PIVOT_THRESHOLD_MINUTES - 100)).toBe(false);
  });
});

describe('shouldAbandonStale', () => {
  it('returns true when goal exceeds stale abandon threshold with no progress', () => {
    expect(shouldAbandonStale(0, STALE_ABANDON_MINUTES + 1)).toBe(true);
  });
  it('returns false when goal has progress', () => {
    expect(shouldAbandonStale(0.1, STALE_ABANDON_MINUTES + 1)).toBe(false);
  });
});

describe('computeEmotionalImportance', () => {
  it('returns higher importance for neurotic agents', () => {
    const base = computeEmotionalImportance(0.8, 3, { neuroticism: 50, impulsiveness: 50 });
    const neurotic = computeEmotionalImportance(0.8, 3, { neuroticism: 80, impulsiveness: 50 });
    expect(neurotic).toBeGreaterThan(base);
  });
  it('returns lower importance for impulsive agents', () => {
    const base = computeEmotionalImportance(0.8, 3, { neuroticism: 50, impulsiveness: 50 });
    const impulsive = computeEmotionalImportance(0.8, 3, { neuroticism: 50, impulsiveness: 80 });
    expect(impulsive).toBeLessThan(base);
  });
  it('scales with priority and days active', () => {
    const low = computeEmotionalImportance(0.3, 1, { neuroticism: 50, impulsiveness: 50 });
    const high = computeEmotionalImportance(0.9, 5, { neuroticism: 50, impulsiveness: 50 });
    expect(high).toBeGreaterThan(low);
  });
});
