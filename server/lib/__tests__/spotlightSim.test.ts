import { describe, it, expect } from 'vitest';
import { DEFAULT_SIM, simulate } from '../../../scripts/spotlight-sim';

/**
 * Guards the measured effect of the spotlight budget (scripts/spotlight-sim.ts):
 * in a saturated 32-resident town more of the on-screen conversations get the
 * LLM than before, and off-screen drama keeps most of its share.
 */
describe('spotlight budget simulation', () => {
  for (const speed of [2, 4]) {
    it(`raises the on-screen LLM share at ${speed}x`, () => {
      const opts = { ...DEFAULT_SIM, speed, days: 2 };
      const before = simulate('before', opts);
      const after = simulate('after', opts);
      const share = (a: number, b: number) => a / Math.max(1, b);
      expect(share(after.onScreenLLM, after.onScreen)).toBeGreaterThan(share(before.onScreenLLM, before.onScreen) + 0.1);
      // The LLM keeps working as hard: the budget moves chats, it doesn't idle slots.
      expect(after.llmTotal).toBeGreaterThan(before.llmTotal * 0.9);
    });
  }
});
