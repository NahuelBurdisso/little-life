import { describe, it, expect, beforeEach } from 'vitest';
import { ReflectionTrigger } from '../ReflectionTrigger';

describe('ReflectionTrigger', () => {
  let trigger: ReflectionTrigger;

  beforeEach(() => {
    trigger = new ReflectionTrigger();
  });

  it('does not trigger before threshold is reached', () => {
    // 10 × importance 8 = 80, below BASE_THRESHOLD of 150
    for (let i = 0; i < 10; i++) {
      trigger.onMemoryCreated(1, 8);
    }
    const result = trigger.check(100);
    expect(result).toEqual([]);
  });

  it('triggers when cumulative importance exceeds 150', () => {
    // 20 × importance 8 = 160 > 150
    for (let i = 0; i < 20; i++) {
      trigger.onMemoryCreated(1, 8);
    }
    const result = trigger.check(100);
    expect(result).toContain(1);
  });

  it('resets accumulator after trigger so second check returns empty', () => {
    for (let i = 0; i < 20; i++) {
      trigger.onMemoryCreated(1, 8);
    }
    trigger.check(100);

    // Re-accumulate less than threshold
    for (let i = 0; i < 5; i++) {
      trigger.onMemoryCreated(1, 8);
    }
    const result = trigger.check(200);
    expect(result).toEqual([]);
  });

  it('respects cooldown — triggers at tick 100, not at tick 110, but again at tick 161', () => {
    // First trigger at tick 100
    for (let i = 0; i < 20; i++) {
      trigger.onMemoryCreated(1, 8);
    }
    const first = trigger.check(100);
    expect(first).toContain(1);

    // Re-accumulate enough to cross threshold again
    for (let i = 0; i < 20; i++) {
      trigger.onMemoryCreated(1, 8);
    }

    // Tick 110 — only 10 ticks since last reflection, cooldown is 60
    const tooSoon = trigger.check(110);
    expect(tooSoon).toEqual([]);

    // Tick 161 — 61 ticks since last reflection at tick 100, cooldown passed
    const afterCooldown = trigger.check(161);
    expect(afterCooldown).toContain(1);
  });

  it('tracks multiple agents independently', () => {
    // Agent 1: crosses threshold (20 × 8 = 160)
    for (let i = 0; i < 20; i++) {
      trigger.onMemoryCreated(1, 8);
    }
    // Agent 2: does not cross threshold (10 × 8 = 80)
    for (let i = 0; i < 10; i++) {
      trigger.onMemoryCreated(2, 8);
    }

    const result = trigger.check(100);
    expect(result).toContain(1);
    expect(result).not.toContain(2);
  });

  it('clear() resets all accumulators and cooldowns', () => {
    // Build up enough for a trigger
    for (let i = 0; i < 20; i++) {
      trigger.onMemoryCreated(1, 8);
    }
    // Trigger to set a cooldown
    trigger.check(100);

    trigger.clear();

    // After clear, re-accumulate enough for another trigger
    for (let i = 0; i < 20; i++) {
      trigger.onMemoryCreated(1, 8);
    }
    // Cooldown should be gone — even at tick 101 it should fire
    const result = trigger.check(101);
    expect(result).toContain(1);
  });

  it('uses a custom threshold function', () => {
    // Custom threshold of 50 — 7 × 8 = 56 > 50
    const customTrigger = new ReflectionTrigger(() => 50);
    for (let i = 0; i < 7; i++) {
      customTrigger.onMemoryCreated(1, 8);
    }
    const result = customTrigger.check(100);
    expect(result).toContain(1);
  });
});
