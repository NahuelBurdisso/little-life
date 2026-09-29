import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEFAULT_LIVE_RULES, type LiveRules } from '../../data/rulesCatalog';
import { randomEventChancePerHour } from '../../engine/systems/events';
import { contagionChancePerMinute, environmentSickChancePerMinute } from '../../engine/systems/states';
import { RippleEngine } from '../cascade/RippleEngine';
import { TensionTracker } from '../cascade/TensionTracker';
import { rippleRules } from '../cascade/rippleRules';
import { ruleTone, rippleProbabilityScale } from '../cascade/ruleTone';
import type { RippleRule } from '../cascade/cascadeTypes';
import type { PersonalityProfile } from '../personality';
import { CONFIG } from '../constants';

/**
 * The wizard's Sickness Rate, Contagion Rate and Drama Intensity were saved
 * with the world and read by nothing. Each is now a multiplier on the odds it
 * names, and each default is exactly the tuned rate the town already had.
 */

const rules = (p: Partial<LiveRules> = {}): LiveRules => ({ ...DEFAULT_LIVE_RULES, ...p });

const PERSONALITY: PersonalityProfile = {
  honesty: 50, aggression: 50, warmth: 50, impulsiveness: 50, vanity: 50,
  curiosity: 50, loyalty: 50, morality: 50, sensuality: 50, neuroticism: 50,
};

const rule = (id: string): RippleRule => {
  const r = rippleRules.find((x) => x.id === id);
  if (!r) throw new Error(`no rule ${id}`);
  return r;
};

afterEach(() => vi.restoreAllMocks());

describe('Drama Intensity', () => {
  it('scales the hourly random-event chance, with medium at the tuned base', () => {
    const base = CONFIG.EVENTS.RANDOM_EVENT_CHANCE_PER_HOUR;
    expect(randomEventChancePerHour(rules())).toBeCloseTo(base);
    expect(randomEventChancePerHour(rules({ dramaIntensity: 'low' }))).toBeCloseTo(base * 0.5);
    expect(randomEventChancePerHour(rules({ dramaIntensity: 'high' }))).toBeCloseTo(base * 1.5);
    expect(randomEventChancePerHour(rules({ dramaIntensity: 'chaos' }))).toBeCloseTo(base * 2.5);
  });

  it('scales dark ripple rules and leaves warm ones alone', () => {
    const engine = new RippleEngine({ dryRun: true });
    const dark = { ...rule('argument_grudge'), probability: 0.3, personalityGates: [] };
    const warm = { ...rule('comfort_bonding'), probability: 0.3, personalityGates: [] };
    const random = vi.spyOn(Math, 'random');

    random.mockReturnValue(0.4); // above the base 0.3
    expect(engine.rollsToFire(dark, PERSONALITY, rules())).toBe(false);
    expect(engine.rollsToFire(dark, PERSONALITY, rules({ dramaIntensity: 'chaos' }))).toBe(true); // 0.75
    expect(engine.rollsToFire(warm, PERSONALITY, rules({ dramaIntensity: 'chaos' }))).toBe(false);

    random.mockReturnValue(0.2); // under the base 0.3
    expect(engine.rollsToFire(dark, PERSONALITY, rules())).toBe(true);
    expect(engine.rollsToFire(dark, PERSONALITY, rules({ dramaIntensity: 'low' }))).toBe(false); // 0.15
    expect(engine.rollsToFire(warm, PERSONALITY, rules({ dramaIntensity: 'low' }))).toBe(true);
  });

  it('clamps a scaled probability at 1', () => {
    const engine = new RippleEngine({ dryRun: true });
    const likely = { ...rule('argument_grudge'), probability: 0.9, personalityGates: [] };
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(engine.rollsToFire(likely, PERSONALITY, rules({ dramaIntensity: 'chaos' }))).toBe(true);
  });

  it('lowers the snap threshold as drama rises', () => {
    const tracker = new TensionTracker();
    const threshold = tracker.getSnapThreshold(PERSONALITY);
    tracker.addTension(1, threshold * 0.85, { event: 'test', description: 'test', tick: 0 });
    expect(tracker.shouldSnap(1, PERSONALITY, 10_000)).toBe(false);
    expect(tracker.shouldSnap(1, PERSONALITY, 10_000, 0.9)).toBe(false); // high
    expect(tracker.shouldSnap(1, PERSONALITY, 10_000, 0.8)).toBe(true); // chaos
  });
});

describe('ruleTone', () => {
  it('classifies the real rules by what they do', () => {
    for (const id of ['argument_grudge', 'theft_revenge', 'infatuation_jealousy', 'jealousy_gossip', 'distress_begging', 'hangover_missed_work']) {
      expect(ruleTone(rule(id)), id).toBe('dark');
    }
    for (const id of ['comfort_bonding', 'post_confrontation_apology', 'grudge_forgiveness', 'secret_meeting_bond', 'protect_gratitude']) {
      expect(ruleTone(rule(id)), id).toBe('warm');
    }
    expect(ruleTone(rule('sick_contagion'))).toBe('contagion');
  });

  it('puts most of the cascade under the drama dial', () => {
    const dark = rippleRules.filter((r) => ruleTone(r) === 'dark').length;
    const warm = rippleRules.filter((r) => ruleTone(r) === 'warm').length;
    expect(dark).toBeGreaterThan(warm);
    expect(warm).toBeGreaterThan(10);
  });
});

describe('Sickness Rate', () => {
  it('scales falling ill from the environment, with low at the tuned base', () => {
    expect(environmentSickChancePerMinute('sunny', 'spring', 80, rules())).toBeCloseTo(0.0001);
    expect(environmentSickChancePerMinute('rainy', 'winter', 10, rules())).toBeCloseTo(0.0001 * 2 * 1.5 * 1.5);
    expect(environmentSickChancePerMinute('sunny', 'spring', 80, rules({ sicknessRate: 'high' }))).toBeCloseTo(0.00035);
    expect(environmentSickChancePerMinute('stormy', 'winter', 0, rules({ sicknessRate: 'off' }))).toBe(0);
  });
});

describe('Contagion Rate', () => {
  it('scales person-to-person spread, with low at the tuned 1%', () => {
    expect(contagionChancePerMinute(rules())).toBeCloseTo(0.01);
    expect(contagionChancePerMinute(rules({ contagionRate: 'medium' }))).toBeCloseTo(0.02);
    expect(contagionChancePerMinute(rules({ contagionRate: 'off' }))).toBe(0);
  });

  it("'off' stops the sick_contagion ripple rule too, even on a zero roll", () => {
    const engine = new RippleEngine({ dryRun: true });
    const spread = rule('sick_contagion');
    expect(rippleProbabilityScale(spread, rules({ contagionRate: 'off', dramaIntensity: 'chaos' }))).toBe(0);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(engine.rollsToFire(spread, PERSONALITY, rules({ contagionRate: 'off' }))).toBe(false);
    expect(engine.rollsToFire(spread, PERSONALITY, rules({ contagionRate: 'low' }))).toBe(true);
  });
});
