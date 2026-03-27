import { ReactiveRuleDef } from '../lib/interactionConstants';

export const REACTIVE_RULE_REGISTRY: ReactiveRuleDef[] = [
  {
    id: 'drunk_rival_fight',
    produces: 'fight',
    scan: 'co_located_pairs',
    initiator_select: 'higher_aggression',
    target_select: null,
    conditions: [
      { type: 'state', agent: 'either', state: 'drunk' },
      { type: 'relationship', field: 'friendship', op: '<', value: -30 },
    ],
    chance_formula: {
      base: 0.3,
      modifiers: [
        { stat: 'aggression', weight: 0.005, reference: 50 },
        { stat: 'impulsiveness', weight: 0.004, reference: 50 },
      ],
      clamp: [0.05, 0.85],
    },
    severity_base: 0.5,
    cooldown: { ticks: 720, scope: 'pair' },
    time_of_day: null,
  },
  {
    id: 'infatuated_alone_flirt',
    produces: 'flirt',
    scan: 'co_located_pairs',
    initiator_select: 'has_state:infatuated',
    target_select: null,
    conditions: [
      { type: 'state', agent: 'initiator', state: 'infatuated', target_matches: true },
      { type: 'location_population', op: '<=', value: 3 },
    ],
    chance_formula: {
      base: 0.5,
      modifiers: [
        { stat: 'sensuality', weight: 0.008, reference: 50 },
        { stat: 'neuroticism', weight: -0.005, reference: 50 },
      ],
      clamp: [0.05, 0.85],
    },
    severity_base: 0.3,
    cooldown: { ticks: 360, scope: 'pair' },
    time_of_day: null,
  },
  {
    id: 'desperate_theft',
    produces: 'pickpocket',
    scan: 'co_located_pairs',
    initiator_select: 'lower_money',
    target_select: { strategy: 'highest', score_by: 'economy.money' },
    conditions: [
      { type: 'economy', agent: 'initiator', field: 'money', op: '<', value: 5 },
      { type: 'economy', agent: 'target', field: 'money', op: '>', value: 30 },
      { type: 'personality', agent: 'initiator', field: 'morality', op: '<', value: 40 },
    ],
    chance_formula: {
      base: 0.15,
      modifiers: [
        { stat: 'impulsiveness', weight: 0.005, reference: 50 },
        { stat: 'neuroticism', weight: -0.003, reference: 50 },
      ],
      clamp: [0.05, 0.85],
    },
    severity_base: 0.4,
    cooldown: { ticks: 1440, scope: 'initiator' },
    time_of_day: { after: 20, before: 5 },
  },
  {
    id: 'witness_comfort',
    produces: 'comfort',
    scan: 'co_located_pairs',
    initiator_select: 'higher_warmth',
    target_select: null,
    conditions: [
      { type: 'state', agent: 'target', state_any: ['grieving', 'heartbroken', 'lonely', 'depressed'] },
      { type: 'personality', agent: 'initiator', field: 'warmth', op: '>', value: 45 },
      { type: 'relationship', field: 'friendship', op: '>', value: 10 },
    ],
    chance_formula: {
      base: 0.4,
      modifiers: [
        { stat: 'warmth', weight: 0.008, reference: 50 },
        { stat: 'loyalty', weight: 0.005, reference: 50 },
      ],
      clamp: [0.05, 0.85],
    },
    severity_base: 0.5,
    cooldown: { ticks: 480, scope: 'pair' },
    time_of_day: null,
  },
  {
    id: 'drunk_buys_round',
    produces: 'buy_drinks',
    scan: 'per_agent',
    initiator_select: null,
    target_select: { strategy: 'random', filter: 'co_located' },
    conditions: [
      { type: 'location_type', value: 'tavern' },
      { type: 'state', agent: 'initiator', state: 'drunk' },
      { type: 'co_located_count', op: '>=', value: 2 },
      { type: 'economy', agent: 'initiator', field: 'money', op: '>', value: 15 },
    ],
    chance_formula: {
      base: 0.3,
      modifiers: [
        { stat: 'impulsiveness', weight: 0.01, reference: 50 },
        { stat: 'warmth', weight: 0.005, reference: 50 },
      ],
      clamp: [0.05, 0.85],
    },
    severity_base: 0.3,
    cooldown: { ticks: 720, scope: 'initiator' },
    time_of_day: null,
  },
  {
    id: 'constable_witnesses_crime',
    produces: 'arrest',
    scan: 'per_agent',
    initiator_select: null,
    target_select: { strategy: 'criminal', filter: 'known_criminal_facts' },
    conditions: [
      { type: 'agent_role', agent: 'initiator', role: 'constable' },
      { type: 'recent_interaction', filter: { category: 'crime' }, scope: 'witnessed_by_initiator', recency: 10 },
    ],
    chance_formula: {
      base: 0.8,
      modifiers: [
        { stat: 'morality', weight: 0.003, reference: 50 },
        { stat: 'aggression', weight: 0.002, reference: 50 },
      ],
      clamp: [0.05, 0.95],
    },
    severity_base: 0.6,
    cooldown: { ticks: 0, scope: 'pair' },
    time_of_day: null,
  },
];
