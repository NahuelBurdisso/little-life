// server/__tests__/rippleRules.test.ts
import { describe, it, expect } from 'vitest';
import { rippleRules } from '../lib/cascade/rippleRules';

const VALID_SOURCES = new Set([
  'state:triggered',
  'state:cleared',
  'conversation:ended',
  'gossip:learned',
  'gossip:shared',
  'economy:distress',
  'economy:theft_caught',
  'economy:theft_success',
  'economy:blackmail_paid',
  'economy:gambling',
  'economy:purchase',
  'economy:transaction',
  'economy:milestone',
  'crime:arrested',
  'goal:created',
  'goal:completed',
  'goal:abandoned',
  'goal:pivoted',
  'goal:ambition_shifted',
  'interaction:completed',
  'relationship:changed',
  'relationship:sentiment',
  'need:critical',
  'perception:observed',
  'jealousy:triggered',
  'confrontation:occurred',
  'agent:birthday',
  'secret:shared',
]);

const VALID_STATES = new Set([
  'drunk', 'hungover', 'sick', 'heartbroken', 'angry', 'stressed',
  'euphoric', 'grieving', 'infatuated', 'lonely', 'depressed', 'confident',
  'jealous', 'alcoholic', 'in_debt',
]);

const VALID_FACTS = new Set([
  'crush', 'heartbreak', 'drunk_incident', 'grudge', 'affair', 'financial',
  'secret_told', 'work_issue', 'sickness', 'reputation', 'theft', 'blackmail',
  'gambling_loss', 'rumor', 'seduction', 'confession', 'alcoholic', 'death', 'arrest',
  // Tier 3 drama facts
  'political_dissent', 'escape', 'conspiracy', 'contraband', 'speech',
  // New social facts
  'fight', 'hobby_expert', 'gift_given', 'secret_shared', 'confrontation', 'hoarding',
]);

const VALID_GOALS = new Set([
  'revenge', 'seduce', 'steal_from', 'pay_debt', 'get_sober', 'protect',
  'investigate', 'undermine', 'befriend', 'comfort_grieving',
]);

const VALID_AXES = new Set([
  'honesty', 'aggression', 'warmth', 'impulsiveness', 'vanity', 'curiosity',
  'loyalty', 'morality', 'sensuality', 'neuroticism',
]);

