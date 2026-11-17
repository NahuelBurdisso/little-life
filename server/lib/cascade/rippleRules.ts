// server/lib/cascade/rippleRules.ts
import type { RippleRule } from './cascadeTypes';

export const rippleRules: RippleRule[] = [
  // ─── Romance Cascades ───────────────────────────────────────────────────────

  {
    id: 'affair_heartbreak',
    source: 'gossip:learned',
    // The fact's type is authoritative: the generated affair sentence ("are getting suspiciously
    // close") contains neither keyword, so matching content alone never fired for a real affair.
    // The keyword match stays for payloads that carry no type (godPowers, smallMisdeeds).
    sourceFilter: (payload) =>
      typeof payload?.factType === 'string'
        ? payload.factType === 'affair'
        : typeof payload?.content === 'string' &&
          (payload.content.includes('affair') || payload.content.includes('cheating')),
    target: 'self',
    probability: 0.9,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.1 }],
    cooldownMinutes: 480,
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
    cooldownMinutes: 240,
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
    probability: 0.4,
    personalityGates: [{ axis: 'aggression', direction: '+', weight: 0.25 }],
    cooldownMinutes: 240,
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
    cooldownMinutes: 240,
    effects: {
      createState: 'lonely',
    },
  },

  {
    id: 'infatuation_jealousy',
    source: 'perception:observed',
    // Perception emits `reaction.memory_template`; the jealousy reaction's key is
    // `perception_jealousy`. No key ever contained both 'crush' and 'rival', so
    // this rule could never fire.
    sourceFilter: (payload) => payload?.templateKey === 'perception_jealousy',
    target: 'self',
    probability: 0.6,
    personalityGates: [
      { axis: 'neuroticism', direction: '+', weight: 0.15 },
      { axis: 'loyalty', direction: '+', weight: 0.1 },
    ],
    cooldownMinutes: 300,
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
    probability: 0.35,
    personalityGates: [
      { axis: 'aggression', direction: '+', weight: 0.2 },
      { axis: 'impulsiveness', direction: '+', weight: 0.15 },
    ],
    cooldownMinutes: 240,
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
    cooldownMinutes: 240,
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
    cooldownMinutes: 120,
    effects: {
      createFact: 'theft',
    },
  },

  {
    id: 'theft_confrontation',
    source: 'economy:theft_caught',
    target: 'victim',
    probability: 0.5,
    personalityGates: [{ axis: 'aggression', direction: '+', weight: 0.2 }],
    cooldownMinutes: 240,
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
    cooldownMinutes: 480,
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
    cooldownMinutes: 480,
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
    cooldownMinutes: 120,
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
    cooldownMinutes: 240,
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
    cooldownMinutes: 480,
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
    cooldownMinutes: 120,
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
    cooldownMinutes: 480,
    effects: {
      createGoal: { type: 'steal_from' },
    },
  },

  {
    id: 'distress_begging',
    source: 'economy:distress',
    target: 'self',
    probability: 0.3,
    personalityGates: [
      { axis: 'vanity', direction: '-', weight: 0.2 },
      { axis: 'warmth', direction: '+', weight: 0.1 },
    ],
    cooldownMinutes: 240,
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
    cooldownMinutes: 240,
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
    cooldownMinutes: 240,
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
    cooldownMinutes: 480,
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
    cooldownMinutes: 240,
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
    cooldownMinutes: 120,
    effects: {
      createState: 'stressed',
      tensionDelta: 10,
    },
  },

  {
    id: 'insult_anger',
    source: 'interaction:completed',
    sourceFilter: (payload) => payload?.action === 'insult',
    // The insulted agent gets angry, not the one throwing the insult.
    target: 'victim',
    probability: 0.6,
    personalityGates: [
      { axis: 'aggression', direction: '+', weight: 0.1 },
      { axis: 'neuroticism', direction: '+', weight: 0.1 },
    ],
    cooldownMinutes: 120,
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
    probability: 0.25,
    personalityGates: [
      { axis: 'impulsiveness', direction: '+', weight: 0.2 },
      { axis: 'aggression', direction: '+', weight: 0.15 },
    ],
    cooldownMinutes: 240,
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
    probability: 0.8,
    personalityGates: [{ axis: 'loyalty', direction: '+', weight: 0.1 }],
    cooldownMinutes: 480,
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
    // Being publicly insulted is what humiliates — the aggressor isn't the one shamed.
    target: 'victim',
    probability: 0.7,
    personalityGates: [
      { axis: 'vanity', direction: '+', weight: 0.2 },
      { axis: 'neuroticism', direction: '+', weight: 0.1 },
    ],
    cooldownMinutes: 240,
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
    cooldownMinutes: 480,
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
    cooldownMinutes: 240,
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
    probability: 0.4,
    personalityGates: [{ axis: 'aggression', direction: '+', weight: 0.25 }],
    cooldownMinutes: 240,
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
    cooldownMinutes: 480,
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
    cooldownMinutes: 120,
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
    cooldownMinutes: 480,
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
    cooldownMinutes: 240,
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
    cooldownMinutes: 240,
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
    cooldownMinutes: 480,
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
    cooldownMinutes: 480,
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
    probability: 0.9,
    cooldownMinutes: 720,
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
    cooldownMinutes: 240,
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
    cooldownMinutes: 1440,
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
    cooldownMinutes: 360,
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
    cooldownMinutes: 720,
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
    cooldownMinutes: 240,
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
    cooldownMinutes: 720,
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
    cooldownMinutes: 480,
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
    cooldownMinutes: 1440,
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
    cooldownMinutes: 720,
    effects: {
      tensionDelta: 15,
    },
  },

  // ─── Positive / Reconciliation Cascades ──────────────────────────────────

  // Good conversation → friendship boost + tension relief
  {
    id: 'good_conversation_bonding',
    source: 'conversation:ended',
    sourceFilter: (payload) => typeof payload?.sentiment === 'number' && payload.sentiment > 0.4,
    target: 'self',
    probability: 0.5,
    personalityGates: [{ axis: 'warmth', direction: '+', weight: 0.15 }],
    cooldownMinutes: 120,
    effects: {
      relationshipDelta: { field: 'friendship', value: 5 },
      tensionDelta: -10,
    },
  },

  // Deep positive conversation → trust boost
  {
    id: 'deep_conversation_trust',
    source: 'conversation:ended',
    sourceFilter: (payload) => typeof payload?.sentiment === 'number' && payload.sentiment > 0.6,
    target: 'self',
    probability: 0.4,
    personalityGates: [{ axis: 'loyalty', direction: '+', weight: 0.1 }],
    cooldownMinutes: 240,
    effects: {
      relationshipDelta: { field: 'trust', value: 8 },
      tensionDelta: -5,
    },
  },

  // Time heals grudges → forgiveness after enough ticks without new conflict
  {
    id: 'grudge_forgiveness',
    source: 'conversation:ended',
    sourceFilter: (payload) => typeof payload?.sentiment === 'number' && payload.sentiment > 0.2,
    target: 'self',
    probability: 0.2,
    personalityGates: [
      { axis: 'warmth', direction: '+', weight: 0.2 },
      { axis: 'loyalty', direction: '+', weight: 0.1 },
    ],
    cooldownMinutes: 480,
    effects: {
      relationshipDelta: { field: 'trust', value: 5 },
      tensionDelta: -15,
    },
  },

  // Shared enemy bonding — agents who both dislike someone bond faster
  {
    id: 'shared_enemy_bond',
    source: 'conversation:ended',
    sourceFilter: (payload) =>
      typeof payload?.sentiment === 'number' &&
      payload.sentiment > 0.3 &&
      typeof payload?.topics === 'object' &&
      Array.isArray(payload.topics) &&
      payload.topics.some((t: string) => t.includes('gossip') || t.includes('complaint')),
    target: 'self',
    probability: 0.35,
    personalityGates: [{ axis: 'loyalty', direction: '+', weight: 0.15 }],
    cooldownMinutes: 240,
    effects: {
      relationshipDelta: { field: 'friendship', value: 8 },
    },
  },

  // Comfort a sad/lonely agent → friendship + mood boost for both
  {
    id: 'comfort_bonding',
    source: 'conversation:ended',
    sourceFilter: (payload) =>
      typeof payload?.sentiment === 'number' &&
      payload.sentiment > 0.2 &&
      typeof payload.partnerState === 'string' &&
      ['lonely', 'heartbroken', 'depressed', 'stressed', 'grieving'].includes(payload.partnerState),
    target: 'self',
    probability: 0.6,
    personalityGates: [{ axis: 'warmth', direction: '+', weight: 0.2 }],
    cooldownMinutes: 240,
    effects: {
      relationshipDelta: { field: 'friendship', value: 10 },
      moodDelta: 8,
      tensionDelta: -10,
    },
  },

  // Romantic spark — positive conversation between agents with some romance
  {
    id: 'romantic_spark',
    source: 'conversation:ended',
    sourceFilter: (payload) =>
      typeof payload?.sentiment === 'number' &&
      payload.sentiment > 0.5 &&
      typeof payload?.romanceLevel === 'number' &&
      payload.romanceLevel > 15,
    target: 'self',
    probability: 0.3,
    personalityGates: [{ axis: 'sensuality', direction: '+', weight: 0.2 }],
    cooldownMinutes: 360,
    effects: {
      relationshipDelta: { field: 'romance', value: 8 },
      createState: 'euphoric',
      tensionDelta: -5,
    },
  },

  // Public apology — after confrontation, warm agents may apologize (trust)
  {
    id: 'post_confrontation_apology',
    source: 'conversation:ended',
    sourceFilter: (payload) =>
      typeof payload?.sentiment === 'number' &&
      payload.sentiment > 0 &&
      payload?.hadRecentConflict === true,
    target: 'self',
    probability: 0.25,
    personalityGates: [
      { axis: 'warmth', direction: '+', weight: 0.2 },
      { axis: 'morality', direction: '+', weight: 0.1 },
    ],
    cooldownMinutes: 480,
    effects: {
      relationshipDelta: { field: 'trust', value: 12 },
      tensionDelta: -20,
    },
  },

  // Public apology — friendship recovery after conflict
  {
    id: 'post_confrontation_apology_friendship',
    source: 'conversation:ended',
    sourceFilter: (payload) =>
      typeof payload?.sentiment === 'number' &&
      payload.sentiment > 0 &&
      payload?.hadRecentConflict === true,
    target: 'self',
    probability: 0.25,
    personalityGates: [
      { axis: 'warmth', direction: '+', weight: 0.2 },
    ],
    cooldownMinutes: 480,
    effects: {
      relationshipDelta: { field: 'friendship', value: 8 },
    },
  },

  // Goal completion inspires nearby agents
  {
    id: 'goal_completion_inspires',
    source: 'goal:completed',
    target: 'random_present',
    probability: 0.3,
    personalityGates: [{ axis: 'curiosity', direction: '+', weight: 0.15 }],
    cooldownMinutes: 480,
    effects: {
      moodDelta: 5,
      tensionDelta: -5,
    },
  },

  // Revenge completed → target retaliates with their own revenge goal.
  // goal:completed carries the achiever as agentId/perpetrator and the goal's
  // target as victim (goals.ts goalEventCast), so the target is the `victim`
  // here and the revenge is aimed back at the `perpetrator`.
  {
    id: 'revenge_breeds_revenge',
    source: 'goal:completed',
    sourceFilter: (payload) => payload?.goalType === 'revenge',
    target: 'victim',
    probability: 0.5,
    personalityGates: [{ axis: 'aggression', direction: '+', weight: 0.2 }],
    cooldownMinutes: 720,
    effects: {
      createGoal: { type: 'revenge', targetAgent: 'perpetrator' },
      createState: 'angry',
      tensionDelta: 30,
    },
  },

  // Seduce completed → partner may become infatuated
  {
    id: 'seduce_success_infatuation',
    source: 'goal:completed',
    sourceFilter: (payload) => payload?.goalType === 'seduce',
    target: 'self',
    probability: 0.7,
    personalityGates: [{ axis: 'sensuality', direction: '+', weight: 0.15 }],
    cooldownMinutes: 720,
    effects: {
      createState: 'infatuated',
      moodDelta: 15,
      tensionDelta: -10,
    },
  },

  // Undermine completed → victim becomes stressed + may seek revenge
  // (same cast as revenge_breeds_revenge: the undermined target is the victim).
  {
    id: 'undermine_victim_retaliation',
    source: 'goal:completed',
    sourceFilter: (payload) => payload?.goalType === 'undermine',
    target: 'victim',
    probability: 0.4,
    personalityGates: [{ axis: 'aggression', direction: '+', weight: 0.15 }],
    cooldownMinutes: 720,
    effects: {
      createState: 'stressed',
      createGoal: { type: 'investigate', targetAgent: 'perpetrator' },
      tensionDelta: 20,
    },
  },

  // Protect completed → strong friendship bond
  {
    id: 'protect_gratitude',
    source: 'goal:completed',
    sourceFilter: (payload) => payload?.goalType === 'protect',
    target: 'self',
    probability: 0.8,
    cooldownMinutes: 480,
    effects: {
      relationshipDelta: { field: 'friendship', value: 15 },
      moodDelta: 10,
    },
  },

  // Protect completed → trust boost from gratitude
  {
    id: 'protect_gratitude_trust',
    source: 'goal:completed',
    sourceFilter: (payload) => payload?.goalType === 'protect',
    target: 'self',
    probability: 0.7,
    cooldownMinutes: 480,
    effects: {
      relationshipDelta: { field: 'trust', value: 10 },
    },
  },

  // Steal completed → guilt or confidence based on morality
  {
    id: 'theft_guilt',
    source: 'goal:completed',
    sourceFilter: (payload) => payload?.goalType === 'steal_from',
    target: 'self',
    probability: 0.4,
    personalityGates: [{ axis: 'morality', direction: '+', weight: 0.25 }],
    cooldownMinutes: 480,
    effects: {
      createState: 'stressed',
      tensionDelta: 20,
    },
  },

  // Flirting triggers jealousy in agents who have a crush on either party
  {
    id: 'flirt_triggers_jealousy',
    source: 'interaction:completed',
    sourceFilter: (payload) => payload?.action === 'flirt',
    target: 'witness',
    probability: 0.5,
    personalityGates: [
      { axis: 'neuroticism', direction: '+', weight: 0.2 },
      { axis: 'sensuality', direction: '+', weight: 0.1 },
    ],
    cooldownMinutes: 360,
    effects: {
      createState: 'jealous',
      tensionDelta: 15,
    },
  },

  // Successful theft without getting caught → confidence boost
  {
    id: 'theft_success_confidence',
    source: 'economy:theft_success',
    target: 'self',
    probability: 0.4,
    personalityGates: [{ axis: 'morality', direction: '-', weight: 0.15 }],
    cooldownMinutes: 480,
    effects: {
      createState: 'confident',
      tensionDelta: -5,
    },
  },

  // Helping a broke agent — warm conversation while they're in debt
  {
    id: 'generosity_bond',
    source: 'conversation:ended',
    sourceFilter: (payload) =>
      typeof payload?.sentiment === 'number' &&
      payload.sentiment > 0.3 &&
      payload?.partnerState === 'in_debt',
    target: 'self',
    probability: 0.5,
    personalityGates: [{ axis: 'warmth', direction: '+', weight: 0.2 }],
    cooldownMinutes: 480,
    effects: {
      relationshipDelta: { field: 'friendship', value: 15 },
      tensionDelta: -10,
    },
  },

  // ─── Gift & Social Cascade Rules ────────────────────────────────────────────

  {
    id: 'gift_jealousy_spiral',
    source: 'jealousy:triggered',
    target: 'self',
    probability: 0.4,
    personalityGates: [{ axis: 'neuroticism', direction: '+', weight: 0.3 }],
    cooldownMinutes: 480,
    effects: {
      tensionDelta: 20,
      emitEvent: 'need:critical',
      emitPayload: { action: 'socialize' },
    },
  },

  {
    id: 'confrontation_witness_gossip',
    source: 'confrontation:occurred',
    target: 'witness',
    probability: 0.6,
    personalityGates: [{ axis: 'curiosity', direction: '+', weight: 0.2 }],
    cooldownMinutes: 120,
    effects: {
      createFact: 'fight',
      tensionDelta: 5,
    },
  },

  {
    id: 'birthday_social_boost',
    source: 'agent:birthday',
    target: 'self',
    probability: 0.8,
    cooldownMinutes: 1440,
    effects: {
      tensionDelta: -15,
    },
  },

  {
    id: 'secret_trust_deepened',
    source: 'secret:shared',
    target: 'self',
    probability: 0.5,
    personalityGates: [{ axis: 'warmth', direction: '+', weight: 0.2 }],
    cooldownMinutes: 720,
    effects: {
      relationshipDelta: { field: 'trust', value: 8 },
      tensionDelta: -5,
    },
  },
];
