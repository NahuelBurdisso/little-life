import { describe, it, expect, beforeEach } from 'vitest';
import { shouldRecordPerception, clearPerceptionDedup, PERCEPTION_REPEAT_MINUTES, shouldRecordWorldEvent, WORLD_EVENT_MEMORY_REPEAT_MINUTES } from '../MemoryObserver';

describe('shouldRecordPerception', () => {
  beforeEach(() => clearPerceptionDedup());

  it('stores a line once per window, per agent', () => {
    const line = 'I noticed Diego Santos nearby.';
    expect(shouldRecordPerception(1, line, 100)).toBe(true);
    expect(shouldRecordPerception(1, line, 150)).toBe(false);
    expect(shouldRecordPerception(2, line, 150)).toBe(true);
    expect(shouldRecordPerception(1, 'I noticed Rosa Chen nearby.', 150)).toBe(true);
    expect(shouldRecordPerception(1, line, 100 + PERCEPTION_REPEAT_MINUTES)).toBe(true);
  });

  it('does not get stuck when the clock goes backwards (world replaced)', () => {
    expect(shouldRecordPerception(1, 'x', 5000)).toBe(true);
    expect(shouldRecordPerception(1, 'x', 10)).toBe(true);
  });
});

describe('shouldRecordWorldEvent (playtest #3: Bountiful Catch x52 memories)', () => {
  beforeEach(() => clearPerceptionDedup());

  it('stores one memory per resident per event name inside the window', () => {
    expect(shouldRecordWorldEvent(1, 'Bountiful Catch', 100)).toBe(true);
    expect(shouldRecordWorldEvent(1, 'Bountiful Catch', 100)).toBe(false); // same instance, re-emitted
    expect(shouldRecordWorldEvent(1, 'bountiful catch ', 900)).toBe(false); // the next one, hours later
    expect(shouldRecordWorldEvent(2, 'Bountiful Catch', 900)).toBe(true);
    expect(shouldRecordWorldEvent(1, 'Full Moon', 900)).toBe(true);
    expect(shouldRecordWorldEvent(1, 'Bountiful Catch', 100 + WORLD_EVENT_MEMORY_REPEAT_MINUTES)).toBe(true);
  });
});
