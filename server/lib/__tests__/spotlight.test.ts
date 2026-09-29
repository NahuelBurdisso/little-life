import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearSpotlight,
  getSpotlight,
  isAnyWatched,
  isWatched,
  setSpotlight,
  SPOTLIGHT_MAX_AGENTS,
  SPOTLIGHT_TTL_MS,
} from '../spotlight';

describe('spotlight', () => {
  beforeEach(() => clearSpotlight());

  it('watches the ids it was given until the TTL runs out', () => {
    const t0 = 1_000_000;
    setSpotlight([3, 7], t0);
    expect(isWatched(3, t0)).toBe(true);
    expect(isWatched(4, t0)).toBe(false);
    expect(isWatched(7, t0 + SPOTLIGHT_TTL_MS - 1)).toBe(true);
    expect(isWatched(7, t0 + SPOTLIGHT_TTL_MS)).toBe(false);
    expect(getSpotlight(t0 + SPOTLIGHT_TTL_MS)).toEqual([]);
  });

  it('a refresh restarts the TTL and replaces the set', () => {
    const t0 = 5_000;
    setSpotlight([1], t0);
    setSpotlight([2], t0 + 50_000);
    expect(isWatched(1, t0 + 50_000)).toBe(false);
    expect(isWatched(2, t0 + 50_000 + SPOTLIGHT_TTL_MS - 1)).toBe(true);
  });

  it('a pair is watched when either participant is', () => {
    setSpotlight([9], 0);
    expect(isAnyWatched([4, 9], 1)).toBe(true);
    expect(isAnyWatched([4, 5], 1)).toBe(false);
    expect(isAnyWatched([4, 9], SPOTLIGHT_TTL_MS)).toBe(false);
  });

  it('an empty set watches nobody, and clear forgets everything', () => {
    setSpotlight([], 0);
    expect(getSpotlight(1)).toEqual([]);
    setSpotlight([2], 0);
    clearSpotlight();
    expect(isWatched(2, 1)).toBe(false);
  });

  it('drops invalid ids and caps the set', () => {
    setSpotlight([0, -1, 1.5, 2], 0);
    expect(getSpotlight(1)).toEqual([2]);
    setSpotlight(Array.from({ length: 100 }, (_, i) => i + 1), 0);
    expect(getSpotlight(1)).toHaveLength(SPOTLIGHT_MAX_AGENTS);
  });
});
