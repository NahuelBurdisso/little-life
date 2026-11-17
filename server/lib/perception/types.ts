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
    /**
     * Only observers in one of these trades notice this (`economy.job`). Without
     * it `constable_sees_criminal` sent anyone at all to "investigate" a debtor.
     */
    observer_jobs?: string[];
  };
  reaction: string;
  base_score: number;
  personality_weights: Partial<Record<string, number>>;
  relationship_bonus?: {
    friendship_weight?: number;
    romance_weight?: number;
  };
  /** Game minutes before the same observer→target pair can fire this rule again. */
  cooldown: number;
}

export interface ReactionDef {
  action: 'approach' | 'leave' | 'none' | 'emote';
  conversation_topic?: string;
  conversation_tier?: string;
  /** Key in the client's EMOTE_EMOJIS map. Only read when `action === 'emote'`. */
  emote?: string;
  memory_template: string;
  trigger_reason: string;
}
