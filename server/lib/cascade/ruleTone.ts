// server/lib/cascade/ruleTone.ts
import type { RippleRule } from './cascadeTypes';
import { contagionMultiplier, dramaMultiplier, type LiveRules } from '../worldRules';

/**
 * Which world rule governs a ripple rule's odds.
 *
 *   - 'contagion': the rule spreads sickness (`sick_contagion`). It is the
 *     cascade half of person-to-person spread, so it follows "Contagion Rate"
 *     with the states-phase roll — otherwise 'off' would still pass colds
 *     around through the cascade.
 *   - 'dark': the rule makes the town worse for someone — raises tension, cuts
 *     trust, sours mood or work, puts an agent in a bad state, starts a grudge,
 *     rumor or revenge. These are what "Drama Intensity" is about.
 *   - 'warm': everything else (bonding, apologies, forgiveness, gratitude).
 *     Left at their tuned odds: a low-drama town should have fewer fights, not
 *     fewer friendships.
 *
 * Derived from the effects rather than tagged by hand on each of the ~60
 * rules, so a new rule is classified the moment it is written. The sets below
 * are the "bad outcome" vocabulary of rippleRules.ts; a rule that only creates
 * a neutral fact (a conspiracy between friends, contraband) stays warm.
 */
export type RuleTone = 'contagion' | 'dark' | 'warm';

const DARK_STATES = new Set([
  'heartbroken', 'drunk', 'lonely', 'jealous', 'stressed', 'in_debt', 'angry', 'depressed',
]);
const DARK_FACTS = new Set(['grudge', 'rumor', 'theft', 'arrest', 'fight', 'drunk_incident']);
const DARK_GOALS = new Set(['revenge', 'steal_from']);
const DARK_ACTIONS = new Set(['confrontation', 'begging', 'gambling', 'drunk_misbehavior']);

export function ruleTone(rule: RippleRule): RuleTone {
  const fx = rule.effects;
  if (fx.createState === 'sick') return 'contagion';
  const dark =
    (fx.tensionDelta ?? 0) > 0
    || (fx.relationshipDelta?.value ?? 0) < 0
    || (fx.moodDelta ?? 0) < 0
    || (fx.stressDelta ?? 0) > 0
    || (fx.economyEffect?.delta ?? 0) < 0
    || (fx.createState != null && DARK_STATES.has(fx.createState))
    || (fx.createFact != null && DARK_FACTS.has(fx.createFact))
    || (fx.createGoal != null && DARK_GOALS.has(fx.createGoal.type))
    || (typeof fx.emitPayload?.action === 'string' && DARK_ACTIONS.has(fx.emitPayload.action));
  return dark ? 'dark' : 'warm';
}

/** Multiplier the world's rules put on a ripple rule's probability. */
export function rippleProbabilityScale(rule: RippleRule, rules: LiveRules): number {
  switch (ruleTone(rule)) {
    case 'contagion': return contagionMultiplier(rules);
    case 'dark': return dramaMultiplier(rules);
    case 'warm': return 1;
  }
}
