// Goal system — shared types and constants (the data-driven interaction
// pipeline these once served was removed; goalRegistry and goals.ts remain).

// ─── Types ───────────────────────────────────────────────────────────────────

export type GoalStatus = 'active' | 'completed' | 'abandoned' | 'failed';

// ─── Registry entry shapes ───────────────────────────────────────────────────

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
  /** Optional zone hint for PlanDecomposer routing: building_type → zone IDs */
  requiredZone?: Record<string, string[]>;
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

export const MAX_GOALS_PER_AGENT = 4;
