// ─── LLM Output Types ─────────────────────────────────────────────────────

export interface AmbitionShift {
  shift: string;
  category: string;
  reason: string;
}

export interface GoalReviewAction {
  goal_id: number;
  action: 'continue' | 'adjust' | 'done' | 'abandon';
  reason: string;
  new_strategy?: string;
}

export interface NewGoalOutput {
  description: string;
  target_agent: string | null;
  category_hint: string;
  strategy: string;
  priority: number;
}

export interface GoalReviewResult {
  ambition: 'keep' | AmbitionShift;
  reviews: GoalReviewAction[];
  new_goals: NewGoalOutput[];
}

export interface PivotResult {
  new_strategy: string;
  new_category_hint?: string;
}

export interface AmbitionGenerationResult {
  description: string;
  category: string;
  reason: string;
}

// ─── Mapper Output ─────────────────────────────────────────────────────────

export interface MappedGoal {
  type: string;
  mapped_interactions: string[];
  target_id: number | null;
}

// ─── Constants ─────────────────────────────────────────────────────────────

// Game minutes since `goals.created_at` (1 and 3 game days).
export const PIVOT_THRESHOLD_MINUTES = 1440;
export const STALE_ABANDON_MINUTES = 4320;
/**
 * A goal about no one in particular has no outcome to make progress on: only
 * the morning review can call it done. It gets twice as long before the stale
 * sweep gives up on it for the agent.
 */
export const STALE_ABANDON_UNTARGETED_MINUTES = STALE_ABANDON_MINUTES * 2;
export const MAX_LLM_GOALS = 3;
