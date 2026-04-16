import type {
  AspirationDef,
  AspirationType,
  GoalDef,
  GoalTriggerDef,
} from '../lib/interactionConstants';

// ─── Aspiration Registry ──────────────────────────────────────────────────────

export const ASPIRATION_REGISTRY: Record<AspirationType, AspirationDef> = {
  wealth: {
    description: 'Accumulate money and resources',
    interaction_biases: {
      pickpocket: 0.3,
      blackmail: 0.2,
      fraud: 0.2,
      comfort: -0.1,
      lend_money: -0.3,
    },
    goal_affinity: ['steal_from', 'pay_debt'],
    shift_triggers: [
      { event: 'robbed', personality: 'aggression > 50', becomes: 'power' },
      { event: 'robbed', personality: 'morality > 60', becomes: 'justice' },
      { event: 'windfall', chance: 0.3, becomes: 'pleasure' },
    ],
  },

  love: {
    description: 'Find and maintain deep romantic connection',
    interaction_biases: {
      flirt: 0.3,
      date: 0.3,
      hookup: 0.2,
      propose_relationship: 0.3,
      comfort: 0.2,
      fight: -0.2,
    },
    goal_affinity: ['seduce', 'protect', 'befriend'],
    shift_triggers: [
      { event: 'heartbreak', personality: 'neuroticism > 60', becomes: 'pleasure' },
      { event: 'heartbreak', personality: 'aggression > 50', becomes: 'power' },
      { event: 'partner_found', chance: 0.2, becomes: 'legacy' },
    ],
  },

  power: {
    description: 'Gain influence and control over others',
    interaction_biases: {
      intimidate: 0.3,
      blackmail: 0.3,
      false_accusation: 0.2,
      comfort: -0.2,
      lend_money: -0.1,
    },
    goal_affinity: ['undermine', 'revenge'],
    shift_triggers: [
      { event: 'defeated_publicly', personality: 'neuroticism > 50', becomes: 'freedom' },
      { event: 'helped_by_stranger', personality: 'warmth > 60', becomes: 'justice' },
    ],
  },

  freedom: {
    description: 'Resist authority and maintain independence',
    interaction_biases: {
      fight: 0.1,
      vandalism: 0.2,
      arrest: -0.3,
      fine: -0.3,
    },
    goal_affinity: [],
    shift_triggers: [
      { event: 'arrested', personality: 'morality > 60', becomes: 'justice' },
      { event: 'protected_by_authority', chance: 0.2, becomes: 'legacy' },
    ],
  },

  justice: {
    description: 'Uphold fairness and protect the vulnerable',
    interaction_biases: {
      comfort: 0.2,
      nurse: 0.2,
      arrest: 0.2,
      pickpocket: -0.4,
      blackmail: -0.4,
      fraud: -0.4,
    },
    goal_affinity: ['investigate', 'protect'],
    shift_triggers: [
      { event: 'betrayed_by_authority', personality: 'aggression > 50', becomes: 'power' },
      { event: 'justice_served', chance: 0.15, becomes: 'legacy' },
    ],
  },

  knowledge: {
    description: 'Uncover secrets and understand everyone',
    interaction_biases: {
      spread_rumor: 0.1,
      eavesdrop: 0.2,
      interrogate: 0.2,
    },
    goal_affinity: ['investigate'],
    shift_triggers: [
      { event: 'secret_used_against_them', personality: 'aggression > 40', becomes: 'power' },
      { event: 'mentored_someone', chance: 0.2, becomes: 'legacy' },
    ],
  },

  legacy: {
    description: 'Build something lasting and be remembered',
    interaction_biases: {
      comfort: 0.2,
      lend_money: 0.2,
      nurse: 0.1,
      vandalism: -0.3,
      pickpocket: -0.3,
    },
    goal_affinity: ['protect', 'befriend'],
    shift_triggers: [
      { event: 'life_work_destroyed', personality: 'aggression > 50', becomes: 'power' },
      { event: 'life_work_destroyed', personality: 'neuroticism > 60', becomes: 'freedom' },
    ],
  },

  pleasure: {
    description: 'Maximize enjoyment and sensory experience',
    interaction_biases: {
      buy_drinks: 0.3,
      hookup: 0.3,
      flirt: 0.2,
      date: 0.2,
    },
    goal_affinity: ['seduce'],
    shift_triggers: [
      { event: 'addiction_consequences', personality: 'morality > 50', becomes: 'justice' },
      { event: 'deep_connection', chance: 0.3, becomes: 'love' },
    ],
  },
};

// ─── Goal Registry ────────────────────────────────────────────────────────────

