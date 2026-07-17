import type { PerceptionRule, ReactionDef } from './types';

export const PERCEPTION_REGISTRY: PerceptionRule[] = [
  {
    id: 'friend_distressed',
    observes: {
      mood_below: 22,
      min_friendship: 40,
    },
    reaction: 'approach_comfort',
    base_score: 42,
    personality_weights: {
      warmth: 0.6,
      neuroticism: 0.2,
    },
    relationship_bonus: {
      friendship_weight: 0.8,
    },
    cooldown: 120,
  },
  {
    id: 'friend_grieving',
    observes: {
      target_states: ['grieving', 'heartbroken', 'depressed'],
      min_friendship: 30,
    },
    reaction: 'approach_comfort',
    base_score: 55,
    personality_weights: {
      warmth: 0.7,
      loyalty: 0.4,
    },
    relationship_bonus: {
      friendship_weight: 0.6,
    },
    cooldown: 50,
  },
  {
    id: 'enemy_nearby',
    observes: {
      max_friendship: -20,
    },
    reaction: 'confront_or_avoid',
    base_score: 40,
    personality_weights: {
      aggression: 0.6,
      neuroticism: 0.3,
    },
    cooldown: 40,
  },
  {
    id: 'rival_with_partner',
    observes: {
      target_states: ['in_relationship', 'partner'],
      max_friendship: 0,
      min_romance: 20,
    },
    reaction: 'jealous_reaction',
    base_score: 45,
    personality_weights: {
      neuroticism: 0.5,
      impulsiveness: 0.4,
      vanity: 0.3,
    },
    relationship_bonus: {
      romance_weight: 0.7,
    },
    cooldown: 60,
  },
  {
    id: 'crush_spotted',
    observes: {
      min_romance: 15,
    },
    reaction: 'approach_flirt',
    base_score: 45,
    personality_weights: {
      sensuality: 0.7,
      impulsiveness: 0.3,
    },
    relationship_bonus: {
      romance_weight: 0.9,
    },
    cooldown: 20,
  },
  {
    id: 'partner_nearby',
    observes: {
      min_romance: 50,
    },
    reaction: 'approach_partner',
    base_score: 60,
    personality_weights: {
      warmth: 0.5,
      loyalty: 0.4,
    },
    relationship_bonus: {
      romance_weight: 1.0,
    },
    cooldown: 25,
  },
  {
    id: 'someone_sick',
    observes: {
      target_states: ['sick', 'injured', 'exhausted'],
    },
    reaction: 'offer_help',
    base_score: 35,
    personality_weights: {
      warmth: 0.6,
      morality: 0.4,
    },
    cooldown: 40,
  },
  {
    id: 'someone_drunk',
    observes: {
      target_states: ['drunk', 'alcoholic'],
    },
    reaction: 'offer_help',
    base_score: 30,
    personality_weights: {
      morality: 0.5,
      warmth: 0.3,
    },
    cooldown: 35,
  },
  {
    id: 'witness_theft',
    observes: {
      target_action: ['stealing'],
    },
    reaction: 'witness_crime',
    base_score: 50,
    personality_weights: {
      morality: 0.8,
      honesty: 0.4,
    },
    cooldown: 80,
  },
  {
    id: 'acquaintance_happy',
    observes: {
      mood_above: 70,
      min_friendship: 10,
    },
    reaction: 'approach_chat',
    base_score: 25,
    personality_weights: {
      warmth: 0.4,
      curiosity: 0.3,
    },
    relationship_bonus: {
      friendship_weight: 0.3,
    },
    cooldown: 20,
  },
  {
    id: 'someone_in_debt',
    observes: { target_states: ['in_debt'], min_friendship: 20 },
    reaction: 'offer_help',
    base_score: 35,
    personality_weights: { warmth: 0.5, morality: 0.3 },
    cooldown: 180,
  },
  {
    id: 'someone_arrested',
    observes: { target_states: ['arrested'] },
    reaction: 'observe_only',
    base_score: 40,
    personality_weights: { curiosity: 0.4, morality: 0.2 },
    cooldown: 120,
  },
  {
    id: 'constable_sees_criminal',
    observes: { target_states: ['in_debt'] },
    reaction: 'approach_investigate',
    base_score: 35,
    personality_weights: { morality: 0.5 },
    cooldown: 180,
  },
  {
    id: 'someone_angry',
    observes: { target_states: ['angry'], min_friendship: -10 },
    reaction: 'approach_cautious',
    base_score: 30,
    personality_weights: { warmth: 0.4, curiosity: 0.3, neuroticism: -0.2 },
    relationship_bonus: { friendship_weight: 0.5 },
    cooldown: 40,
  },
  {
    id: 'someone_euphoric',
    observes: { target_states: ['euphoric', 'confident'] },
    reaction: 'approach_chat',
    base_score: 30,
    personality_weights: { warmth: 0.3, curiosity: 0.3 },
    cooldown: 25,
  },
  {
    id: 'infatuated_sees_target',
    observes: { target_is_state_target: true },
    reaction: 'approach_flirt',
    base_score: 55,
    personality_weights: { sensuality: 0.6, impulsiveness: 0.4 },
    cooldown: 30,
  },
  {
    id: 'someone_lonely',
    observes: {
      target_states: ['lonely'],
      min_friendship: 10,
    },
    reaction: 'approach_comfort',
    base_score: 40,
    personality_weights: {
      warmth: 0.7,
      loyalty: 0.3,
    },
    relationship_bonus: {
      friendship_weight: 0.5,
    },
    cooldown: 60,
  },
  {
    id: 'enemy_nearby_angry',
    observes: {
      target_states: ['angry'],
      max_friendship: -30,
    },
    reaction: 'confront_or_avoid',
    base_score: 45,
    personality_weights: {
      aggression: 0.7,
      neuroticism: -0.3,
    },
    cooldown: 60,
  },
  {
    id: 'someone_jealous',
    observes: {
      target_states: ['jealous'],
    },
    reaction: 'observe_only',
    base_score: 25,
    personality_weights: {
      curiosity: 0.5,
    },
    cooldown: 40,
  },
];

