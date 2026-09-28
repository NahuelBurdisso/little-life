export interface DailyPlan {
  day: number;
  generated_at: number;
  blocks: PlanBlock[];
  needs_snapshot: { hunger: number; energy: number; social: number };
  /**
   * 'fallback' marks a schedule-derived plan cached because the LLM failed
   * (threw, timed out, or returned nothing parseable). It exists so the day
   * counts as planned — the decisions phase stops re-asking every pass — and so
   * the UI timeline has something to show. The executor does not run it (its
   * blocks would need LLM decomposition); the utility layer, which already
   * follows the same schedule, drives the agent instead. It is upgraded to an
   * LLM plan once the retry backoff expires. Absent on plans persisted before
   * this field existed, which are all LLM plans.
   */
  source?: 'llm' | 'fallback';
}

export interface PlanBlock {
  id: string;
  start_hour: number;
  end_hour: number;
  broad_action: string;
  location_hint: string;
  status: 'pending' | 'active' | 'completed' | 'interrupted' | 'replanned';
  decomposed_actions?: DecomposedAction[];
}

export interface DecomposedAction {
  description: string;
  action_type: string;
  target_location?: string;
  resolved_location_id?: number;
  target_agent?: string;
  resolved_agent_id?: number;
  topic?: string;
  duration_minutes: number;
}

export interface PlanExecutionState {
  currentBlockId: string | null;
  currentActionIndex: number;
  /** Absolute game minute (`gameMinuteOf`), not a tick count. */
  blockStartedAt: number;
  /** Absolute game minute (`gameMinuteOf`), not a tick count. */
  actionStartedAt: number;
}

export interface ReplanEvent {
  agentId: number;
  type: 'conversation' | 'state' | 'relationship';
  description: string;
  sentiment: number;
  isDramatic: boolean;
}