export const GOAL_REGISTRY: Record<string, GoalDef> = {
  revenge: {
    category: 'hostile',
    requires_target: true,
    valid_interactions: [
      'fight',
      'pickpocket',
      'burglary',
      'blackmail',
      'workplace_sabotage',
      'frame',
      'spread_rumor',
    ],
    strategy: 'any',
    progress_events: [
      { interaction: 'fight', target_matches: true, progress: 0.4 },
      { interaction: 'blackmail', target_matches: true, progress: 0.8 },
      { interaction: 'spread_rumor', target_matches: true, progress: 0.3 },
      { interaction: 'vandalism', target_matches: true, progress: 0.6 },
    ],
    completion_at: 1.0,
    abandonment: [
      { condition: 'state_expired:angry', chance: 0.5 },
      { condition: 'relationship.friendship > 20', auto: true },
      { condition: 'ticks_elapsed > 4320', chance: 0.3 },
    ],
    priority_formula:
      'base(0.6) + severity(0.2) + personality.aggression(0.1) + personality.morality(-0.1)',
  },

  seduce: {
    category: 'romantic',
    requires_target: true,
    valid_interactions: ['flirt', 'date', 'hookup', 'propose_relationship'],
    strategy: 'sequential',
    progress_events: [
      { interaction: 'flirt', target_matches: true, progress: 0.2 },
      { interaction: 'date', target_matches: true, progress: 0.3 },
      { interaction: 'hookup', target_matches: true, progress: 0.4 },
      { interaction: 'propose_relationship', target_matches: true, progress: 0.5 },
    ],
    completion_at: 1.0,
    abandonment: [
      { condition: 'state_expired:infatuated', chance: 0.4 },
      { condition: 'relationship.romance < 0', auto: true },
      { condition: 'ticks_elapsed > 7200', chance: 0.2 },
    ],
    priority_formula:
      'base(0.5) + personality.sensuality(0.15) + personality.impulsiveness(0.1)',
    requiredZone: { tavern: ['booth'], park: ['grove_west', 'grove_east'] },
  },

  steal_from: {
    category: 'criminal',
    requires_target: true,
    valid_interactions: ['pickpocket', 'burglary', 'fraud'],
    strategy: 'any',
    progress_events: [
      { interaction: 'pickpocket', target_matches: true, progress: 0.5 },
      { interaction: 'burglary', target_matches: true, progress: 0.7 },
      { interaction: 'fraud', target_matches: true, progress: 0.6 },
    ],
    completion_at: 1.0,
    abandonment: [
      { condition: 'economy.money > 30', auto: true },
      { condition: 'ticks_elapsed > 2880', chance: 0.4 },
    ],
    priority_formula: 'base(0.4) + need_desperation(0.3) + personality.morality(-0.15)',
    requiredZone: { shop: ['storage'] },
  },

  protect: {
    category: 'prosocial',
    requires_target: true,
    valid_interactions: ['comfort', 'nurse', 'lend_money'],
    strategy: 'any',
    progress_events: [
      { interaction: 'comfort', target_matches: true, progress: 0.3 },
      { interaction: 'nurse', target_matches: true, progress: 0.4 },
      { interaction: 'lend_money', target_matches: true, progress: 0.5 },
    ],
    completion_at: 1.0,
    abandonment: [
      { condition: 'target_recovered', auto: true },
      { condition: 'ticks_elapsed > 4320', chance: 0.3 },
    ],
    priority_formula: 'base(0.5) + personality.warmth(0.15) + personality.loyalty(0.1)',
  },

  investigate: {
    category: 'neutral',
    requires_target: true,
    valid_interactions: ['eavesdrop', 'interrogate'],
    strategy: 'any',
    progress_events: [
      { interaction: 'eavesdrop', target_matches: true, progress: 0.3 },
      { interaction: 'interrogate', target_matches: true, progress: 0.4 },
    ],
    completion_at: 1.0,
    abandonment: [
      { condition: 'fact_confirmed', auto: true },
      { condition: 'ticks_elapsed > 2880', chance: 0.5 },
    ],
    priority_formula: 'base(0.4) + personality.curiosity(0.2)',
  },

  undermine: {
    category: 'hostile',
    requires_target: true,
    valid_interactions: ['spread_rumor', 'false_accusation', 'gaslight'],
    strategy: 'sequential',
    target_selection: 'target.friends',
    progress_events: [
      { interaction: 'spread_rumor', progress: 0.2 },
      { interaction: 'false_accusation', progress: 0.4 },
      { interaction: 'gaslight', progress: 0.3 },
    ],
    completion_at: 1.0,
    abandonment: [
      { condition: 'relationship.friendship > 0', auto: true },
      { condition: 'ticks_elapsed > 5760', chance: 0.3 },
    ],
    priority_formula:
      'base(0.5) + personality.aggression(0.1) + personality.morality(-0.15)',
  },

  // passive goal — does not drive interactions
  pay_debt: {
    category: 'survival',
    requires_target: false,
    valid_interactions: [],
    strategy: 'none',
    progress_events: [{ condition: 'economy.money > 0', progress: 1.0 }],
    completion_at: 1.0,
    abandonment: [{ condition: 'ticks_elapsed > 14400', chance: 0.2 }],
    priority_formula: 'base(0.7) + debt_severity(0.2)',
  },

  // passive goal
  get_sober: {
    category: 'survival',
    requires_target: false,
    valid_interactions: [],
    strategy: 'none',
    progress_events: [{ condition: 'state_expired:alcoholic', progress: 1.0 }],
    completion_at: 1.0,
    abandonment: [{ condition: 'relapsed', auto: true, becomes: 'failed' }],
    priority_formula: 'base(0.6) + personality.morality(0.1)',
  },

  befriend: {
    category: 'prosocial',
    requires_target: true,
    valid_interactions: ['comfort', 'buy_drinks', 'lend_money'],
    strategy: 'any',
    progress_events: [
      { interaction: 'comfort', target_matches: true, progress: 0.2 },
      { interaction: 'buy_drinks', target_matches: true, progress: 0.2 },
      { interaction: 'lend_money', target_matches: true, progress: 0.3 },
    ],
    completion_at: 1.0,
    abandonment: [
      { condition: 'relationship.friendship > 50', auto: true, becomes: 'completed' },
      { condition: 'relationship.friendship < -20', auto: true, becomes: 'failed' },
      { condition: 'ticks_elapsed > 7200', chance: 0.3 },
    ],
    priority_formula:
      'base(0.3) + personality.warmth(0.1) + personality.loyalty(0.1)',
  },

  comfort_grieving: {
    category: 'prosocial',
    requires_target: true,
    valid_interactions: ['comfort'],
    strategy: 'any',
    progress_events: [{ interaction: 'comfort', target_matches: true, progress: 0.4 }],
    completion_at: 1.0,
    abandonment: [
      { condition: 'state_expired:grieving', on_target: true, auto: true },
      { condition: 'ticks_elapsed > 2880', chance: 0.3 },
    ],
    priority_formula:
      'base(0.5) + personality.warmth(0.2) + relationship.friendship(0.1)',
  },
};

