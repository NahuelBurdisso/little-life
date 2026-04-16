// Interaction Engine — shared constants, types, and lookup maps

// ─── Types ───────────────────────────────────────────────────────────────────

export type InteractionCategory =
  | 'conflict' | 'crime' | 'romance' | 'manipulation'
  | 'caregiving' | 'sabotage' | 'substance' | 'authority';

export type InteractionOutcome = 'success' | 'failure' | 'partial' | 'interrupted';
export type InteractionTrigger = 'autonomous' | 'reactive';
export type ParticipantRole = 'initiator' | 'target' | 'witness' | 'accomplice';
export type AwarenessLevel = 'saw' | 'heard' | 'suspected';
export type FactReliability = 'confirmed' | 'witnessed' | 'hearsay' | 'speculation';
export type NarrationStrategy = 'always' | 'if_witnessed' | 'if_severity' | 'template_only';
export type CooldownScope = 'pair' | 'initiator' | 'target' | 'global';

export type AspirationType =
  | 'wealth' | 'love' | 'power' | 'freedom'
  | 'justice' | 'knowledge' | 'legacy' | 'pleasure';

export type GoalStatus = 'active' | 'completed' | 'abandoned' | 'failed';

// ─── Prerequisite / Effect / Outcome types ───────────────────────────────────

export interface Prerequisite {
  type: string;
  field?: string;
  op?: '<' | '>' | '<=' | '>=' | '==';
  value?: number | string;
  agent?: 'initiator' | 'target' | 'either';
  state?: string;
  state_any?: string[];
  target_matches?: boolean;
  role?: string;
  filter?: Record<string, any>;
  scope?: string;
  recency?: number;
  with_role?: string;
}

export interface EffectDef {
  system: 'relationship' | 'state' | 'needs' | 'fact' | 'economy' | 'goal';
  field?: string;
  delta?: number;
  target?: 'initiator' | 'target' | 'both';
  trigger?: string;
  type?: string;
  sensitivity?: number;
  subject?: string;
  advance?: number;
  transfer?: string;
  amount?: string;
}

export interface OutcomeFactor {
  stat: string;
  weight: number;
}

export interface EscalationDef {
  trigger: string;
  chance: number;
  condition: string;
}

export interface NarrationConfig {
  strategy: NarrationStrategy;
  severity_threshold?: number;
  token_budget: number;
  prompt_tone: string;
  templates: string[];
}

export interface CooldownConfig {
  ticks: number;
  scope: CooldownScope;
}

// ─── Registry entry shapes ───────────────────────────────────────────────────

export interface InteractionDef {
  category: InteractionCategory;
  visibility: number;
  duration: number;
  prerequisites: Prerequisite[];
  effects_success: EffectDef[];
  effects_failure: EffectDef[];
  on_success?: EscalationDef[];
  on_failure?: EscalationDef[];
  outcomeFactors: OutcomeFactor[];
  narration: NarrationConfig;
  cooldown: CooldownConfig;
  requiredZone?: Record<string, string[]>; // building_type → zone IDs
}

export interface AspirationDef {
  description: string;
  interaction_biases: Partial<Record<string, number>>;
  goal_affinity: string[];
  shift_triggers: Array<{
    event: string;
    personality?: string;
    chance?: number;
    becomes: AspirationType;
  }>;
}

export interface GoalProgressEvent {
  interaction?: string;
  condition?: string;
  target_matches?: boolean;
  progress: number;
}

export interface GoalAbandonmentRule {
  condition: string;
  chance?: number;
  auto?: boolean;
  on_target?: boolean;
  becomes?: GoalStatus;
}

export interface GoalDef {
  category: string;
  requires_target: boolean;
  valid_interactions: string[];
  strategy: 'any' | 'sequential' | 'none';
  target_selection?: string;
  progress_events: GoalProgressEvent[];
  completion_at: number;
  abandonment: GoalAbandonmentRule[];
  priority_formula: string;
}

export interface GoalTriggerDef {
  condition: {
    type: string;
    state?: string;
    has_target?: boolean;
    fact_type?: string;
    is_victim?: boolean;
    involves_partner?: boolean;
    aspiration?: string;
    money_below?: number;
    field?: string;
    op?: string;
    value?: number;
  };
  generates: string;
  target: string | null;
  priority_base: number;
  personality_gate: Record<string, string> | null;
  trigger_on?: 'observers';
}

export interface ReactiveRuleDef {
  id: string;
  produces: string;
  scan: 'co_located_pairs' | 'per_agent';
  initiator_select: string | null;
  target_select: { strategy: string; score_by?: string; filter?: string } | null;
  conditions: Prerequisite[];
  chance_formula: {
    base: number;
    modifiers: Array<{ stat: string; weight: number; reference: number }>;
    clamp: [number, number];
  };
  severity_base: number;
  cooldown: CooldownConfig;
  time_of_day: { after: number; before: number } | null;
}

// ─── Lookup maps ─────────────────────────────────────────────────────────────

export const LOCATION_WITNESS_MODIFIERS: Record<string, number> = {
  tavern: 1.2,
  town_square: 1.3,
  park: 0.9,
  home: 0.5,
  workplace: 0.8,
  clinic: 0.6,
  farm: 0.7,
  bakery: 0.8,
  shop: 0.9,
  jail: 0.7,
  town_hall: 0.9,
  workshop: 0.7,
};

export const ACTION_AWARENESS: Record<string, number> = {
  sleeping: 0.1,
  working: 0.7,
  idle: 1.0,
  talking: 0.5,
  fight: 0.2,
  eating: 0.8,
  shopping: 0.6,
  walking: 0.9,
  socializing: 0.7,
};

export const AWARENESS_TEMPLATES = {
  saw: {
    memory_template: '{narration}',
    importance_modifier: 1.0,
  },
  heard: {
    memory_template: '{agent} heard a commotion — something about {interaction_summary} between {participants}.',
    importance_modifier: 0.6,
  },
  suspected: {
    memory_template: '{agent} noticed something off between {initiator} and {target}, but couldn\'t tell what.',
    importance_modifier: 0.3,
  },
} as const;

export const NARRATION_PROMPT_VARIANTS: Record<string, { instruction: string; example: string }> = {
  visceral: {
    instruction: 'Write 1-2 sentences. Focus on physical detail and impact. Raw, unflinching.',
    example: "Marco's fist caught James square in the jaw. The old man staggered into a table, scattering glasses.",
  },
  intimate: {
    instruction: 'Write 1-2 sentences. Focus on body language and tension. Subtle, charged.',
    example: "Elena's hand lingered on Marco's arm a beat too long. Neither of them moved.",
  },
  tense: {
    instruction: 'Write 1-2 sentences. Focus on power dynamics and threat. Quiet menace.',
    example: "Ray leaned in close, badge catching the lamplight. 'I know what you did, Marco.'",
  },
  warm: {
    instruction: 'Write 1-2 sentences. Focus on small gestures and genuine emotion. Understated.',
    example: 'Rosa sat beside Yuki without a word, and after a moment, took her hand.',
  },
  neutral: {
    instruction: 'Write 1-2 sentences. Direct and factual. No dramatic flair.',
    example: 'Priya handed Carlos the money. He counted it twice before nodding.',
  },
};

export const RELIABILITY_SPREAD_RATE: Record<FactReliability, number> = {
  confirmed: 1.0,
  witnessed: 0.8,
  hearsay: 0.5,
  speculation: 0.2,
};

export const MAX_ESCALATION_DEPTH = 3;
export const MAX_GOALS_PER_AGENT = 4;
export const INTERACTION_CHANCE_PER_TICK = 0.05;
