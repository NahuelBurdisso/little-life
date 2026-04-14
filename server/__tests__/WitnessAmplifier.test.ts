// server/__tests__/WitnessAmplifier.test.ts
import { describe, it, expect } from 'vitest';
import { WitnessAmplifier } from '../lib/cascade/WitnessAmplifier';
import type { PersonalityProfile } from '../lib/personality';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePersonality(overrides: Partial<PersonalityProfile> = {}): PersonalityProfile {
  return {
    honesty: 50,
    aggression: 50,
    warmth: 50,
    impulsiveness: 50,
    vanity: 50,
    curiosity: 50,
    loyalty: 50,
    morality: 50,
    sensuality: 50,
    neuroticism: 50,
    ...overrides,
  };
}

const amplifier = new WitnessAmplifier();

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WitnessAmplifier.getWitnessBehaviors', () => {
  it('returns no behaviors for a fully neutral personality', () => {
    const result = amplifier.getWitnessBehaviors(makePersonality(), {
      isVictimFriend: false,
      eventSensitivity: 1,
    });
    expect(result).toHaveLength(0);
  });

  it('triggers fast_gossip when curiosity > 60', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ curiosity: 61 }),
      { isVictimFriend: false, eventSensitivity: 1 },
    );
    expect(result.map(b => b.type)).toContain('fast_gossip');
  });

  it('does NOT trigger fast_gossip when curiosity is exactly 60', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ curiosity: 60 }),
      { isVictimFriend: false, eventSensitivity: 1 },
    );
    expect(result.map(b => b.type)).not.toContain('fast_gossip');
  });

  it('triggers cover_up when loyalty > 60 AND isVictimFriend', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ loyalty: 70 }),
      { isVictimFriend: true, eventSensitivity: 1 },
    );
    expect(result.map(b => b.type)).toContain('cover_up');
  });

  it('does NOT trigger cover_up when loyalty > 60 but not a friend', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ loyalty: 70 }),
      { isVictimFriend: false, eventSensitivity: 1 },
    );
    expect(result.map(b => b.type)).not.toContain('cover_up');
  });

  it('triggers exploit when morality < 40 AND eventSensitivity >= 2', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ morality: 39 }),
      { isVictimFriend: false, eventSensitivity: 2 },
    );
    expect(result.map(b => b.type)).toContain('exploit');
  });

  it('does NOT trigger exploit when morality < 40 but eventSensitivity < 2', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ morality: 39 }),
      { isVictimFriend: false, eventSensitivity: 1 },
    );
    expect(result.map(b => b.type)).not.toContain('exploit');
  });

  it('does NOT trigger exploit when eventSensitivity >= 2 but morality >= 40', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ morality: 40 }),
      { isVictimFriend: false, eventSensitivity: 2 },
    );
    expect(result.map(b => b.type)).not.toContain('exploit');
  });

  it('triggers intervene when aggression > 60', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ aggression: 61 }),
      { isVictimFriend: false, eventSensitivity: 1 },
    );
    expect(result.map(b => b.type)).toContain('intervene');
  });

  it('triggers panic when neuroticism > 60', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ neuroticism: 75 }),
      { isVictimFriend: false, eventSensitivity: 1 },
    );
    expect(result.map(b => b.type)).toContain('panic');
  });

  it('triggers comfort when warmth > 60 AND isVictimFriend', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ warmth: 80 }),
      { isVictimFriend: true, eventSensitivity: 1 },
    );
    expect(result.map(b => b.type)).toContain('comfort');
  });

  it('does NOT trigger comfort when warmth > 60 but not a friend', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ warmth: 80 }),
      { isVictimFriend: false, eventSensitivity: 1 },
    );
    expect(result.map(b => b.type)).not.toContain('comfort');
  });

  it('caps output at 2 behaviors even when many conditions match', () => {
    // curiosity(fast_gossip), aggression(intervene), neuroticism(panic) all triggered
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ curiosity: 80, aggression: 80, neuroticism: 80 }),
      { isVictimFriend: false, eventSensitivity: 1 },
    );
    expect(result).toHaveLength(2);
  });

  it('respects priority order: fast_gossip before intervene before panic', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ curiosity: 80, aggression: 80, neuroticism: 80 }),
      { isVictimFriend: false, eventSensitivity: 1 },
    );
    expect(result[0].type).toBe('fast_gossip');
    expect(result[1].type).toBe('intervene');
  });

  it('returns exactly 1 behavior when only 1 condition matches', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ neuroticism: 90 }),
      { isVictimFriend: false, eventSensitivity: 1 },
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('panic');
  });

  it('cover_up + comfort both trigger for loyal warm friend', () => {
    const result = amplifier.getWitnessBehaviors(
      makePersonality({ loyalty: 80, warmth: 80 }),
      { isVictimFriend: true, eventSensitivity: 1 },
    );
    expect(result).toHaveLength(2);
    expect(result.map(b => b.type)).toContain('cover_up');
    expect(result.map(b => b.type)).toContain('comfort');
  });
});
