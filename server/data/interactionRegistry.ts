import type { InteractionDef } from '../lib/interactionConstants';

export const INTERACTION_REGISTRY: Record<string, InteractionDef> = {

  // ─── CONFLICT ──────────────────────────────────────────────────────────────

  fight: {
    category: 'conflict',
    visibility: 0.9,
    duration: 15,
    prerequisites: [
      { type: 'co_located' },
      { type: 'relationship', field: 'friendship', op: '<', value: 0, agent: 'initiator' },
      { type: 'personality', field: 'aggression', op: '>', value: 40, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'relationship', field: 'friendship', delta: -20, target: 'both' },
      { system: 'relationship', field: 'trust', delta: -30, target: 'both' },
      { system: 'state', type: 'angry', target: 'both' },
      { system: 'needs', field: 'energy', delta: -15, target: 'both' },
      { system: 'fact', type: 'fight', sensitivity: 1, subject: 'initiator' },
      { system: 'goal', advance: 0.4 },
    ],
    effects_failure: [
      { system: 'relationship', field: 'friendship', delta: -10, target: 'both' },
      { system: 'needs', field: 'energy', delta: -10, target: 'initiator' },
      { system: 'state', type: 'angry', target: 'initiator' },
    ],
    on_failure: [
      { trigger: 'fight', chance: 0.4, condition: 'initiator.aggression > 55' },
      { trigger: 'flee', chance: 0.3, condition: 'initiator.neuroticism > 50' },
    ],
    on_success: [
      { trigger: 'blackmail', chance: 0.2, condition: 'initiator.knows_secret_about_target' },
    ],
    outcomeFactors: [
      { stat: 'aggression', weight: 0.4 },
      { stat: 'needs:energy', weight: 0.3 },
      { stat: 'state:drunk', weight: -0.2 },
    ],
    narration: {
      strategy: 'always',
      token_budget: 80,
      prompt_tone: 'visceral',
      templates: [
        '{initiator} threw a punch at {target} in {location}.',
        '{initiator} and {target} got into a brawl at {location}.',
      ],
    },
    cooldown: { ticks: 720, scope: 'pair' },
  },

  shove: {
    category: 'conflict',
    visibility: 0.7,
    duration: 5,
    prerequisites: [
      { type: 'co_located' },
      { type: 'state_or_personality', state_any: ['angry'], field: 'impulsiveness', op: '>', value: 60, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'relationship', field: 'friendship', delta: -10, target: 'both' },
      { system: 'needs', field: 'energy', delta: -5, target: 'both' },
    ],
    effects_failure: [
      { system: 'needs', field: 'energy', delta: -3, target: 'initiator' },
    ],
    on_failure: [
      { trigger: 'fight', chance: 0.3, condition: 'target.aggression > 50' },
    ],
    outcomeFactors: [
      { stat: 'aggression', weight: 0.3 },
      { stat: 'impulsiveness', weight: 0.3 },
    ],
    narration: {
      strategy: 'if_severity',
      severity_threshold: 0.4,
      token_budget: 60,
      prompt_tone: 'visceral',
      templates: [
        '{initiator} shoved {target} at {location}.',
        '{initiator} pushed {target} roughly.',
      ],
    },
    cooldown: { ticks: 360, scope: 'pair' },
  },

  intimidate: {
    category: 'conflict',
    visibility: 0.6,
    duration: 10,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'aggression', op: '>', value: 50, agent: 'initiator' },
      { type: 'relationship', field: 'friendship', op: '<', value: 20, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'relationship', field: 'trust', delta: -25, target: 'target' },
      { system: 'state', type: 'stressed', target: 'target' },
      { system: 'goal', advance: 0.3 },
    ],
    effects_failure: [
      { system: 'relationship', field: 'friendship', delta: -5, target: 'both' },
      { system: 'state', type: 'angry', target: 'target' },
    ],
    on_failure: [
      { trigger: 'fight', chance: 0.4, condition: 'target.aggression > 50' },
    ],
    on_success: [
      { trigger: 'blackmail', chance: 0.2, condition: 'initiator.knows_secret_about_target' },
    ],
    outcomeFactors: [
      { stat: 'aggression', weight: 0.4 },
      { stat: 'vanity', weight: 0.2 },
    ],
    narration: {
      strategy: 'always',
      token_budget: 80,
      prompt_tone: 'tense',
      templates: [
        '{initiator} cornered {target} at {location}.',
        "{initiator} got in {target}'s face at {location}.",
      ],
    },
    cooldown: { ticks: 720, scope: 'pair' },
  },

  // ─── CRIME ─────────────────────────────────────────────────────────────────

  pickpocket: {
    category: 'crime',
    visibility: 0.2,
    duration: 5,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'morality', op: '<', value: 50, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'economy', transfer: 'target_to_initiator', amount: '0.3 * target.money' },
      { system: 'fact', type: 'theft', sensitivity: 3, subject: 'initiator' },
      { system: 'goal', advance: 0.5 },
    ],
    effects_failure: [
      { system: 'fact', type: 'theft', sensitivity: 2, subject: 'initiator' },
      { system: 'state', type: 'angry', target: 'target' },
      { system: 'relationship', field: 'trust', delta: -40, target: 'target' },
    ],
    outcomeFactors: [
      { stat: 'impulsiveness', weight: 0.3 },
      { stat: 'needs:energy', weight: 0.2 },
      { stat: 'state:drunk', weight: -0.3 },
    ],
    narration: {
      strategy: 'if_witnessed',
      token_budget: 60,
      prompt_tone: 'tense',
      templates: [
        "{initiator} slipped a hand into {target}'s pocket.",
        '{initiator} lifted some coins from {target}.',
      ],
    },
    cooldown: { ticks: 1440, scope: 'initiator' },
  },

  burglary: {
    category: 'crime',
    visibility: 0.1,
    duration: 20,
    prerequisites: [
      { type: 'personality', field: 'morality', op: '<', value: 40, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'economy', transfer: 'target_to_initiator', amount: '0.5 * target.money' },
      { system: 'fact', type: 'theft', sensitivity: 3, subject: 'initiator' },
      { system: 'goal', advance: 0.7 },
    ],
    effects_failure: [
      { system: 'fact', type: 'theft', sensitivity: 2, subject: 'initiator' },
    ],
    outcomeFactors: [
      { stat: 'impulsiveness', weight: 0.2 },
      { stat: 'curiosity', weight: 0.3 },
    ],
    narration: {
      strategy: 'if_witnessed',
      token_budget: 60,
      prompt_tone: 'tense',
      templates: [
        "{initiator} broke into {target}'s home.",
        "{initiator} ransacked {target}'s belongings.",
      ],
    },
    cooldown: { ticks: 2880, scope: 'initiator' },
  },

  vandalism: {
    category: 'crime',
    visibility: 0.4,
    duration: 10,
    prerequisites: [
      { type: 'personality', field: 'aggression', op: '>', value: 40, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'economy', field: 'money', delta: -20, target: 'target' },
      { system: 'fact', type: 'vandalism', sensitivity: 2, subject: 'initiator' },
      { system: 'goal', advance: 0.6 },
    ],
    effects_failure: [
      { system: 'fact', type: 'vandalism', sensitivity: 1, subject: 'initiator' },
    ],
    outcomeFactors: [
      { stat: 'aggression', weight: 0.3 },
      { stat: 'impulsiveness', weight: 0.3 },
    ],
    narration: {
      strategy: 'if_witnessed',
      token_budget: 60,
      prompt_tone: 'visceral',
      templates: [
        "{initiator} trashed {target}'s property.",
        '{initiator} smashed things up at {location}.',
      ],
    },
    cooldown: { ticks: 1440, scope: 'initiator' },
  },

  fraud: {
    category: 'crime',
    visibility: 0.1,
    duration: 15,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'honesty', op: '<', value: 30, agent: 'initiator' },
      { type: 'relationship', field: 'trust', op: '>', value: 30, agent: 'target' },
    ],
    effects_success: [
      { system: 'economy', transfer: 'target_to_initiator', amount: '0.4 * target.money' },
      { system: 'relationship', field: 'trust', delta: -40, target: 'target' },
      { system: 'fact', type: 'fraud', sensitivity: 3, subject: 'initiator' },
      { system: 'goal', advance: 0.6 },
    ],
    effects_failure: [
      { system: 'relationship', field: 'trust', delta: -50, target: 'target' },
      { system: 'fact', type: 'fraud', sensitivity: 2, subject: 'initiator' },
      { system: 'state', type: 'angry', target: 'target' },
    ],
    outcomeFactors: [
      { stat: 'honesty', weight: -0.4 },
      { stat: 'curiosity', weight: 0.2 },
    ],
    narration: {
      strategy: 'if_witnessed',
      token_budget: 60,
      prompt_tone: 'tense',
      templates: [
        '{initiator} swindled {target} out of their money.',
        '{initiator} pulled a fast one on {target}.',
      ],
    },
    cooldown: { ticks: 2880, scope: 'pair' },
  },

  // ─── ROMANCE ───────────────────────────────────────────────────────────────

  flirt: {
    category: 'romance',
    visibility: 0.5,
    duration: 10,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'sensuality', op: '>', value: 40, agent: 'initiator' },
      { type: 'relationship_or_state', field: 'romance', op: '>', value: 10, state: 'infatuated', agent: 'initiator' },
    ],
    effects_success: [
      { system: 'relationship', field: 'romance', delta: 10, target: 'both' },
      { system: 'needs', field: 'fun', delta: 5, target: 'both' },
      { system: 'state', type: 'infatuated', target: 'initiator' },
    ],
    effects_failure: [
      { system: 'needs', field: 'mood', delta: -5, target: 'initiator' },
    ],
    outcomeFactors: [
      { stat: 'sensuality', weight: 0.3 },
      { stat: 'warmth', weight: 0.2 },
      { stat: 'vanity', weight: 0.1 },
    ],
    narration: {
      strategy: 'if_severity',
      severity_threshold: 0.5,
      token_budget: 60,
      prompt_tone: 'intimate',
      templates: [
        '{initiator} flirted with {target} at {location}.',
        "{initiator} caught {target}'s eye at {location}.",
      ],
    },
    cooldown: { ticks: 360, scope: 'pair' },
  },

  date: {
    category: 'romance',
    visibility: 0.6,
    duration: 30,
    prerequisites: [
      { type: 'co_located' },
      { type: 'relationship', field: 'romance', op: '>', value: 30, agent: 'either' },
    ],
    effects_success: [
      { system: 'relationship', field: 'romance', delta: 15, target: 'both' },
      { system: 'relationship', field: 'friendship', delta: 10, target: 'both' },
      { system: 'needs', field: 'social', delta: 10, target: 'both' },
      { system: 'needs', field: 'mood', delta: 10, target: 'both' },
      { system: 'goal', advance: 0.3 },
    ],
    effects_failure: [
      { system: 'needs', field: 'mood', delta: -5, target: 'both' },
    ],
    outcomeFactors: [
      { stat: 'sensuality', weight: 0.2 },
      { stat: 'warmth', weight: 0.3 },
    ],
    narration: {
      strategy: 'always',
      token_budget: 80,
      prompt_tone: 'intimate',
      templates: [
        '{initiator} and {target} spent time together at {location}.',
        '{initiator} took {target} out at {location}.',
      ],
    },
    cooldown: { ticks: 720, scope: 'pair' },
  },

  hookup: {
    category: 'romance',
    visibility: 0.3,
    duration: 20,
    prerequisites: [
      { type: 'co_located' },
      { type: 'relationship', field: 'romance', op: '>', value: 50, agent: 'either' },
      { type: 'location_type', value: 'home' },
    ],
    effects_success: [
      { system: 'relationship', field: 'romance', delta: 20, target: 'both' },
      { system: 'needs', field: 'fun', delta: 15, target: 'both' },
      { system: 'fact', type: 'affair', sensitivity: 3, subject: 'initiator' },
      { system: 'goal', advance: 0.4 },
    ],
    effects_failure: [
      { system: 'needs', field: 'mood', delta: -10, target: 'both' },
      { system: 'relationship', field: 'romance', delta: -5, target: 'both' },
    ],
    outcomeFactors: [
      { stat: 'sensuality', weight: 0.4 },
      { stat: 'impulsiveness', weight: 0.2 },
    ],
    narration: {
      strategy: 'if_witnessed',
      token_budget: 60,
      prompt_tone: 'intimate',
      templates: [
        '{initiator} and {target} slipped away together.',
        '{initiator} and {target} spent the night together.',
      ],
    },
    cooldown: { ticks: 1440, scope: 'pair' },
  },

  propose_relationship: {
    category: 'romance',
    visibility: 0.7,
    duration: 10,
    prerequisites: [
      { type: 'co_located' },
      { type: 'relationship', field: 'romance', op: '>', value: 60, agent: 'either' },
      { type: 'relationship', field: 'trust', op: '>', value: 40, agent: 'either' },
    ],
    effects_success: [
      { system: 'relationship', field: 'romance', delta: 20, target: 'both' },
      { system: 'relationship', field: 'trust', delta: 15, target: 'both' },
      { system: 'fact', type: 'relationship_formed', sensitivity: 1, subject: 'initiator' },
      { system: 'goal', advance: 0.5 },
    ],
    effects_failure: [
      { system: 'needs', field: 'mood', delta: -20, target: 'initiator' },
      { system: 'relationship', field: 'romance', delta: -10, target: 'initiator' },
      { system: 'state', type: 'heartbroken', target: 'initiator' },
    ],
    outcomeFactors: [
      { stat: 'warmth', weight: 0.3 },
      { stat: 'loyalty', weight: 0.3 },
    ],
    narration: {
      strategy: 'always',
      token_budget: 80,
      prompt_tone: 'intimate',
      templates: [
        '{initiator} asked {target} to be together.',
        '{initiator} confessed their feelings to {target}.',
      ],
    },
    cooldown: { ticks: 4320, scope: 'pair' },
  },

  breakup: {
    category: 'romance',
    visibility: 0.5,
    duration: 15,
    prerequisites: [
      { type: 'co_located' },
      { type: 'relationship_low_or_betrayal', field: 'romance', op: '<', value: 20, filter: { fact_type: 'betrayal' }, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'state', type: 'heartbroken', target: 'target' },
      { system: 'relationship', field: 'friendship', delta: -20, target: 'both' },
      { system: 'relationship', field: 'romance', delta: -30, target: 'both' },
      { system: 'fact', type: 'breakup', sensitivity: 1, subject: 'initiator' },
    ],
    effects_failure: [
      { system: 'needs', field: 'mood', delta: -15, target: 'both' },
      { system: 'needs', field: 'stress', delta: 10, target: 'both' },
    ],
    outcomeFactors: [
      { stat: 'aggression', weight: 0.2 },
      { stat: 'neuroticism', weight: -0.2 },
    ],
    narration: {
      strategy: 'always',
      token_budget: 80,
      prompt_tone: 'visceral',
      templates: [
        '{initiator} ended things with {target}.',
        '{initiator} broke up with {target} at {location}.',
      ],
    },
    cooldown: { ticks: 4320, scope: 'pair' },
  },

  // ─── MANIPULATION ──────────────────────────────────────────────────────────

  blackmail: {
    category: 'manipulation',
    visibility: 0.1,
    duration: 15,
    prerequisites: [
      { type: 'co_located' },
      { type: 'knows_fact', filter: { sensitivity: 3 }, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'economy', transfer: 'target_to_initiator', amount: '0.3 * target.money' },
      { system: 'relationship', field: 'trust', delta: -40, target: 'target' },
      { system: 'state', type: 'stressed', target: 'target' },
      { system: 'goal', advance: 0.8 },
    ],
    effects_failure: [
      { system: 'relationship', field: 'trust', delta: -30, target: 'target' },
      { system: 'state', type: 'angry', target: 'target' },
      { system: 'fact', type: 'blackmail', sensitivity: 3, subject: 'initiator' },
    ],
    outcomeFactors: [
      { stat: 'aggression', weight: 0.2 },
      { stat: 'honesty', weight: -0.3 },
    ],
    narration: {
      strategy: 'always',
      token_budget: 80,
      prompt_tone: 'tense',
      templates: [
        "{initiator} threatened to expose {target}'s secret.",
        '{initiator} cornered {target} with what they know.',
      ],
    },
    cooldown: { ticks: 2880, scope: 'pair' },
  },

  spread_rumor: {
    category: 'manipulation',
    visibility: 0.2,
    duration: 10,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'honesty', op: '<', value: 45, agent: 'initiator' },
      { type: 'knows_fact', agent: 'initiator' },
    ],
    effects_success: [
      { system: 'fact', type: 'rumor', sensitivity: 2, subject: 'initiator' },
      { system: 'goal', advance: 0.3 },
    ],
    effects_failure: [
      { system: 'relationship', field: 'trust', delta: -10, target: 'both' },
    ],
    outcomeFactors: [
      { stat: 'honesty', weight: -0.3 },
      { stat: 'curiosity', weight: 0.2 },
    ],
    narration: {
      strategy: 'template_only',
      token_budget: 0,
      prompt_tone: 'neutral',
      templates: [
        '{initiator} whispered something about {target}.',
        '{initiator} spread a rumor about {target}.',
      ],
    },
    cooldown: { ticks: 720, scope: 'pair' },
  },

  gaslight: {
    category: 'manipulation',
    visibility: 0.1,
    duration: 15,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'honesty', op: '<', value: 30, agent: 'initiator' },
      { type: 'relationship', field: 'trust', op: '>', value: 40, agent: 'target' },
    ],
    effects_success: [
      { system: 'state', type: 'stressed', target: 'target' },
      { system: 'needs', field: 'mood', delta: -10, target: 'target' },
      { system: 'goal', advance: 0.3 },
    ],
    effects_failure: [
      { system: 'relationship', field: 'trust', delta: -20, target: 'target' },
      { system: 'state', type: 'angry', target: 'target' },
    ],
    outcomeFactors: [
      { stat: 'honesty', weight: -0.4 },
      { stat: 'warmth', weight: 0.2 },
    ],
    narration: {
      strategy: 'if_severity',
      severity_threshold: 0.5,
      token_budget: 60,
      prompt_tone: 'tense',
      templates: [
        '{initiator} made {target} question their own memory.',
        '{initiator} twisted the truth when talking to {target}.',
      ],
    },
    cooldown: { ticks: 1440, scope: 'pair' },
  },

  false_accusation: {
    category: 'manipulation',
    visibility: 0.4,
    duration: 10,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'honesty', op: '<', value: 35, agent: 'initiator' },
      { type: 'relationship', field: 'familiarity', op: '>', value: 10, with_role: 'constable', agent: 'initiator' },
    ],
    effects_success: [
      { system: 'fact', type: 'false_accusation', sensitivity: 2, subject: 'initiator' },
      { system: 'goal', advance: 0.4 },
    ],
    effects_failure: [
      { system: 'fact', type: 'false_accusation', sensitivity: 1, subject: 'initiator' },
      { system: 'relationship', field: 'trust', delta: -30, target: 'both' },
    ],
    outcomeFactors: [
      { stat: 'honesty', weight: -0.3 },
      { stat: 'vanity', weight: 0.2 },
    ],
    narration: {
      strategy: 'always',
      token_budget: 80,
      prompt_tone: 'tense',
      templates: [
        "{initiator} accused {target} of a crime they didn't commit.",
        '{initiator} pointed the finger at {target}.',
      ],
    },
    cooldown: { ticks: 2880, scope: 'pair' },
  },

  eavesdrop: {
    category: 'manipulation',
    visibility: 0.15,
    duration: 10,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'curiosity', op: '>', value: 50, agent: 'initiator' },
      { type: 'state', state: 'in_conversation', agent: 'target' },
    ],
    effects_success: [
      { system: 'goal', advance: 0.3 },
    ],
    effects_failure: [
      { system: 'fact', type: 'eavesdropping', sensitivity: 2, subject: 'initiator' },
      { system: 'relationship', field: 'trust', delta: -15, target: 'target' },
    ],
    outcomeFactors: [
      { stat: 'curiosity', weight: 0.4 },
      { stat: 'state:drunk', weight: -0.2 },
    ],
    narration: {
      strategy: 'template_only',
      token_budget: 0,
      prompt_tone: 'neutral',
      templates: [
        '{initiator} listened in on a conversation.',
        '{initiator} overheard something at {location}.',
      ],
    },
    cooldown: { ticks: 720, scope: 'initiator' },
  },

  interrogate: {
    category: 'manipulation',
    visibility: 0.5,
    duration: 15,
    prerequisites: [
      { type: 'co_located' },
      { type: 'relationship_or_role', field: 'friendship', op: '>', value: 0, role: 'constable', agent: 'initiator' },
    ],
    effects_success: [
      { system: 'relationship', field: 'friendship', delta: -5, target: 'both' },
      { system: 'goal', advance: 0.4 },
    ],
    effects_failure: [
      { system: 'relationship', field: 'friendship', delta: -10, target: 'both' },
      { system: 'relationship', field: 'trust', delta: -10, target: 'target' },
    ],
    outcomeFactors: [
      { stat: 'aggression', weight: 0.3 },
      { stat: 'curiosity', weight: 0.2 },
    ],
    narration: {
      strategy: 'if_severity',
      severity_threshold: 0.5,
      token_budget: 60,
      prompt_tone: 'tense',
      templates: [
        '{initiator} pressed {target} for answers.',
        '{initiator} questioned {target} at {location}.',
      ],
    },
    cooldown: { ticks: 720, scope: 'pair' },
  },

  // ─── CAREGIVING ────────────────────────────────────────────────────────────

  comfort: {
    category: 'caregiving',
    visibility: 0.4,
    duration: 15,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'warmth', op: '>', value: 40, agent: 'initiator' },
      { type: 'state', state_any: ['grieving', 'heartbroken', 'lonely', 'depressed'], agent: 'target' },
    ],
    effects_success: [
      { system: 'needs', field: 'mood', delta: 15, target: 'target' },
      { system: 'needs', field: 'stress', delta: -10, target: 'target' },
      { system: 'relationship', field: 'friendship', delta: 10, target: 'both' },
      { system: 'relationship', field: 'trust', delta: 5, target: 'both' },
      { system: 'goal', advance: 0.3 },
    ],
    effects_failure: [
      { system: 'needs', field: 'mood', delta: 5, target: 'target' },
    ],
    outcomeFactors: [
      { stat: 'warmth', weight: 0.4 },
      { stat: 'loyalty', weight: 0.2 },
    ],
    narration: {
      strategy: 'if_severity',
      severity_threshold: 0.4,
      token_budget: 60,
      prompt_tone: 'warm',
      templates: [
        '{initiator} comforted {target}.',
        '{initiator} sat with {target} and listened.',
      ],
    },
    cooldown: { ticks: 480, scope: 'pair' },
  },

  nurse: {
    category: 'caregiving',
    visibility: 0.3,
    duration: 20,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'warmth', op: '>', value: 30, agent: 'initiator' },
      { type: 'state', state: 'sick', agent: 'target' },
    ],
    effects_success: [
      { system: 'relationship', field: 'friendship', delta: 10, target: 'both' },
      { system: 'relationship', field: 'trust', delta: 10, target: 'both' },
      { system: 'goal', advance: 0.4 },
    ],
    effects_failure: [
      { system: 'needs', field: 'energy', delta: -5, target: 'initiator' },
    ],
    outcomeFactors: [
      { stat: 'warmth', weight: 0.3 },
      { stat: 'morality', weight: 0.2 },
    ],
    narration: {
      strategy: 'template_only',
      token_budget: 0,
      prompt_tone: 'warm',
      templates: [
        "{initiator} tended to {target}'s illness.",
        '{initiator} looked after sick {target}.',
      ],
    },
    cooldown: { ticks: 720, scope: 'pair' },
  },

  lend_money: {
    category: 'caregiving',
    visibility: 0.2,
    duration: 5,
    prerequisites: [
      { type: 'co_located' },
      { type: 'personality', field: 'loyalty', op: '>', value: 50, agent: 'initiator' },
      { type: 'state', state: 'in_debt', agent: 'target' },
      { type: 'economy', field: 'money', op: '>', value: 20, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'economy', transfer: 'initiator_to_target', amount: 'min(20, initiator.money * 0.3)' },
      { system: 'relationship', field: 'trust', delta: 20, target: 'both' },
      { system: 'fact', type: 'lending', sensitivity: 2, subject: 'initiator' },
      { system: 'goal', advance: 0.5 },
    ],
    effects_failure: [],
    outcomeFactors: [
      { stat: 'loyalty', weight: 0.4 },
      { stat: 'warmth', weight: 0.2 },
    ],
    narration: {
      strategy: 'template_only',
      token_budget: 0,
      prompt_tone: 'warm',
      templates: [
        '{initiator} lent money to {target}.',
        '{initiator} quietly helped {target} with their debt.',
      ],
    },
    cooldown: { ticks: 1440, scope: 'pair' },
  },

  // ─── SABOTAGE ──────────────────────────────────────────────────────────────

  workplace_sabotage: {
    category: 'sabotage',
    visibility: 0.15,
    duration: 15,
    prerequisites: [
      { type: 'personality', field: 'morality', op: '<', value: 40, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'economy', field: 'money', delta: -20, target: 'target' },
      { system: 'fact', type: 'sabotage', sensitivity: 3, subject: 'initiator' },
      { system: 'goal', advance: 0.6 },
    ],
    effects_failure: [
      { system: 'fact', type: 'sabotage', sensitivity: 2, subject: 'initiator' },
    ],
    outcomeFactors: [
      { stat: 'aggression', weight: 0.2 },
      { stat: 'impulsiveness', weight: 0.2 },
      { stat: 'curiosity', weight: 0.2 },
    ],
    narration: {
      strategy: 'if_witnessed',
      token_budget: 60,
      prompt_tone: 'tense',
      templates: [
        "{initiator} sabotaged {target}'s workplace.",
        "{initiator} tampered with things at {target}'s job.",
      ],
    },
    cooldown: { ticks: 2880, scope: 'pair' },
  },

  frame: {
    category: 'sabotage',
    visibility: 0.1,
    duration: 15,
    prerequisites: [
      { type: 'personality', field: 'morality', op: '<', value: 30, agent: 'initiator' },
      { type: 'knows_fact', filter: { type: 'crime' }, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'fact', type: 'false_accusation', sensitivity: 3, subject: 'initiator' },
      { system: 'goal', advance: 0.8 },
    ],
    effects_failure: [
      { system: 'fact', type: 'false_accusation', sensitivity: 2, subject: 'initiator' },
    ],
    outcomeFactors: [
      { stat: 'honesty', weight: -0.4 },
      { stat: 'curiosity', weight: 0.2 },
    ],
    narration: {
      strategy: 'always',
      token_budget: 80,
      prompt_tone: 'tense',
      templates: [
        '{initiator} planted evidence to frame {target}.',
        '{initiator} set {target} up to take the fall.',
      ],
    },
    cooldown: { ticks: 4320, scope: 'pair' },
  },

  // ─── SUBSTANCE ─────────────────────────────────────────────────────────────

  buy_drinks: {
    category: 'substance',
    visibility: 0.7,
    duration: 10,
    prerequisites: [
      { type: 'location_type', value: 'tavern' },
      { type: 'economy', field: 'money', op: '>', value: 10, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'state', type: 'drunk', target: 'target' },
      { system: 'relationship', field: 'friendship', delta: 5, target: 'both' },
      { system: 'needs', field: 'fun', delta: 10, target: 'both' },
      { system: 'economy', field: 'money', delta: -5, target: 'initiator' },
      { system: 'goal', advance: 0.2 },
    ],
    effects_failure: [],
    outcomeFactors: [
      { stat: 'warmth', weight: 0.3 },
      { stat: 'impulsiveness', weight: 0.2 },
    ],
    narration: {
      strategy: 'template_only',
      token_budget: 0,
      prompt_tone: 'neutral',
      templates: [
        '{initiator} bought {target} a drink at {location}.',
        '{initiator} slid a drink across the bar to {target}.',
      ],
    },
    cooldown: { ticks: 720, scope: 'initiator' },
  },

  // ─── AUTHORITY ─────────────────────────────────────────────────────────────

  arrest: {
    category: 'authority',
    visibility: 0.9,
    duration: 20,
    prerequisites: [
      { type: 'agent_role', role: 'constable', agent: 'initiator' },
      { type: 'knows_fact', filter: { category: 'crime' }, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'state', type: 'arrested', target: 'target' },
      { system: 'fact', type: 'arrest', sensitivity: 1, subject: 'target' },
      { system: 'goal', advance: 0.5 },
    ],
    effects_failure: [
      { system: 'relationship', field: 'trust', delta: -15, target: 'target' },
      { system: 'state', type: 'angry', target: 'target' },
    ],
    outcomeFactors: [
      { stat: 'aggression', weight: 0.3 },
      { stat: 'morality', weight: 0.3 },
    ],
    narration: {
      strategy: 'always',
      token_budget: 80,
      prompt_tone: 'tense',
      templates: [
        '{initiator} arrested {target}.',
        '{initiator} slapped cuffs on {target} at {location}.',
      ],
    },
    cooldown: { ticks: 0, scope: 'pair' },
  },

  fine: {
    category: 'authority',
    visibility: 0.6,
    duration: 10,
    prerequisites: [
      { type: 'agent_role', role: 'constable_or_mayor', agent: 'initiator' },
      { type: 'knows_fact', filter: { category: 'infraction' }, agent: 'initiator' },
    ],
    effects_success: [
      { system: 'economy', field: 'money', delta: -15, target: 'target' },
      { system: 'relationship', field: 'trust', delta: -10, target: 'target' },
      { system: 'fact', type: 'fine', sensitivity: 1, subject: 'target' },
    ],
    effects_failure: [
      { system: 'relationship', field: 'trust', delta: -5, target: 'target' },
    ],
    outcomeFactors: [
      { stat: 'morality', weight: 0.3 },
      { stat: 'aggression', weight: 0.2 },
    ],
    narration: {
      strategy: 'template_only',
      token_budget: 0,
      prompt_tone: 'tense',
      templates: [
        '{initiator} fined {target}.',
        '{initiator} issued a penalty to {target}.',
      ],
    },
    cooldown: { ticks: 720, scope: 'pair' },
  },

};
