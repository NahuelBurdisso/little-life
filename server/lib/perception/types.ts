export interface PerceptionRule {
  id: string;
  observes: {
    target_states?: string[];
    target_is_state_target?: boolean;
    mood_below?: number;
    mood_above?: number;
    min_friendship?: number;
    max_friendship?: number;
    min_romance?: number;
    target_action?: string[];
  };
  reaction: string;
  base_score: number;
  personality_weights: Partial<Record<string, number>>;
  relationship_bonus?: {
    friendship_weight?: number;
    romance_weight?: number;
  };
  cooldown: number;
}

export interface ReactionDef {
  action: 'approach' | 'leave' | 'none';
  conversation_topic?: string;
  conversation_tier?: string;
  memory_template: string;
  trigger_reason: string;
}
