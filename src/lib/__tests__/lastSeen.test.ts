import { describe, it, expect } from 'vitest';
import {
  RECAP_GAP_MINUTES, describeSpan, lastSeenKey, readLastSeen, recapSince, skipRecapStep, writeLastSeen,
} from '../lastSeen';
import type { KeyValueStore } from '../firstRun';

function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

const throwing: KeyValueStore = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('quota'); },
};

describe('lastSeen storage', () => {
  it('round-trips per world key', () => {
    const store = memoryStore();
    writeLastSeen('seedA|s1', 1234, store);
    writeLastSeen('seedB|s2', 99, store);
    expect(readLastSeen('seedA|s1', store)).toBe(1234);
    expect(readLastSeen('seedB|s2', store)).toBe(99);
    expect(readLastSeen('never', store)).toBeNull();
    expect(store.map.has(lastSeenKey('seedA|s1'))).toBe(true);
  });

  it('floors fractional minutes (0.5x clocks) and ignores nonsense', () => {
    const store = memoryStore();
    writeLastSeen('w', 100.5, store);
    expect(readLastSeen('w', store)).toBe(100);
    writeLastSeen('w', -5, store);
    writeLastSeen('w', Number.NaN, store);
    expect(readLastSeen('w', store)).toBe(100);
    store.map.set(lastSeenKey('x'), 'garbage');
    expect(readLastSeen('x', store)).toBeNull();
    store.map.set(lastSeenKey('y'), '');
    expect(readLastSeen('y', store)).toBeNull();
  });

  it('survives storage that throws or is missing', () => {
    expect(() => writeLastSeen('w', 10, throwing)).not.toThrow();
    expect(readLastSeen('w', throwing)).toBeNull();
    expect(readLastSeen('w', null)).toBeNull();
  });
});

describe('recapSince', () => {
  it('offers a recap from the mark after a gap of six game hours or more', () => {
    expect(recapSince(1000, 1000 + RECAP_GAP_MINUTES)).toBe(1000);
    expect(recapSince(1000, 1000 + 3 * 1440)).toBe(1000);
  });

  it('stays quiet for a short gap', () => {
    expect(recapSince(1000, 1000 + RECAP_GAP_MINUTES - 1)).toBeNull();
    expect(recapSince(1000, 1000)).toBeNull();
  });

  it('never recaps a world this browser has not seen (brand-new world)', () => {
    expect(recapSince(null, 5000)).toBeNull();
  });

  it('never recaps when the clock is behind the mark (restart replays the seed)', () => {
    expect(recapSince(9000, 480)).toBeNull();
  });
});

describe('skipRecapStep', () => {
  const running = (startMinute: number) => ({ active: true, startMinute, lastStop: null });
  const stopped = (reason: string) => ({ active: false, startMinute: null, lastStop: { reason } });

  it('remembers the start while a skip runs, then recaps from it once when it stops', () => {
    let s = skipRecapStep(null, running(4000));
    expect(s).toEqual({ watchedStart: 4000, recapSince: null });
    s = skipRecapStep(s.watchedStart, running(4000));
    expect(s.recapSince).toBeNull();
    s = skipRecapStep(s.watchedStart, stopped('morning'));
    expect(s).toEqual({ watchedStart: null, recapSince: 4000 });
    // The same stopped status seen again (another refetch) doesn't recap twice.
    expect(skipRecapStep(s.watchedStart, stopped('morning')).recapSince).toBeNull();
  });

  it('recaps a skip cut short by someone waking, too', () => {
    expect(skipRecapStep(4000, stopped('woke')).recapSince).toBe(4000);
  });

  it('ignores a skip it never saw running and one ended by a world replace', () => {
    expect(skipRecapStep(null, stopped('morning')).recapSince).toBeNull();
    expect(skipRecapStep(4000, stopped('world_replaced'))).toEqual({ watchedStart: null, recapSince: null });
  });
});

describe('describeSpan', () => {
  it('says hours and days in words', () => {
    expect(describeSpan(0, 60)).toBe('1 hour');
    expect(describeSpan(0, 9 * 60)).toBe('9 hours');
    expect(describeSpan(0, 24 * 60)).toBe('1 day');
    expect(describeSpan(0, 51 * 60)).toBe('2 days, 3 hours');
    expect(describeSpan(100, 50)).toBe('0 hours');
  });
});
