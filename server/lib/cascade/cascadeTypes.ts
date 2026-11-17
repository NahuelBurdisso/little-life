// server/lib/cascade/cascadeTypes.ts
import type { PersonalityProfile } from '../personality';

export interface CascadeMetadata {
  chainId: string;
  chainDepth: number;
  parentRuleId?: string;
  locationId?: number;
  perpetratorId?: number;
  victimId?: number;
}

/**
 * A simEvents payload as the cascade reads it. One shape for every source event: each
 * event carries a few of these fields and a rule's `sourceFilter` checks the ones it
 * needs, so they are all optional. `_cascade` (the chain an engine-emitted event belongs
 * to) and `_resolvedAgentId` are the engine's own marks. Anything else an event carries is `unknown` here.
 */
export interface RipplePayload {
  agentId?: number;
  targetId?: number;
  perpetratorId?: number;
  victimId?: number;
  locationId?: number | null;
  action?: string;
  state?: string;
  sentiment?: number;
  goalType?: string;
  content?: string;
  topics?: string[];
  partnerState?: string;
  won?: boolean;
  romanceLevel?: number;
  hadRecentConflict?: boolean;
  factType?: string;
  templateKey?: string;
  _cascade?: CascadeMetadata;
  _resolvedAgentId?: number;
  [key: string]: unknown;
}

export interface RippleRule {
  id: string;
  source: string;
  sourceFilter?: (payload: RipplePayload, ctx: RippleContext) => boolean;
  target: 'self' | 'perpetrator' | 'victim' | 'witness' | 'random_present';
  probability: number;
  personalityGates?: Array<{
    axis: keyof PersonalityProfile;
    direction: '+' | '-';
    weight: number;
  }>;
  requires?: {
    state?: string;
    notState?: string;
    relationshipMin?: { field: string; value: number };
    relationshipMax?: { field: string; value: number };
    coLocatedWith?: 'perpetrator' | 'victim' | 'any_agent';
    needBelow?: { need: string; value: number };
    moneyBelow?: number;
  };
  /** Game minutes before the rule can fire again for the same agent. */
  cooldownMinutes: number;
  effects: RippleEffects;
}

export interface RippleEffects {
  createState?: string;
  clearState?: string;
  createFact?: string;
  emitEvent?: string;
  emitPayload?: Record<string, unknown>;
  moodDelta?: number;
  stressDelta?: number;
  relationshipDelta?: {
    field: 'friendship' | 'romance' | 'trust';
    value: number;
  };
  tensionDelta?: number;
  economyEffect?: {
    field: 'money' | 'work_performance';
    delta: number;
  };
  setDestination?: 'home' | 'away_from_trigger';
  createGoal?: {
    type: string;
    targetAgent?: 'perpetrator' | 'victim' | 'random';
  };
}

export interface RippleContext {
  targetAgent: { id: number; current_location: number | null; personality: PersonalityProfile | null };
  perpetratorAgent?: { id: number; current_location: number | null };
  agentsAtLocation: Array<{ id: number; personality: PersonalityProfile | null }>;
  getRelationship: (a: number, b: number) => { friendship_ab: number; friendship_ba: number; romance_ab: number; romance_ba: number; trust_ab: number; trust_ba: number; tags: string[] } | null;
  getAgentStates: (agentId: number) => string[];
  getAgentNeeds: (agentId: number) => { mood: number; stress: number; hunger: number; energy: number; social: number };
  getAgentEconomy: (agentId: number) => { money: number; work_performance: number };
  currentTick: number;
}

export interface TensionState {
  value: number;
  sources: Array<{
    event: string;
    description: string;
    tick: number;
    agentInvolved?: string;
  }>;
  /** GAME MINUTE of the last snap (the cooldown is in game minutes). */
  lastSnapMinute: number;
  snapCount: number;
}

export type SnapAction = 'confront' | 'flee' | 'plot' | 'breakdown' | 'lash_out' | 'self_destruct';
