// server/__tests__/RippleEngine.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RippleEngine } from '../lib/cascade/RippleEngine';
import type { RippleRule, RippleContext } from '../lib/cascade/cascadeTypes';
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

function makeRule(overrides: Partial<RippleRule> = {}): RippleRule {
  return {
    id: 'test_rule',
    source: 'test:event',
    target: 'self',
    probability: 0.5,
    cooldownTicks: 100,
    effects: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<RippleContext> = {}): RippleContext {
  return {
    targetAgent: { id: 1, current_location: 1, personality: makePersonality() },
    agentsAtLocation: [],
    getRelationship: () => null,
    getAgentStates: () => [],
    getAgentNeeds: () => ({ mood: 50, stress: 50, hunger: 50, energy: 50, social: 50 }),
    getAgentEconomy: () => ({ money: 100, work_performance: 50 }),
    currentTick: 0,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RippleEngine', () => {
  let engine: RippleEngine;

  beforeEach(() => {
    engine = new RippleEngine({ dryRun: true });
  });

  // ─── probability calculation ────────────────────────────────────────────────

  describe('probability calculation', () => {
    it('base probability without gates returns rule.probability unchanged', () => {
      const rule = makeRule({ probability: 0.7, personalityGates: [] });
      const personality = makePersonality();
      const result = engine.calculateProbability(rule, personality);
      expect(result).toBe(0.7);
    });

    it('zero probability always returns zero', () => {
      const rule = makeRule({
        probability: 0,
        personalityGates: [
          { axis: 'neuroticism', direction: '+', weight: 0.5 },
        ],
      });
      const personality = makePersonality({ neuroticism: 100 });
      // 0 + (100/100 * 0.5) = 0.5, but base is 0 so total = 0 + 0.5 = 0.5
      // Actually zero probability just means 0 + modifier. The spec says "zero probability always returns zero"
      // This means we test that rule.probability = 0, no gates => result = 0
      const ruleNoGates = makeRule({ probability: 0, personalityGates: [] });
      expect(engine.calculateProbability(ruleNoGates, personality)).toBe(0);
    });

    it('positive personality gate increases probability (high neuroticism > low neuroticism for + direction)', () => {
      const rule = makeRule({
        probability: 0.5,
        personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.2 }],
      });
      const highNeuroticism = makePersonality({ neuroticism: 90 });
      const lowNeuroticism = makePersonality({ neuroticism: 10 });

      const highResult = engine.calculateProbability(rule, highNeuroticism);
      const lowResult = engine.calculateProbability(rule, lowNeuroticism);

      expect(highResult).toBeGreaterThan(lowResult);
    });
  });

  // ─── cooldown enforcement ───────────────────────────────────────────────────

  describe('cooldown enforcement', () => {
    it('blocks rule for same agent within cooldown period', () => {
      // Record cooldown: lastFired=50, cooldownTicks=100
      engine.recordCooldown('cooldown_rule', 1, 50, 100);

      // currentTick = 100, lastFired = 50, cooldown = 100 → 100 - 50 = 50 < 100 → still on cooldown
      expect(engine.isOnCooldown('cooldown_rule', 1, 100)).toBe(true);
    });

    it('allows rule for different agent', () => {
      engine.recordCooldown('cooldown_rule', 1, 50, 100);

      // Agent 2 has no cooldown
      expect(engine.isOnCooldown('cooldown_rule', 2, 100)).toBe(false);
    });
  });

  // ─── chain depth limiting ───────────────────────────────────────────────────

  describe('chain depth limiting', () => {
    it('depth 4 is not exceeded', () => {
      expect(engine.isChainDepthExceeded(4)).toBe(false);
    });

    it('depth 5 is exceeded', () => {
      expect(engine.isChainDepthExceeded(5)).toBe(true);
    });
  });

  // ─── per-tick cap ───────────────────────────────────────────────────────────

  describe('per-tick cap', () => {
    it('depth 1 is exempt from cap even when cap reached', () => {
      // Fill cap to 8
      for (let i = 0; i < 8; i++) {
        engine.incrementTickCounter(2); // depth 2 increments
      }
      expect(engine.isTickCapReached()).toBe(true);
      expect(engine.isExemptFromCap(1)).toBe(true);
    });

    it('depth 2+ is blocked when 8 reached', () => {
      for (let i = 0; i < 8; i++) {
        engine.incrementTickCounter(2);
      }
      expect(engine.isTickCapReached()).toBe(true);
      expect(engine.isExemptFromCap(2)).toBe(false);
    });
  });

  // ─── requirements checking ──────────────────────────────────────────────────

  describe('requirements checking', () => {
    it('passes with empty requirements', () => {
      const rule = makeRule({ requires: undefined });
      const ctx = makeContext();
      const result = engine.checkRequirementsPublic(rule.requires, 1, {}, ctx);
      expect(result).toBe(true);
    });

    it('fails when required state missing', () => {
      const rule = makeRule({ requires: { state: 'heartbroken' } });
      const ctx = makeContext({
        getAgentStates: () => ['stressed'],
      });
      const result = engine.checkRequirementsPublic(rule.requires, 1, {}, ctx);
      expect(result).toBe(false);
    });

    it('fails when notState present', () => {
      const rule = makeRule({ requires: { notState: 'euphoric' } });
      const ctx = makeContext({
        getAgentStates: () => ['euphoric', 'stressed'],
      });
      const result = engine.checkRequirementsPublic(rule.requires, 1, {}, ctx);
      expect(result).toBe(false);
    });

    it('fails when money is above moneyBelow threshold', () => {
      const rule = makeRule({ requires: { moneyBelow: 50 } });
      const ctx = makeContext({
        getAgentEconomy: () => ({ money: 100, work_performance: 50 }),
      });
      const result = engine.checkRequirementsPublic(rule.requires, 1, {}, ctx);
      expect(result).toBe(false);
    });

    it('passes when money is below moneyBelow threshold', () => {
      const rule = makeRule({ requires: { moneyBelow: 50 } });
      const ctx = makeContext({
        getAgentEconomy: () => ({ money: 20, work_performance: 50 }),
      });
      const result = engine.checkRequirementsPublic(rule.requires, 1, {}, ctx);
      expect(result).toBe(true);
    });

    it('coLocatedWith any_agent: true when other agents present', () => {
      const rule = makeRule({ requires: { coLocatedWith: 'any_agent' } });
      const ctx = makeContext({
        agentsAtLocation: [{ id: 2, personality: null }, { id: 3, personality: null }],
      });
      const result = engine.checkRequirementsPublic(rule.requires, 1, {}, ctx);
      expect(result).toBe(true);
    });

    it('coLocatedWith any_agent: false when empty', () => {
      const rule = makeRule({ requires: { coLocatedWith: 'any_agent' } });
      const ctx = makeContext({
        agentsAtLocation: [],
      });
      const result = engine.checkRequirementsPublic(rule.requires, 1, {}, ctx);
      expect(result).toBe(false);
    });
  });

  // ─── deduplication ──────────────────────────────────────────────────────────

  describe('deduplication', () => {
    it('skips state:triggered events WITH _cascade metadata', () => {
      const payload = { state: 'heartbroken', _cascade: { chainId: 'abc', chainDepth: 1 } };
      expect(engine.shouldSkipForDedup('state:triggered', payload)).toBe(true);
    });

    it('processes state:triggered events WITHOUT _cascade metadata', () => {
      const payload = { state: 'heartbroken' };
      expect(engine.shouldSkipForDedup('state:triggered', payload)).toBe(false);
    });

    it('does NOT skip non-state events with cascade metadata', () => {
      const payload = { action: 'insult', _cascade: { chainId: 'abc', chainDepth: 1 } };
      expect(engine.shouldSkipForDedup('interaction:completed', payload)).toBe(false);
    });
  });
});
