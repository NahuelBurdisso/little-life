import { describe, it, expect, beforeEach } from 'vitest';
import { shouldRecordPerception, clearPerceptionDedup, PERCEPTION_REPEAT_MINUTES } from '../MemoryObserver';

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
