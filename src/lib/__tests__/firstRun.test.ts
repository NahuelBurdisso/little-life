import { describe, it, expect } from 'vitest';
import {
  hasSeen,
  initialPhase,
  markSeen,
  phaseAfterCoach,
  phaseAfterTour,
  worldSeedKey,
  type KeyValueStore,
} from '../firstRun';

function fakeStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('worldSeedKey', () => {
  it('combines the resolved worldgen seed and the scenario seed', () => {
    expect(worldSeedKey({ worldgen: { seed: 'w1' }, scenario: { seed: 's1' } })).toBe('w1|s1');
  });

  it('still identifies a world saved with only one of them', () => {
    expect(worldSeedKey({ worldgen: { seed: 'w1' } })).toBe('w1|');
    expect(worldSeedKey({ scenario: { seed: 's1' } })).toBe('|s1');
  });

  it('is null when nothing identifies the world', () => {
    expect(worldSeedKey(null)).toBeNull();
    expect(worldSeedKey({})).toBeNull();
    expect(worldSeedKey({ worldgen: { seed: 42 } })).toBeNull();
  });
});

describe('seen-once storage', () => {
  it('remembers per topic and per world', () => {
    const store = fakeStore();
    expect(hasSeen('tour', 'w|s', store)).toBe(false);
    markSeen('tour', 'w|s', store);
    expect(hasSeen('tour', 'w|s', store)).toBe(true);
    expect(hasSeen('coach', 'w|s', store)).toBe(false);
    expect(hasSeen('tour', 'other|s', store)).toBe(false);
  });

  it('survives storage that throws or is missing', () => {
    expect(hasSeen('tour', 'k', throwing)).toBe(false);
    expect(() => markSeen('tour', 'k', throwing)).not.toThrow();
    expect(hasSeen('tour', 'k', null)).toBe(false);
    expect(() => markSeen('tour', 'k', null)).not.toThrow();
  });
});

describe('guide flow', () => {
  it('shows the tour, then the coach marks, then nothing', () => {
    const store = fakeStore();
    expect(initialPhase('k', store)).toBe('tour');
    expect(phaseAfterTour('k', store)).toBe('coach');
    expect(initialPhase('k', store)).toBe('coach');
    expect(phaseAfterCoach('k', store)).toBe('idle');
    expect(initialPhase('k', store)).toBe('idle');
  });

  it('goes straight back to idle when a replayed tour finds the marks already seen', () => {
    const store = fakeStore();
    markSeen('coach', 'k', store);
    expect(phaseAfterTour('k', store)).toBe('idle');
  });

  it('does not write anything for a world it cannot identify', () => {
    const store = fakeStore();
    expect(phaseAfterTour(null, store)).toBe('idle');
    expect(phaseAfterCoach(null, store)).toBe('idle');
    expect(store.data.size).toBe(0);
  });
});
