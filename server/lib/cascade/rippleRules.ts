// server/lib/cascade/rippleRules.ts
import type { RippleRule } from './cascadeTypes';

export const rippleRules: RippleRule[] = [
  // ─── Romance Cascades ───────────────────────────────────────────────────────

  {
    id: 'affair_heartbreak',
    source: 'gossip:learned',
    sourceFilter: (payload) =>
      typeof payload?.content === 'string' &&
      (payload.content.includes('affair') || payload.content.includes('cheating')),
    target: 'self',
    probability: 0.9,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.1 }],
    cooldownTicks: 480,
    effects: {
      createState: 'heartbroken',
      tensionDelta: 40,
    },
  },

  {
    id: 'heartbreak_drinking',
    source: 'state:triggered',
    sourceFilter: (payload) => payload?.state === 'heartbroken',
    target: 'self',
    probability: 0.5,
    personalityGates: [
      { axis: 'impulsiveness', direction: '+', weight: 0.2 },
      { axis: 'morality', direction: '-', weight: 0.1 },
    ],
    cooldownTicks: 240,
    effects: {
      createState: 'drunk',
      tensionDelta: 10,
    },
  },

  {
    id: 'heartbreak_confrontation',
    source: 'state:triggered',
    sourceFilter: (payload) => payload?.state === 'heartbroken',
    target: 'self',
    secondaryTarget: 'perpetrator',
    probability: 0.4,
    personalityGates: [{ axis: 'aggression', direction: '+', weight: 0.25 }],
    cooldownTicks: 240,
    effects: {
      emitEvent: 'interaction:completed',
      emitPayload: { action: 'confrontation' },
      createFact: 'grudge',
      tensionDelta: 15,
    },
  },

  {
    id: 'heartbreak_isolation',
    source: 'state:triggered',
    sourceFilter: (payload) => payload?.state === 'heartbroken',
    target: 'self',
    probability: 0.3,
    personalityGates: [
      { axis: 'warmth', direction: '-', weight: 0.15 },
      { axis: 'neuroticism', direction: '+', weight: 0.1 },
    ],
    cooldownTicks: 240,
    effects: {
      createState: 'lonely',
    },
  },

  {
    id: 'infatuation_jealousy',
    source: 'perception:observed',
    sourceFilter: (payload) =>
      typeof payload?.templateKey === 'string' &&
      payload.templateKey.includes('crush') &&
      payload.templateKey.includes('rival'),
    target: 'self',
    probability: 0.6,
    personalityGates: [
      { axis: 'neuroticism', direction: '+', weight: 0.15 },
      { axis: 'loyalty', direction: '+', weight: 0.1 },
    ],
    cooldownTicks: 300,
    effects: {
      createState: 'jealous',
      tensionDelta: 20,
    },
  },

  {
    id: 'jealousy_confrontation',
    source: 'state:triggered',
    sourceFilter: (payload) => payload?.state === 'jealous',
    target: 'self',
    secondaryTarget: 'random_present',
    probability: 0.35,
    personalityGates: [
      { axis: 'aggression', direction: '+', weight: 0.2 },
      { axis: 'impulsiveness', direction: '+', weight: 0.15 },
    ],
    cooldownTicks: 240,
    effects: {
      emitEvent: 'interaction:completed',
      emitPayload: { action: 'confrontation' },
      tensionDelta: 15,
    },
  },

  {
    id: 'jealousy_gossip',
    source: 'state:triggered',
    sourceFilter: (payload) => payload?.state === 'jealous',
    target: 'self',
    probability: 0.3,
    personalityGates: [
      { axis: 'honesty', direction: '-', weight: 0.2 },
      { axis: 'morality', direction: '-', weight: 0.1 },
    ],
    cooldownTicks: 240,
    effects: {
      createFact: 'rumor',
    },
  },

  // ─── Crime Cascades ──────────────────────────────────────────────────────────

  {
    id: 'theft_witness_report',
    source: 'economy:theft_caught',
    target: 'witness',
    probability: 0.7,
    personalityGates: [{ axis: 'morality', direction: '+', weight: 0.15 }],
    cooldownTicks: 120,
    effects: {
      createFact: 'theft',
    },
  },

  {
    id: 'theft_confrontation',
    source: 'economy:theft_caught',
    target: 'victim',
    secondaryTarget: 'perpetrator',
    probability: 0.5,
    personalityGates: [{ axis: 'aggression', direction: '+', weight: 0.2 }],
    cooldownTicks: 240,
    effects: {
      emitEvent: 'interaction:completed',
      emitPayload: { action: 'confrontation' },
      tensionDelta: 25,
      relationshipDelta: { field: 'trust', value: -20 },
    },
  },

  {
    id: 'theft_revenge',
    source: 'economy:theft_caught',
    target: 'victim',
    probability: 0.3,
    personalityGates: [
      { axis: 'aggression', direction: '+', weight: 0.2 },
      { axis: 'loyalty', direction: '-', weight: 0.1 },
    ],
    cooldownTicks: 480,
    effects: {
      createGoal: { type: 'revenge', targetAgent: 'perpetrator' },
      tensionDelta: 15,
    },
  },

  {
    id: 'arrest_shame',
    source: 'crime:arrested',
    target: 'self',
    probability: 0.8,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.1 }],
    cooldownTicks: 480,
    effects: {
      createState: 'stressed',
      createFact: 'arrest',
      tensionDelta: 30,
    },
  },

  {
    id: 'arrest_gossip',
    source: 'crime:arrested',
    target: 'witness',
    probability: 0.9,
    personalityGates: [{ axis: 'curiosity', direction: '+', weight: 0.1 }],
    cooldownTicks: 120,
    effects: {
      createFact: 'arrest',
    },
  },

  {
    id: 'blackmail_stress',
    source: 'economy:blackmail_paid',
    target: 'self',
    probability: 0.7,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.15 }],
    cooldownTicks: 240,
    effects: {
      createState: 'stressed',
      tensionDelta: 25,
    },
  },

  {
    id: 'blackmail_desperation',
    source: 'economy:blackmail_paid',
    target: 'self',
    probability: 0.2,
    personalityGates: [
      { axis: 'morality', direction: '-', weight: 0.2 },
      { axis: 'impulsiveness', direction: '+', weight: 0.1 },
    ],
    cooldownTicks: 480,
    requires: { moneyBelow: 20 },
    effects: {
      createGoal: { type: 'steal_from' },
    },
  },

  // ─── Economic Cascades ───────────────────────────────────────────────────────

  {
    id: 'distress_stress',
    source: 'economy:distress',
    target: 'self',
    probability: 0.8,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.1 }],
    cooldownTicks: 120,
    effects: {
      createState: 'stressed',
      tensionDelta: 20,
    },
  },

  {
    id: 'distress_theft',
    source: 'economy:distress',
    target: 'self',
    probability: 0.15,
    personalityGates: [
      { axis: 'morality', direction: '-', weight: 0.25 },
      { axis: 'impulsiveness', direction: '+', weight: 0.1 },
    ],
    cooldownTicks: 480,
    effects: {
      createGoal: { type: 'steal_from' },
    },
  },

  {
    id: 'distress_begging',
    source: 'economy:distress',
    target: 'self',
    secondaryTarget: 'random_present',
    probability: 0.3,
    personalityGates: [
      { axis: 'vanity', direction: '-', weight: 0.2 },
      { axis: 'warmth', direction: '+', weight: 0.1 },
    ],
    cooldownTicks: 240,
    effects: {
      emitEvent: 'interaction:completed',
      emitPayload: { action: 'begging' },
    },
  },

  {
    id: 'distress_gambling',
    source: 'economy:distress',
    target: 'self',
    probability: 0.2,
    personalityGates: [{ axis: 'impulsiveness', direction: '+', weight: 0.2 }],
    cooldownTicks: 240,
    effects: {
      emitEvent: 'interaction:completed',
      emitPayload: { action: 'gambling' },
    },
  },

  {
    id: 'gambling_loss_drinking',
    source: 'economy:gambling',
    sourceFilter: (payload) => payload?.won === false,
    target: 'self',
    probability: 0.4,
    personalityGates: [{ axis: 'impulsiveness', direction: '+', weight: 0.15 }],
    cooldownTicks: 240,
    effects: {
      createState: 'drunk',
      tensionDelta: 15,
    },
  },

  {
    id: 'gambling_loss_debt',
    source: 'economy:gambling',
    sourceFilter: (payload) => payload?.won === false,
    target: 'self',
    probability: 0.9,
    cooldownTicks: 480,
    effects: {
      createState: 'in_debt',
      tensionDelta: 20,
    },
  },

  // ─── Social Cascades ─────────────────────────────────────────────────────────

  {
    id: 'argument_grudge',
    source: 'conversation:ended',
    sourceFilter: (payload) => typeof payload?.sentiment === 'number' && payload.sentiment < -0.5,
    target: 'self',
    probability: 0.3,
    personalityGates: [
      { axis: 'loyalty', direction: '-', weight: 0.15 },
      { axis: 'aggression', direction: '+', weight: 0.1 },
    ],
    cooldownTicks: 240,
    effects: {
      relationshipDelta: { field: 'trust', value: -10 },
      createFact: 'grudge',
      tensionDelta: 15,
    },
  },

  {
    id: 'argument_stress',
    source: 'conversation:ended',
    sourceFilter: (payload) => typeof payload?.sentiment === 'number' && payload.sentiment < -0.5,
    target: 'self',
    probability: 0.4,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.15 }],
    cooldownTicks: 120,
    effects: {
      createState: 'stressed',
      tensionDelta: 10,
    },
  },

  {
    id: 'insult_anger',
    source: 'interaction:completed',
    sourceFilter: (payload) => payload?.action === 'insult',
    target: 'self',
    probability: 0.6,
    personalityGates: [
      { axis: 'aggression', direction: '+', weight: 0.1 },
      { axis: 'neuroticism', direction: '+', weight: 0.1 },
    ],
    cooldownTicks: 120,
    effects: {
      createState: 'angry',
      tensionDelta: 20,
    },
  },

  {
    id: 'anger_lash_out',
    source: 'state:triggered',
    sourceFilter: (payload) => payload?.state === 'angry',
    target: 'self',
    secondaryTarget: 'random_present',
    probability: 0.25,
    personalityGates: [
      { axis: 'impulsiveness', direction: '+', weight: 0.2 },
      { axis: 'aggression', direction: '+', weight: 0.15 },
    ],
    cooldownTicks: 240,
    requires: {
      notState: 'euphoric',
      coLocatedWith: 'any_agent',
    },
    effects: {
      emitEvent: 'interaction:completed',
      emitPayload: { action: 'confrontation' },
    },
  },

  {
    id: 'betrayal_trust_collapse',
    source: 'gossip:learned',
    sourceFilter: (payload) =>
      typeof payload?.content === 'string' && payload.content.includes('secret'),
    target: 'self',
    secondaryTarget: 'perpetrator',
    probability: 0.8,
    personalityGates: [{ axis: 'loyalty', direction: '+', weight: 0.1 }],
    cooldownTicks: 480,
    effects: {
      relationshipDelta: { field: 'trust', value: -30 },
      createFact: 'grudge',
      tensionDelta: 30,
    },
  },

  {
    id: 'public_humiliation',
    source: 'interaction:completed',
    sourceFilter: (payload) => payload?.action === 'insult',
    target: 'self',
    probability: 0.7,
    personalityGates: [
      { axis: 'vanity', direction: '+', weight: 0.2 },
      { axis: 'neuroticism', direction: '+', weight: 0.1 },
    ],
    cooldownTicks: 240,
    effects: {
      createState: 'stressed',
      tensionDelta: 25,
    },
  },

  {
    id: 'shunning_depression',
    source: 'relationship:changed',
    target: 'self',
    probability: 0.3,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.2 }],
    cooldownTicks: 480,
    requires: { needBelow: { need: 'social', value: 30 } },
    effects: {
      createState: 'depressed',
      tensionDelta: 20,
    },
  },

  // ─── Health Cascades ─────────────────────────────────────────────────────────

  {
    id: 'drunk_incident',
    source: 'state:triggered',
    sourceFilter: (payload) => payload?.state === 'drunk',
    target: 'self',
    probability: 0.3,
    personalityGates: [{ axis: 'impulsiveness', direction: '+', weight: 0.2 }],
    cooldownTicks: 240,
    effects: {
      emitEvent: 'interaction:completed',
      emitPayload: { action: 'drunk_misbehavior' },
      createFact: 'drunk_incident',
    },
  },

  {
    id: 'drunk_fight',
    source: 'state:triggered',
    sourceFilter: (payload) => payload?.state === 'drunk',
    target: 'self',
    secondaryTarget: 'perpetrator',
    probability: 0.4,
    personalityGates: [{ axis: 'aggression', direction: '+', weight: 0.25 }],
    cooldownTicks: 240,
    requires: { coLocatedWith: 'perpetrator' },
    effects: {
      emitEvent: 'interaction:completed',
      emitPayload: { action: 'confrontation' },
      tensionDelta: 15,
    },
  },

  {
    id: 'hangover_missed_work',
    source: 'state:triggered',
    sourceFilter: (payload) => payload?.state === 'hungover',
    target: 'self',
    probability: 0.6,
    cooldownTicks: 480,
    effects: {
      economyEffect: { field: 'work_performance', delta: -15 },
    },
  },

  {
    id: 'sick_contagion',
    source: 'state:triggered',
    sourceFilter: (payload) => payload?.state === 'sick',
    target: 'random_present',
    probability: 0.15,
    cooldownTicks: 120,
    requires: { coLocatedWith: 'any_agent' },
    effects: {
      createState: 'sick',
    },
  },

  // ─── Goal-Driven Cascades ────────────────────────────────────────────────────

  {
    id: 'revenge_escalation',
    source: 'goal:abandoned',
    sourceFilter: (payload) =>
      typeof payload?.goalType === 'string' && payload.goalType.includes('revenge'),
    target: 'self',
    probability: 0.6,
    personalityGates: [{ axis: 'aggression', direction: '+', weight: 0.2 }],
    cooldownTicks: 480,
    effects: {
      createState: 'angry',
      tensionDelta: 25,
    },
  },

  {
    id: 'goal_failure_drinking',
    source: 'goal:abandoned',
    target: 'self',
    probability: 0.2,
    personalityGates: [
      { axis: 'impulsiveness', direction: '+', weight: 0.15 },
      { axis: 'neuroticism', direction: '+', weight: 0.1 },
    ],
    cooldownTicks: 240,
    effects: {
      createState: 'drunk',
      tensionDelta: 15,
    },
  },

  {
    id: 'goal_completed_euphoria',
    source: 'goal:completed',
    target: 'self',
    probability: 0.4,
    cooldownTicks: 240,
    effects: {
      createState: 'euphoric',
      tensionDelta: -20,
    },
  },

  {
    id: 'ambition_shift_crisis',
    source: 'goal:ambition_shifted',
    target: 'self',
    probability: 0.3,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.15 }],
    cooldownTicks: 480,
    effects: {
      createState: 'stressed',
      tensionDelta: 15,
    },
  },

  // ─── Tier 3 Drama Cascades ───────────────────────────────────────────────────

  // Speech from podium — witnesses get mood bump + opinion drift
  {
    id: 'speech_crowd_mood',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('speech'),
    target: 'witness',
    probability: 0.6,
    cooldownTicks: 480,
    effects: {
      moodDelta: 5,
      relationshipDelta: { field: 'trust', value: 3 },
    },
  },

  // Protest — authority relationships damaged, political fact spread
  {
    id: 'protest_authority_damage',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('protest'),
    target: 'self',
    secondaryTarget: 'perpetrator',
    probability: 0.9,
    cooldownTicks: 720,
    effects: {
      relationshipDelta: { field: 'trust', value: -8 },
      createFact: 'political_dissent',
      tensionDelta: 20,
    },
  },

  // Protest — witnesses become agitated
  {
    id: 'protest_witness_stress',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('protest'),
    target: 'witness',
    probability: 0.35,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.15 }],
    cooldownTicks: 240,
    effects: {
      createState: 'stressed',
      tensionDelta: 10,
    },
  },

  // Escape attempt (succeeded or not) — constables hear about it, grudge forms
  {
    id: 'escape_authority_grudge',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('escape'),
    target: 'self',
    probability: 0.9,
    cooldownTicks: 1440,
    effects: {
      createFact: 'escape',
      tensionDelta: 25,
      relationshipDelta: { field: 'trust', value: -15 },
    },
  },

  // Scheme — initiator gains tension, fact leaks faintly
  {
    id: 'scheme_tension',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('scheme'),
    target: 'self',
    probability: 0.8,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.1 }],
    cooldownTicks: 360,
    effects: {
      createFact: 'conspiracy',
      tensionDelta: 15,
    },
  },

  // Secret meeting — trust spike between parties, faint rumor
  {
    id: 'secret_meeting_bond',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('secret_meeting'),
    target: 'self',
    probability: 0.6,
    cooldownTicks: 720,
    effects: {
      relationshipDelta: { field: 'trust', value: 8 },
      createFact: 'conspiracy',
    },
  },

  // Confide — trust spike, possible leak to witness
  {
    id: 'confide_trust_gain',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('confide'),
    target: 'self',
    probability: 0.85,
    cooldownTicks: 240,
    effects: {
      relationshipDelta: { field: 'trust', value: 12 },
    },
  },

  // Announce — rumor propagates, vanity boost for announcer
  {
    id: 'announce_rumor_spread',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('announce'),
    target: 'self',
    probability: 0.9,
    cooldownTicks: 720,
    effects: {
      createFact: 'rumor',
      moodDelta: 5,
    },
  },

  // Smuggle — bond between parties, contraband fact spreads
  {
    id: 'smuggle_bond',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('smuggle'),
    target: 'self',
    probability: 0.8,
    cooldownTicks: 480,
    effects: {
      relationshipDelta: { field: 'friendship', value: 5 },
      createFact: 'contraband',
    },
  },

  // Lock out — target becomes homeless_temp, grudge forms
  {
    id: 'lock_out_grudge',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('lock_out'),
    target: 'victim',
    probability: 0.9,
    cooldownTicks: 1440,
    effects: {
      createState: 'stressed',
      createFact: 'grudge',
      tensionDelta: 30,
      relationshipDelta: { field: 'trust', value: -25 },
    },
  },

  // Lock out — initiator gains anger-driven tension
  {
    id: 'lock_out_initiator_stress',
    source: 'interaction:completed',
    sourceFilter: (payload) =>
      typeof payload?.action === 'string' && payload.action.includes('lock_out'),
    target: 'self',
    probability: 0.4,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.15 }],
    cooldownTicks: 720,
    effects: {
      tensionDelta: 15,
    },
  },
];