describe('rippleRules', () => {
  it('exports a non-empty array with at least 30 rules', () => {
    expect(Array.isArray(rippleRules)).toBe(true);
    expect(rippleRules.length).toBeGreaterThanOrEqual(30);
  });

  it('all rule IDs are unique', () => {
    const ids = rippleRules.map(r => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('each rule has a valid source event', () => {
    for (const rule of rippleRules) {
      expect(VALID_SOURCES.has(rule.source), `Rule "${rule.id}" has invalid source: "${rule.source}"`).toBe(true);
    }
  });

  it('each rule probability is between 0 and 1 (inclusive)', () => {
    for (const rule of rippleRules) {
      expect(rule.probability, `Rule "${rule.id}" probability out of range`).toBeGreaterThanOrEqual(0);
      expect(rule.probability, `Rule "${rule.id}" probability out of range`).toBeLessThanOrEqual(1);
    }
  });

  it('personality gates use valid axes and weights between 0 and 0.3', () => {
    for (const rule of rippleRules) {
      if (rule.personalityGates) {
        for (const gate of rule.personalityGates) {
          expect(
            VALID_AXES.has(gate.axis),
            `Rule "${rule.id}" gate axis "${gate.axis}" is invalid`,
          ).toBe(true);
          expect(
            gate.weight,
            `Rule "${rule.id}" gate weight ${gate.weight} out of range`,
          ).toBeGreaterThanOrEqual(0);
          expect(
            gate.weight,
            `Rule "${rule.id}" gate weight ${gate.weight} out of range`,
          ).toBeLessThanOrEqual(0.3);
          expect(gate.direction === '+' || gate.direction === '-',
            `Rule "${rule.id}" gate direction "${gate.direction}" is invalid`,
          ).toBe(true);
        }
      }
    }
  });

  it('effect createState references valid states', () => {
    for (const rule of rippleRules) {
      if (rule.effects.createState) {
        expect(
          VALID_STATES.has(rule.effects.createState),
          `Rule "${rule.id}" createState "${rule.effects.createState}" is invalid`,
        ).toBe(true);
      }
    }
  });

  it('effect createFact references valid fact types', () => {
    for (const rule of rippleRules) {
      if (rule.effects.createFact) {
        expect(
          VALID_FACTS.has(rule.effects.createFact),
          `Rule "${rule.id}" createFact "${rule.effects.createFact}" is invalid`,
        ).toBe(true);
      }
    }
  });

  it('effect createGoal references valid goal types', () => {
    for (const rule of rippleRules) {
      if (rule.effects.createGoal) {
        expect(
          VALID_GOALS.has(rule.effects.createGoal.type),
          `Rule "${rule.id}" createGoal.type "${rule.effects.createGoal.type}" is invalid`,
        ).toBe(true);
      }
    }
  });

  it('all cooldowns are positive numbers', () => {
    for (const rule of rippleRules) {
      expect(rule.cooldownMinutes, `Rule "${rule.id}" cooldownMinutes must be positive`).toBeGreaterThan(0);
    }
  });

  describe('affair_heartbreak', () => {
    const rule = rippleRules.find((r) => r.id === 'affair_heartbreak')!;
    const fires = (payload: Record<string, unknown>) => rule.sourceFilter!(payload, {} as never);

    it('fires for an affair fact whatever its wording', () => {
      // The generated affair sentence is "X and Y are getting suspiciously close": no "affair"
      // or "cheating" in it, so a content match never saw the town's own affair secrets.
      expect(fires({ agentId: 1, content: 'Ana and Ben are getting suspiciously close.', factType: 'affair', factId: 9 })).toBe(true);
    });

    it('does not fire for another fact type, even one that mentions affairs by name', () => {
      expect(fires({ agentId: 1, content: 'Ana stole bread.', factType: 'theft', factId: 9 })).toBe(false);
      expect(fires({ agentId: 1, content: 'Ana talks about the affair at the mill.', factType: 'rumor', factId: 9 })).toBe(false);
    });

    it('falls back to the content match for payloads that carry no fact type', () => {
      expect(fires({ agentId: 1, content: 'Ben is cheating on Ana' })).toBe(true);
      expect(fires({ agentId: 1, content: 'Ben bought a hat' })).toBe(false);
    });
  });

  it('contains exactly 68 rules', () => {
    expect(rippleRules.length).toBe(68);
  });

  it('has all expected rule IDs present', () => {
    const ruleIds = new Set(rippleRules.map(r => r.id));
    const expectedIds = [
      // Romance
      'affair_heartbreak', 'heartbreak_drinking', 'heartbreak_confrontation',
      'heartbreak_isolation', 'infatuation_jealousy', 'jealousy_confrontation',
      'jealousy_gossip',
      // Crime
      'theft_witness_report', 'theft_confrontation', 'theft_revenge',
      'arrest_shame', 'arrest_gossip', 'blackmail_stress', 'blackmail_desperation',
      // Economic
      'distress_stress', 'distress_theft', 'distress_begging', 'distress_gambling',
      'gambling_loss_drinking', 'gambling_loss_debt',
      // Social
      'argument_grudge', 'argument_stress', 'insult_anger', 'anger_lash_out',
      'betrayal_trust_collapse', 'public_humiliation', 'shunning_depression',
      // Health
      'drunk_incident', 'drunk_fight', 'hangover_missed_work', 'sick_contagion',
      // Goal-driven
      'revenge_escalation', 'goal_failure_drinking', 'goal_completed_euphoria',
      'ambition_shift_crisis',
      // Tier 3 drama
      'speech_crowd_mood', 'protest_authority_damage', 'protest_witness_stress',
      'escape_authority_grudge', 'scheme_tension', 'secret_meeting_bond',
      'confide_trust_gain', 'announce_rumor_spread', 'smuggle_bond',
      'lock_out_grudge', 'lock_out_initiator_stress',
      // Positive / Reconciliation
      'good_conversation_bonding', 'deep_conversation_trust', 'grudge_forgiveness',
      'shared_enemy_bond', 'comfort_bonding', 'romantic_spark',
      'post_confrontation_apology', 'goal_completion_inspires', 'generosity_bond',
      // Goal completion consequences
      'revenge_breeds_revenge', 'seduce_success_infatuation',
      'undermine_victim_retaliation', 'protect_gratitude', 'protect_gratitude_trust',
      'theft_guilt', 'post_confrontation_apology_friendship',
      'flirt_triggers_jealousy', 'theft_success_confidence',
    ];
    for (const id of expectedIds) {
      expect(ruleIds.has(id), `Missing expected rule: "${id}"`).toBe(true);
    }
  });
});
