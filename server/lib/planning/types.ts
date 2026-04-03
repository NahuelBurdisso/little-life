export interface DailyPlan {
  day: number;
  generated_at: number;
  blocks: PlanBlock[];
  needs_snapshot: { hunger: number; energy: number; social: number };
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
  blockStartedAt: number;
  actionStartedAt: number;
}

export interface ReplanEvent {
  agentId: number;
  type: 'conversation' | 'state' | 'relationship';
  description: string;
  sentiment: number;
  isDramatic: boolean;
}
