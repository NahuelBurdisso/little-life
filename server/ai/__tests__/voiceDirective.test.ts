import { describe, it, expect, beforeEach } from 'vitest';
import { generateVoiceDirective, clearVoiceDirectiveCache } from '../voiceDirective';

describe('generateVoiceDirective', () => {
  beforeEach(() => clearVoiceDirectiveCache());

  it('picks top 3 most extreme axes', () => {
    const personality = {
      honesty: 35, aggression: 65, warmth: 30, impulsiveness: 50,
      vanity: 50, curiosity: 70, loyalty: 50, morality: 50,
      sensuality: 50, neuroticism: 50,
    };
    const directive = generateVoiceDirective(1, personality);
    expect(directive).toContain('You ask a lot of questions');
    expect(directive).toContain('No chitchat');
  });

  it('uses high mappings for axes > 70', () => {
    const personality = {
      honesty: 85, aggression: 50, warmth: 50, impulsiveness: 50,
      vanity: 50, curiosity: 50, loyalty: 50, morality: 50,
      sensuality: 50, neuroticism: 50,
    };
    const directive = generateVoiceDirective(2, personality);
    expect(directive).toContain('You say exactly what you think');
  });

  it('uses low mappings for axes < 30', () => {
    const personality = {
      honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50,
      vanity: 50, curiosity: 50, loyalty: 50, morality: 20,
      sensuality: 50, neuroticism: 50,
    };
    const directive = generateVoiceDirective(3, personality);
    expect(directive).toContain('Rules are suggestions');
  });

  it('returns empty string when all axes near 50', () => {
    const personality = {
      honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50,
      vanity: 50, curiosity: 50, loyalty: 50, morality: 50,
      sensuality: 50, neuroticism: 50,
    };
    const directive = generateVoiceDirective(4, personality);
    expect(directive).toBe('');
  });

  it('caches result and returns same for same personality', () => {
    const personality = {
      honesty: 85, aggression: 50, warmth: 50, impulsiveness: 50,
      vanity: 50, curiosity: 50, loyalty: 50, morality: 50,
      sensuality: 50, neuroticism: 50,
    };
    const first = generateVoiceDirective(5, personality);
    const second = generateVoiceDirective(5, personality);
    expect(first).toBe(second);
  });

  it('regenerates when personality changes', () => {
    const sober = {
      honesty: 35, aggression: 65, warmth: 30, impulsiveness: 40,
      vanity: 50, curiosity: 70, loyalty: 50, morality: 50,
      sensuality: 50, neuroticism: 50,
    };
    const drunk = {
      ...sober, impulsiveness: 70, warmth: 50, honesty: 10,
    };
    const soberDirective = generateVoiceDirective(6, sober);
    const drunkDirective = generateVoiceDirective(6, drunk);
    expect(soberDirective).not.toBe(drunkDirective);
    expect(drunkDirective).toContain('You blurt things out');
  });
});