// ─── Goal Trigger Registry ────────────────────────────────────────────────────

export const GOAL_TRIGGER_REGISTRY: GoalTriggerDef[] = [
  {
    condition: { type: 'state_gained', state: 'angry', has_target: true },
    generates: 'revenge',
    target: 'state.target_agent_id',
    priority_base: 0.6,
    personality_gate: { aggression: '> 35' },
  },
  {
    condition: { type: 'state_gained', state: 'infatuated', has_target: true },
    generates: 'seduce',
    target: 'state.target_agent_id',
    priority_base: 0.5,
    personality_gate: { sensuality: '> 30' },
  },
  {
    condition: { type: 'fact_learned', fact_type: 'theft', is_victim: true },
    generates: 'revenge',
    target: 'fact.subject_id',
    priority_base: 0.7,
    personality_gate: null,
  },
  {
    condition: { type: 'fact_learned', fact_type: 'affair', involves_partner: true },
    generates: 'revenge',
    target: 'fact.subject_id',
    priority_base: 0.8,
    personality_gate: null,
  },
  {
    condition: { type: 'state_gained', state: 'grieving', has_target: false },
    generates: 'comfort_grieving',
    target: 'grieving_agent',
    priority_base: 0.5,
    personality_gate: { warmth: '> 45' },
    trigger_on: 'observers',
  },
  {
    condition: { type: 'state_gained', state: 'in_debt' },
    generates: 'pay_debt',
    target: null,
    priority_base: 0.7,
    personality_gate: null,
  },
  {
    condition: { type: 'state_gained', state: 'sick', has_target: false },
    generates: 'protect',
    target: 'sick_agent',
    priority_base: 0.5,
    personality_gate: { warmth: '> 40' },
    trigger_on: 'observers',
  },
  {
    condition: { type: 'fact_learned', fact_type: 'theft', is_victim: false },
    generates: 'investigate',
    target: 'fact.subject_id',
    priority_base: 0.6,
    personality_gate: { morality: '> 55' },
  },
];
