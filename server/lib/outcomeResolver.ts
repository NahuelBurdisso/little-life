import type { InteractionDef, InteractionOutcome, OutcomeFactor } from './interactionConstants';
import type { AgentContext } from './prerequisites';

/**
 * Resolve whether an interaction succeeds or fails.
 * Compares initiator vs target scores from outcomeFactors.
 */
export function resolveOutcome(
  def: InteractionDef,
  initiator: AgentContext,
  target: AgentContext,
): InteractionOutcome {
  const initiatorScore = computeFactorScore(def.outcomeFactors, initiator);
  const targetScore = computeFactorScore(def.outcomeFactors, target);

  // Initiator advantage shifts the threshold from 50/50
  const advantage = initiatorScore - targetScore;
  const threshold = 0.5 + advantage * 0.3;
  const roll = Math.random();

  return roll < threshold ? 'success' : 'failure';
}

/**
 * Compute severity (0-1) from personality extremes, states, and relationship depth.
 */
export function computeSeverity(
  def: InteractionDef,
  initiator: AgentContext,
  _target: AgentContext,
  relationshipIntensity: number, // 0-1, derived from abs(friendship) + abs(romance)
): number {
  // Base from personality extremes (more extreme = more severe)
  let severity = 0.3; // base

  // Personality contribution: how extreme are the relevant traits
  for (const factor of def.outcomeFactors) {
    const value = resolveStat(factor.stat, initiator);
    const extremeness = Math.abs(value - 50) / 50; // 0 at 50, 1 at 0 or 100
    severity += extremeness * 0.1 * Math.abs(factor.weight);
  }

  // State contribution: being in intense states increases severity
  const intenseStates = ['angry', 'drunk', 'euphoric', 'jealous'];
  const hasIntenseState = initiator.activeStates.some(s => intenseStates.includes(s.type));
  if (hasIntenseState) severity += 0.15;

  // Relationship depth: stronger feelings = more severe outcomes
  severity += relationshipIntensity * 0.15;

  return Math.min(1, Math.max(0, severity));
}

function computeFactorScore(factors: OutcomeFactor[], agent: AgentContext): number {
  let score = 0;
  for (const factor of factors) {
    const value = resolveStat(factor.stat, agent);
    score += (value / 100) * factor.weight;
  }
  return score;
}

/**
 * Resolve a stat reference to a numeric value.
 * - Plain string (e.g., "aggression"): personality axis, 0-100
 * - "needs:field" (e.g., "needs:energy"): needs value, 0-100
 * - "state:type" (e.g., "state:drunk"): 1 if active, 0 if not
 */
function resolveStat(stat: string, agent: AgentContext): number {
  if (stat.startsWith('state:')) {
    const stateType = stat.slice(6);
    return agent.activeStates.some(s => s.type === stateType) ? 100 : 0;
  }
  if (stat.startsWith('needs:')) {
    const field = stat.slice(6);
    return agent.needs[field] ?? 50;
  }
  // Default: personality axis
  return agent.personality?.[stat] ?? 50;
}
