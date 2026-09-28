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

export interface RippleRule {
  id: string;
  source: string;
  sourceFilter?: (payload: any, ctx: RippleContext) => boolean;
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
  cooldownTicks: number;
  effects: RippleEffects;
}

export interface RippleEffects {
  createState?: string;
  clearState?: string;
  createFact?: string;
  emitEvent?: string;
  emitPayload?: Record<string, any>;
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
  lastSnapTick: number;
  snapCount: number;
}

export type SnapAction = 'confront' | 'flee' | 'plot' | 'breakdown' | 'lash_out' | 'self_destruct';
