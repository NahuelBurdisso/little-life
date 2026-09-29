import { describe, it, expect, vi } from 'vitest';
import { PlanLLMGate, PLAN_OUTAGE_THRESHOLD } from '../PlanLLMGate';

vi.mock('../../activityLogger', () => ({ logActivity: vi.fn() }));

describe('PlanLLMGate breaker notifications (health banner)', () => {
  it('tells listeners when the breaker opens and closes, not on every failure', () => {
    const gate = new PlanLLMGate(() => 0, { wallNow: () => 0, random: () => 0.5 });
    const seen = vi.fn();
    gate.onBreakerChange(seen);

    for (let i = 0; i < PLAN_OUTAGE_THRESHOLD - 1; i++) gate.recordFailure(i, 'fetch failed');
    expect(gate.breakerOpen).toBe(false);
    expect(seen).not.toHaveBeenCalled();

    gate.recordFailure(99, 'fetch failed');
    expect(gate.breakerOpen).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);

    // More failures while open: still one notification.
    gate.recordFailure(100, 'fetch failed');
    expect(seen).toHaveBeenCalledTimes(1);

    gate.noteAnswered();
    expect(gate.breakerOpen).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);

    // Answers while closed are silent.
    gate.noteAnswered();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('a throwing listener does not break planning', () => {
    const gate = new PlanLLMGate(() => 0, { wallNow: () => 0 });
    gate.onBreakerChange(() => { throw new Error('boom'); });
    expect(() => {
      for (let i = 0; i < PLAN_OUTAGE_THRESHOLD; i++) gate.recordFailure(i, 'x');
    }).not.toThrow();
  });
});