export const REACTION_TYPES: Record<string, ReactionDef> = {
  approach_comfort: {
    action: 'approach',
    conversation_topic: 'offering comfort',
    conversation_tier: 'llm_deep',
    memory_template: 'perception_friend_distressed',
    trigger_reason: 'perception_comfort',
  },
  confront_or_avoid: {
    action: 'leave',
    memory_template: 'perception_enemy',
    trigger_reason: 'perception_enemy_nearby',
  },
  approach_flirt: {
    action: 'approach',
    conversation_topic: 'flirting',
    conversation_tier: 'llm_standard',
    memory_template: 'perception_crush',
    trigger_reason: 'perception_crush_spotted',
  },
  approach_partner: {
    action: 'approach',
    conversation_topic: 'catching up',
    conversation_tier: 'llm_standard',
    memory_template: 'perception_partner',
    trigger_reason: 'perception_partner_nearby',
  },
  offer_help: {
    action: 'approach',
    conversation_topic: 'offering help',
    conversation_tier: 'llm_standard',
    memory_template: 'perception_someone_needs_help',
    trigger_reason: 'perception_offer_help',
  },
  witness_crime: {
    action: 'none',
    memory_template: 'perception_witnessed_crime',
    trigger_reason: 'perception_witnessed_crime',
  },
  approach_chat: {
    action: 'approach',
    conversation_topic: 'casual chat',
    conversation_tier: 'template',
    memory_template: 'perception_casual',
    trigger_reason: 'perception_casual_chat',
  },
  jealous_reaction: {
    action: 'approach',
    conversation_topic: 'tension',
    conversation_tier: 'llm_deep',
    memory_template: 'perception_jealousy',
    trigger_reason: 'perception_jealousy',
  },
  approach_cautious: {
    action: 'approach',
    conversation_topic: 'checking in',
    conversation_tier: 'llm_standard',
    memory_template: 'perception_someone_angry',
    trigger_reason: 'perception_cautious_approach',
  },
  observe_only: {
    action: 'none',
    memory_template: 'perception_general_observation',
    trigger_reason: 'perception:observe',
  },
  approach_investigate: {
    action: 'approach',
    conversation_topic: 'checking on {target}',
    conversation_tier: 'llm_standard',
    memory_template: 'perception_investigate',
    trigger_reason: 'perception:investigate',
  },
};
