// prerequisites.ts — Pure prerequisite evaluator for interaction conditions.
// All data is passed in via parameters; no DB access occurs here.

import type { Prerequisite } from './interactionConstants';
import { zoneOccupancy } from './interiorGrid';

// ─── Context Types ────────────────────────────────────────────────────────────

export interface AgentContext {
  id: number;
  name: string;
  current_action: any;
  current_location: number | null;
  /** The building type the agent is currently in (e.g. 'tavern', 'shop'). */
  locationType?: string | null;
  personality: Record<string, number> | null;
  activeStates: Array<{ type: string; target_agent_id: number | null }>;
  needs: Record<string, number>;
  economyRecord: { money: number; job: string } | null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function checkPrerequisites(
  prereqs: Prerequisite[],
  initiator: AgentContext,
  target: AgentContext,
  world: { hour: number; locationPopulation: Map<number, number> },
  relationship: {
    friendship_ab: number;
    friendship_ba: number;
    romance_ab: number;
    romance_ba: number;
    trust_ab: number;
    trust_ba: number;
    familiarity: number;
    tags: string[];
  } | null,
  isInitiatorA: boolean,
  /** Optional requiredZone from InteractionDef — maps building type to allowed zone IDs. */
  requiredZone?: Record<string, string[]>,
): boolean {
  // Check requiredZone constraint if provided
  if (requiredZone) {
    if (!checkRequiredZone(requiredZone, initiator.id, initiator.locationType ?? null)) {
      return false;
    }
  }

  return prereqs.every(p =>
    evaluatePrerequisite(p, initiator, target, world, relationship, isInitiatorA),
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRelField(
  rel: NonNullable<Parameters<typeof checkPrerequisites>[4]>,
  field: string,
  isInitiatorA: boolean,
): number {
  const suffix = isInitiatorA ? 'ab' : 'ba';
  switch (field) {
    case 'friendship': return rel[`friendship_${suffix}` as 'friendship_ab' | 'friendship_ba'];
    case 'romance':    return rel[`romance_${suffix}` as 'romance_ab' | 'romance_ba'];
    case 'trust':      return rel[`trust_${suffix}` as 'trust_ab' | 'trust_ba'];
    case 'familiarity': return rel.familiarity;
    default:           return 0;
  }
}

function compareOp(actual: number, op: string, value: number): boolean {
  switch (op) {
    case '>':  return actual > value;
    case '<':  return actual < value;
    case '>=': return actual >= value;
    case '<=': return actual <= value;
    case '==': return actual === value;
    default:   return false;
  }
}

function pickAgent(
  agentField: string | undefined,
  initiator: AgentContext,
  target: AgentContext,
): AgentContext {
  return agentField === 'target' ? target : initiator;
}

// ─── State check helper ───────────────────────────────────────────────────────

function agentHasState(
  agent: AgentContext,
  p: Prerequisite,
  other: AgentContext,
): boolean {
  const stateTypes: string[] =
    p.state_any ? p.state_any : p.state ? [p.state] : [];

  if (stateTypes.length === 0) return false;

  return agent.activeStates.some(s => {
    if (!stateTypes.includes(s.type)) return false;
    if (p.target_matches) {
      return s.target_agent_id === other.id;
    }
    return true;
  });
}

// ─── Relationship check helper ────────────────────────────────────────────────

function checkRelationshipPrereq(
  p: Prerequisite,
  relationship: Parameters<typeof checkPrerequisites>[4],
  isInitiatorA: boolean,
): boolean {
  if (!relationship) return false;

  const field = p.field ?? '';
  const op    = p.op   ?? '>=';
  const value = typeof p.value === 'number' ? p.value : 0;

  // "mutual" — both directions must satisfy
  if (p.agent === 'either') {
    const ab = isInitiatorA;
    const valAB = getRelField(relationship, field, ab);
    const valBA = getRelField(relationship, field, !ab);
    return compareOp(valAB, op, value) && compareOp(valBA, op, value);
  }

  // initiator→target (default) vs target→initiator
  const fromInitiator = p.agent !== 'target';
  const actual = getRelField(relationship, field, fromInitiator ? isInitiatorA : !isInitiatorA);
  return compareOp(actual, op, value);
}

// ─── Personality check helper ─────────────────────────────────────────────────

function checkPersonalityPrereq(
  p: Prerequisite,
  initiator: AgentContext,
  target: AgentContext,
): boolean {
  const agent = pickAgent(p.agent, initiator, target);
  if (!agent.personality) return false;

  const field  = p.field ?? '';
  const op     = p.op   ?? '>=';
  const value  = typeof p.value === 'number' ? p.value : 0;
  const actual = agent.personality[field] ?? 0;
  return compareOp(actual, op, value);
}

// ─── Economy check helper ─────────────────────────────────────────────────────

function checkEconomyPrereq(
  p: Prerequisite,
  initiator: AgentContext,
  target: AgentContext,
): boolean {
  const agent = pickAgent(p.agent, initiator, target);
  if (!agent.economyRecord) return false;

  const field = p.field ?? '';
  const op    = p.op   ?? '>=';

  if (field === 'money') {
    const value = typeof p.value === 'number' ? p.value : 0;
    return compareOp(agent.economyRecord.money, op, value);
  }

  if (field === 'job') {
    // string equality
    return agent.economyRecord.job === p.value;
  }

  return false;
}

// ─── Core evaluator ───────────────────────────────────────────────────────────

function evaluatePrerequisite(
  p: Prerequisite,
  initiator: AgentContext,
  target: AgentContext,
  world: { hour: number; locationPopulation: Map<number, number> },
  relationship: Parameters<typeof checkPrerequisites>[4],
  isInitiatorA: boolean,
): boolean {
  switch (p.type) {
    // ── Spatial ──────────────────────────────────────────────────────────────
    case 'co_located': {
      return (
        initiator.current_location !== null &&
        target.current_location !== null &&
        initiator.current_location === target.current_location
      );
    }

    // ── Relationship ─────────────────────────────────────────────────────────
    case 'relationship': {
      return checkRelationshipPrereq(p, relationship, isInitiatorA);
    }

    // ── Personality ──────────────────────────────────────────────────────────
    case 'personality': {
      return checkPersonalityPrereq(p, initiator, target);
    }

    // ── State ────────────────────────────────────────────────────────────────
    case 'state': {
      if (p.agent === 'either') {
        return (
          agentHasState(initiator, p, target) ||
          agentHasState(target, p, initiator)
        );
      }
      const agent = p.agent === 'target' ? target : initiator;
      const other = p.agent === 'target' ? initiator : target;
      return agentHasState(agent, p, other);
    }

    // ── Economy ───────────────────────────────────────────────────────────────
    case 'economy': {
      return checkEconomyPrereq(p, initiator, target);
    }

    // ── Agent role (job title shorthand) ──────────────────────────────────────
    case 'agent_role': {
      const agent = pickAgent(p.agent, initiator, target);
      if (!agent.economyRecord) return false;
      const role = p.role ?? (typeof p.value === 'string' ? p.value : '');
      return agent.economyRecord.job === role;
    }

    // ── Location type — handled by engine at scan time ────────────────────────
    case 'location_type': {
      return true;
    }

    // ── Location population ───────────────────────────────────────────────────
    case 'location_population':
    case 'co_located_count': {
      if (initiator.current_location === null) return false;
      const pop   = world.locationPopulation.get(initiator.current_location) ?? 0;
      const op    = p.op    ?? '>=';
      const value = typeof p.value === 'number' ? p.value : 0;
      return compareOp(pop, op, value);
    }

    // ── Deferred / DB-backed ──────────────────────────────────────────────────
    case 'recent_interaction': {
      return true; // evaluated by engine with DB access
    }

    // ── Compound OR conditions ────────────────────────────────────────────────
    case 'state_or_personality': {
      const stateOk = (() => {
        if (p.agent === 'either') {
          return (
            agentHasState(initiator, p, target) ||
            agentHasState(target, p, initiator)
          );
        }
        const agent = p.agent === 'target' ? target : initiator;
        const other = p.agent === 'target' ? initiator : target;
        return agentHasState(agent, p, other);
      })();
      if (stateOk) return true;
      return checkPersonalityPrereq(p, initiator, target);
    }

    case 'relationship_or_state': {
      const relOk = checkRelationshipPrereq(p, relationship, isInitiatorA);
      if (relOk) return true;
      if (p.agent === 'either') {
        return (
          agentHasState(initiator, p, target) ||
          agentHasState(target, p, initiator)
        );
      }
      const agent = p.agent === 'target' ? target : initiator;
      const other = p.agent === 'target' ? initiator : target;
      return agentHasState(agent, p, other);
    }

    case 'relationship_low_or_betrayal': {
      // Check the relationship condition first
      if (checkRelationshipPrereq(p, relationship, isInitiatorA)) return true;
      // "betrayal" fact check is DB-backed — defer to engine
      return true;
    }

    case 'knows_fact': {
      return true; // evaluated by engine with DB access
    }

    // ── Unknown — permissive fallthrough ──────────────────────────────────────
    default: {
      return true;
    }
  }
}

// ─── Required Zone Check ─────────────────────────────────────────────────────

/**
 * Check if an agent satisfies the requiredZone constraint of an interaction.
 * Returns true if the interaction has no requiredZone, or if the agent is in
 * a matching zone. Returns false if the agent is not in any allowed zone.
 *
 * @param requiredZone  Maps building type → allowed zone IDs.
 * @param agentId       The initiator agent ID.
 * @param locationType  The building type the agent is currently in (e.g. 'tavern').
 */
export function checkRequiredZone(
  requiredZone: Record<string, string[]> | undefined,
  agentId: number,
  locationType: string | null,
): boolean {
  if (!requiredZone) return true; // No zone requirement
  if (!locationType) return false; // Agent isn't in a location

  const allowedZones = requiredZone[locationType];
  if (!allowedZones) return false; // Wrong location type entirely

  const agentZone = zoneOccupancy.findAgentZone(agentId);
  if (!agentZone) return false; // Agent is not in any zone

  return allowedZones.includes(agentZone.zone);
}
