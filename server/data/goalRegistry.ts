import type {
  GoalDef,
  GoalTriggerDef,
} from '../lib/interactionConstants';

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
      { condition: 'minutes_elapsed > 4320', chance: 0.3 },
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
      { condition: 'minutes_elapsed > 7200', chance: 0.2 },
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
      { condition: 'minutes_elapsed > 2880', chance: 0.4 },
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
      { condition: 'minutes_elapsed > 4320', chance: 0.3 },
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
      { condition: 'minutes_elapsed > 2880', chance: 0.5 },
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
      { condition: 'minutes_elapsed > 5760', chance: 0.3 },
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
    abandonment: [{ condition: 'minutes_elapsed > 14400', chance: 0.2 }],
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
      { condition: 'minutes_elapsed > 7200', chance: 0.3 },
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
      { condition: 'minutes_elapsed > 2880', chance: 0.3 },
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
