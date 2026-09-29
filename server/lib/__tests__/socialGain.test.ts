import { describe, it, expect } from 'vitest';
import {
  llmSocialGain,
  templateSocialGain,
  TEMPLATE_SOCIAL_MAX,
  TEMPLATE_SOCIAL_MIN,
} from '../socialGain';

/**
 * E10: a template chat paid a flat +3 social against 8–15 for an LLM chat, so
 * towns run at 4x (mostly template chats) stayed lonely.
 */
describe('llmSocialGain', () => {
  it('keeps the established curve: 8 neutral, 1..15 clamped, warm x1.3 when it went well', () => {
    expect(llmSocialGain(0, 50)).toBe(8);
    expect(llmSocialGain(-1, 50)).toBe(1);
    expect(llmSocialGain(-5, null)).toBe(1);
    expect(llmSocialGain(1, 50)).toBe(15);
    expect(llmSocialGain(0.5, 80)).toBeCloseTo(11.5 * 1.3);
    // Warmth doesn't rescue a bad chat.
    expect(llmSocialGain(-0.5, 80)).toBeCloseTo(4.5);
  });
});

describe('templateSocialGain', () => {
  it('pays a typical friendly 3-line exchange 6..10, not +3', () => {
    const typical = templateSocialGain({ sentiment: 0.2, turns: 3, friendship: 20 });
    expect(typical).toBeGreaterThanOrEqual(6);
    expect(typical).toBeLessThanOrEqual(10);
  });

  it('is capped, so a template never beats a warm LLM chat', () => {
    const best = templateSocialGain({ sentiment: 1, turns: 10, friendship: 100 });
    expect(best).toBe(TEMPLATE_SOCIAL_MAX);
    expect(best).toBeLessThan(llmSocialGain(0.5, 50));
  });

  it('scales with the length of the exchange', () => {
    const two = templateSocialGain({ sentiment: 0.1, turns: 2, friendship: 0 });
    const three = templateSocialGain({ sentiment: 0.1, turns: 3, friendship: 0 });
    expect(three).toBeGreaterThan(two);
  });

  it('scales with the bond: a friend fills you up more than a stranger', () => {
    const stranger = templateSocialGain({ sentiment: 0.1, turns: 2, friendship: 0 });
    const friend = templateSocialGain({ sentiment: 0.1, turns: 2, friendship: 80 });
    expect(friend).toBeGreaterThan(stranger);
    // Dislike doesn't drain below the stranger baseline.
    expect(templateSocialGain({ sentiment: 0.1, turns: 2, friendship: -60 })).toBe(stranger);
  });

  it('a cold exchange pays clearly less than a warm one, but never below the floor', () => {
    const warm = templateSocialGain({ sentiment: 0.5, turns: 3, friendship: 0 });
    const cold = templateSocialGain({ sentiment: -0.6, turns: 3, friendship: 0 });
    expect(cold).toBeLessThan(warm - 3);
    expect(templateSocialGain({ sentiment: -1, turns: 1, friendship: 0 })).toBeGreaterThanOrEqual(TEMPLATE_SOCIAL_MIN);
  });
});
