import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ─── 11. locations (defined first for foreign key references) ────────────────

export const locations = sqliteTable('locations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  position: text('position', { mode: 'json' })
    .notNull()
    .$type<{ x: number; y: number; width: number; height: number }>(),
  entry_point: text('entry_point', { mode: 'json' })
    .notNull()
    .$type<{ x: number; y: number }>(),
  owner: integer('owner'),
  capacity: integer('capacity').notNull(),
  current_occupants: text('current_occupants', { mode: 'json' })
    .notNull()
    .$type<number[]>(),
  operating_hours: text('operating_hours', { mode: 'json' }).$type<{
    open: number;
    close: number;
  } | null>(),
  services: text('services', { mode: 'json' })
    .notNull()
    .$type<
      {
        needSatisfied: string;
        amount: number;
        cost: number;
        itemRequired: string | null;
      }[]
    >(),
  description: text('description').notNull(),
});

// ─── 1. agents ───────────────────────────────────────────────────────────────

export const agents = sqliteTable(
  'agents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    bio: text('bio').notNull(),
    traits: text('traits', { mode: 'json' }).notNull().$type<string[]>(),
    personality: text('personality', { mode: 'json' }).$type<import('../lib/personality').PersonalityProfile | null>(),
    age: integer('age').notNull(),
    gender: text('gender').notNull(),
    sprite_sheet: text('sprite_sheet').notNull(),
    portrait_sprite: text('portrait_sprite').notNull(),
    position: text('position', { mode: 'json' })
      .notNull()
      .$type<{ x: number; y: number }>(),
    current_destination: text('current_destination', { mode: 'json' }).$type<{
      x: number;
      y: number;
      locationId?: number;
    } | null>(),
    current_location: integer('current_location').references(() => locations.id),
    current_action: text('current_action', { mode: 'json' }).notNull().$type<Record<string, any>>(),
    action_started: integer('action_started').notNull(),
    action_duration: integer('action_duration'),
    action_queue: text('action_queue', { mode: 'json' })
      .notNull()
      .$type<Record<string, any>[]>(),
    current_path: text('current_path', { mode: 'json' }).$type<number[][] | null>(),
    schedule: text('schedule', { mode: 'json' })
      .notNull()
      .$type<{
        wakeTime: number;
        sleepTime: number;
        workStart: number;
        workEnd: number;
        lunchTime: number;
        freeTimePreferences: string[];
      }>(),
    daily_plan: text('daily_plan', { mode: 'json' }).default(null).$type<Record<string, unknown> | null>(),
    self_description: text('self_description'),
    home: integer('home').notNull().references(() => locations.id),
    workplace: integer('workplace').references(() => locations.id),
    created_at: integer('created_at').notNull(),
    is_active: integer('is_active', { mode: 'boolean' }).notNull(),
  },
  (table) => [index('idx_agents_is_active').on(table.is_active)]
);

// ─── 2. needs ─────────────────────────────────────────────────────────────────

export const needs = sqliteTable(
  'needs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent_id: integer('agent_id').notNull().references(() => agents.id),
    hunger: real('hunger').notNull(),
    energy: real('energy').notNull(),
    social: real('social').notNull(),
    comfort: real('comfort').notNull(),
    fun: real('fun').notNull(),
    mood: real('mood').notNull(),
    stress: real('stress').notNull(),
    decay_rates: text('decay_rates', { mode: 'json' })
      .notNull()
      .$type<{
        hunger: number;
        energy: number;
        social: number;
        comfort: number;
        fun: number;
      }>(),
    thresholds: text('thresholds', { mode: 'json' })
      .notNull()
      .$type<{
        critical: number;
        low: number;
        satisfied: number;
      }>(),
    mood_modifiers: text('mood_modifiers', { mode: 'json' })
      .notNull()
      .$type<{ source: string; value: number; expiresAt: number }[]>(),
    last_updated: integer('last_updated').notNull(),
  },
  (table) => [uniqueIndex('idx_needs_agent_id').on(table.agent_id)]
);

// ─── 3. economy ───────────────────────────────────────────────────────────────

export const economy = sqliteTable(
  'economy',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent_id: integer('agent_id').notNull().references(() => agents.id),
    job: text('job').notNull(),
    job_title: text('job_title').notNull(),
    salary: real('salary').notNull(),
    work_performance: real('work_performance').notNull(),
    money: real('money').notNull(),
    daily_expenses: real('daily_expenses').notNull(),
    inventory: text('inventory', { mode: 'json' })
      .notNull()
      .$type<{ itemId: string; quantity: number; acquiredAt: number }[]>(),
    last_payday: integer('last_payday').notNull(),
    production_remainder: real('production_remainder').notNull(),
  },
  (table) => [uniqueIndex('idx_economy_agent_id').on(table.agent_id)]
);

// ─── 4. economyTransactions ───────────────────────────────────────────────────

export const economyTransactions = sqliteTable(
  'economy_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    from_agent: integer('from_agent'),
    to_agent: integer('to_agent'),
    amount: real('amount').notNull(),
    reason: text('reason').notNull(),
    items_exchanged: text('items_exchanged', { mode: 'json' }).$type<
      { itemId: string; quantity: number }[] | null
    >(),
    location_id: integer('location_id').references(() => locations.id),
    timestamp: integer('timestamp').notNull(),
  },
  (table) => [
    index('idx_economy_transactions_timestamp').on(table.timestamp),
    index('idx_economy_transactions_to_agent').on(table.to_agent),
  ]
);

// ─── 5. relationships ─────────────────────────────────────────────────────────

export const relationships = sqliteTable(
  'relationships',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent_a: integer('agent_a').notNull().references(() => agents.id),
    agent_b: integer('agent_b').notNull().references(() => agents.id),
    friendship_ab: real('friendship_ab').notNull(),
    friendship_ba: real('friendship_ba').notNull(),
    romance_ab: real('romance_ab').notNull(),
    romance_ba: real('romance_ba').notNull(),
    trust_ab: real('trust_ab').notNull(),
    trust_ba: real('trust_ba').notNull(),
    familiarity: real('familiarity').notNull(),
    interaction_count: integer('interaction_count').notNull(),
    last_interaction: integer('last_interaction').notNull(),
    average_interaction_sentiment: real('average_interaction_sentiment').notNull(),
    tags: text('tags', { mode: 'json' }).notNull().$type<string[]>(),
    status: text('status').notNull(),
    created_at: integer('created_at').notNull(),
    last_updated: integer('last_updated').notNull(),
  },
  (table) => [
    index('idx_relationships_agent_a').on(table.agent_a),
    index('idx_relationships_agent_b').on(table.agent_b),
    uniqueIndex('idx_relationships_pair').on(table.agent_a, table.agent_b),
  ]
);

// ─── 6. relationshipEvents ────────────────────────────────────────────────────

export const relationshipEvents = sqliteTable(
  'relationship_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent_a: integer('agent_a').notNull().references(() => agents.id),
    agent_b: integer('agent_b').notNull().references(() => agents.id),
    event_type: text('event_type').notNull(),
    description: text('description').notNull(),
    friendship_delta_ab: real('friendship_delta_ab').notNull(),
    friendship_delta_ba: real('friendship_delta_ba').notNull(),
    romance_delta_ab: real('romance_delta_ab').notNull(),
    romance_delta_ba: real('romance_delta_ba').notNull(),
    trust_delta_ab: real('trust_delta_ab').notNull(),
    trust_delta_ba: real('trust_delta_ba').notNull(),
    sentiment: real('sentiment').notNull(),
    processed: integer('processed', { mode: 'boolean' }).notNull(),
    timestamp: integer('timestamp').notNull(),
  },
  (table) => [index('idx_relationship_events_processed').on(table.processed)]
);

// ─── 7. conversations ─────────────────────────────────────────────────────────

export const conversations = sqliteTable(
  'conversations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    participants: text('participants', { mode: 'json' })
      .notNull()
      .$type<number[]>(),
    messages: text('messages', { mode: 'json' })
      .notNull()
      .$type<Record<string, any>[]>(),
    location: integer('location').references(() => locations.id),
    trigger_reason: text('trigger_reason').notNull(),
    topic: text('topic'),
    status: text('status').notNull(),
    started_at: integer('started_at').notNull(),
    ended_at: integer('ended_at'),
    sentiment: real('sentiment').notNull(),
    max_turns: integer('max_turns').notNull(),
  },
  (table) => [index('idx_conversations_status').on(table.status)]
);

// ─── 8. conversationQueue ─────────────────────────────────────────────────────

export const conversationQueue = sqliteTable(
  'conversation_queue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    participants: text('participants', { mode: 'json' })
      .notNull()
      .$type<number[]>(),
    tier: text('tier').notNull(),
    priority: integer('priority').notNull(),
    trigger_reason: text('trigger_reason').notNull(),
    topic: text('topic'),
    queued_at: integer('queued_at').notNull(),
    max_wait: integer('max_wait').notNull(),
  },
  (table) => [index('idx_conversation_queue_priority').on(table.priority)]
);

// ─── 9. conversationSchedulerState ───────────────────────────────────────────

export const conversationSchedulerState = sqliteTable(
  'conversation_scheduler_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    active_llm_conversations: text('active_llm_conversations', { mode: 'json' })
      .notNull()
      .$type<Record<string, any>[]>(),
    max_concurrent_llm: integer('max_concurrent_llm').notNull(),
    max_queue_size: integer('max_queue_size').notNull(),
    max_turns_deep: integer('max_turns_deep').notNull(),
    max_turns_standard: integer('max_turns_standard').notNull(),
    template_fallback_after_ms: integer('template_fallback_after_ms').notNull(),
    stats: text('stats', { mode: 'json' })
      .notNull()
      .$type<{
        llmConversationsTotal: number;
        templateConversationsTotal: number;
        averageResponseTimeMs: number;
        queueTimeoutsTotal: number;
      }>(),
  }
);

// ─── 10. memories ─────────────────────────────────────────────────────────────

export const memories = sqliteTable(
  'memories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent_id: integer('agent_id').notNull().references(() => agents.id),
    type: text('type').notNull(),
    description: text('description').notNull(),
    importance: real('importance').notNull(),
    emotional_valence: real('emotional_valence').notNull().default(0),
    depth: integer('depth').notNull().default(0),
    created_at: integer('created_at').notNull(),
    last_accessed: integer('last_accessed').notNull(),
    embedding: blob('embedding', { mode: 'buffer' }),
    metadata: text('metadata', { mode: 'json' })
      .notNull()
      .default('{}')
      .$type<Record<string, unknown>>(),
    is_active: integer('is_active').notNull().default(1),
    parent_ids: text('parent_ids', { mode: 'json' })
      .notNull()
      .default('[]')
      .$type<number[]>(),
  },
  (table) => [
    index('idx_memories_agent_active').on(table.agent_id, table.is_active, table.created_at),
    index('idx_memories_agent_type').on(table.agent_id, table.type, table.is_active),
  ]
);

// ─── 12. worldState ───────────────────────────────────────────────────────────

export const worldState = sqliteTable('world_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  time: text('time', { mode: 'json' })
    .notNull()
    .$type<{
      day: number;
      hour: number;
      minute: number;
      totalTicks: number;
      seasonDay: number;
      season: string;
    }>(),
  day_phase: text('day_phase').notNull(),
  weather: text('weather').notNull(),
  weather_duration: integer('weather_duration').notNull(),
  tick_speed: real('tick_speed').notNull(),
  is_paused: integer('is_paused', { mode: 'boolean' }).notNull(),
  last_tick_completed: real('last_tick_completed').notNull(),
  current_tick_phase: integer('current_tick_phase').notNull(),
  tick_id: text('tick_id').notNull(),
  pending_transitions: text('pending_transitions', { mode: 'json' })
    .notNull()
    .$type<Record<string, any>[]>(),
  tax_pool: real('tax_pool').notNull(),
  map_width: integer('map_width').notNull(),
  map_height: integer('map_height').notNull(),
  collision_grid: text('collision_grid').notNull(),
  setup_config: text('setup_config', { mode: 'json' }).$type<Record<string, any> | null>(),
});

// ─── 13. worldEvents ──────────────────────────────────────────────────────────

export const worldEvents = sqliteTable(
  'world_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    started_at: integer('started_at').notNull(),
    duration: integer('duration').notNull(),
    effects: text('effects', { mode: 'json' }).notNull().$type<Record<string, any>>(),
    location_id: integer('location_id').references(() => locations.id),
    triggered_by: text('triggered_by').notNull(),
    is_active: integer('is_active', { mode: 'boolean' }).notNull(),
  },
  (table) => [index('idx_world_events_is_active').on(table.is_active)]
);

// ─── 14. templates ────────────────────────────────────────────────────────────

export const templates = sqliteTable('templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  category: text('category').notNull(),
  conditions: text('conditions', { mode: 'json' }).notNull().$type<Record<string, any>>(),
  variants: text('variants', { mode: 'json' })
    .notNull()
    .$type<{ text: string; sentiment: number }[]>(),
  cooldown_per_pair: integer('cooldown_per_pair').notNull(),
});

// ─── 15. templateUsage ────────────────────────────────────────────────────────

export const templateUsage = sqliteTable(
  'template_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    template_category: text('template_category').notNull(),
    agent_a: integer('agent_a').notNull().references(() => agents.id),
    agent_b: integer('agent_b').notNull().references(() => agents.id),
    used_at: integer('used_at').notNull(),
  },
  (table) => [
    index('idx_template_usage_pair_category').on(
      table.agent_a,
      table.agent_b,
      table.template_category
    ),
  ]
);

// ─── 17. agentStates ──────────────────────────────────────────────────────────

export const agentStates = sqliteTable('agent_states', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agent_id: integer('agent_id').notNull().references(() => agents.id),
  type: text('type').notNull(),
  severity: real('severity').notNull(),
  started_at: integer('started_at').notNull(),
  duration: integer('duration').notNull(),
  target_agent_id: integer('target_agent_id').references(() => agents.id),
  source: text('source').notNull(),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, any> | null>(),
}, (table) => [
  index('idx_agent_states_agent_id').on(table.agent_id),
  index('idx_agent_states_agent_type').on(table.agent_id, table.type),
]);

// ─── 16. activityLog ──────────────────────────────────────────────────────────

export const activityLog = sqliteTable(
  'activity_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    category: text('category').notNull(),
    importance: real('importance').notNull(),
    initiator_id: integer('initiator_id'),
    target_id: integer('target_id'),
    agent_ids: text('agent_ids', { mode: 'json' }).notNull().$type<number[]>(),
    template_key: text('template_key').notNull(),
    template_data: text('template_data', { mode: 'json' }).notNull().$type<Record<string, string | number>>(),
    location_id: integer('location_id'),
    source_type: text('source_type'),
    source_id: integer('source_id'),
    severity: real('severity'),
    timestamp: integer('timestamp').notNull(),
    real_timestamp: integer('real_timestamp').notNull(),
  },
  (table) => [
    index('idx_activity_category_ts').on(table.category, table.timestamp),
    index('idx_activity_importance_ts').on(table.importance, table.timestamp),
    index('idx_activity_agent').on(table.initiator_id, table.timestamp),
    index('idx_activity_log_timestamp').on(table.timestamp),
  ]
);

// ─── 18. shared_knowledge ─────────────────────────────────────────────────────

export const shared_knowledge = sqliteTable('shared_knowledge', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  subject_id: integer('subject_id').notNull().references(() => agents.id),
  target_id: integer('target_id').references(() => agents.id),
  content: text('content').notNull(),
  sensitivity: integer('sensitivity').notNull(),
  known_by: text('known_by', { mode: 'json' }).notNull().$type<number[]>(),
  created_at: integer('created_at').notNull(),
  is_active: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  reliability: text('reliability').default('confirmed'),
  source: text('source').notNull(),
}, (table) => [
  index('idx_shared_knowledge_subject').on(table.subject_id),
  index('idx_shared_knowledge_active').on(table.is_active),
]);

// ─── 19. interactions ─────────────────────────────────────────────────────────

export const interactions = sqliteTable(
  'interactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type').notNull(),
    location_id: integer('location_id'),
    trigger: text('trigger').notNull(),
    trigger_rule_id: text('trigger_rule_id'),
    goal_id: integer('goal_id'),
    outcome: text('outcome').notNull(),
    severity: real('severity').notNull(),
    context: text('context', { mode: 'json' }).$type<Record<string, any> | null>(),
    narration: text('narration'),
    narration_status: text('narration_status').notNull().default('pending'),
    started_at: integer('started_at').notNull(),
    resolved_at: integer('resolved_at'),
  },
  (table) => [
    index('idx_interactions_location_tick').on(table.location_id, table.started_at),
  ]
);

// ─── 20. interactionParticipants ──────────────────────────────────────────────

export const interactionParticipants = sqliteTable(
  'interaction_participants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    interaction_id: integer('interaction_id').notNull(),
    agent_id: integer('agent_id').notNull(),
    role: text('role').notNull(),
    awareness: text('awareness'),
  },
  (table) => [
    index('idx_ip_agent').on(table.agent_id),
    index('idx_ip_interaction').on(table.interaction_id),
  ]
);

// ─── 21. goals ────────────────────────────────────────────────────────────────

export const goals = sqliteTable(
  'goals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent_id: integer('agent_id').notNull(),
    type: text('type').notNull(),
    target_id: integer('target_id'),
    motivation: text('motivation').notNull(),
    priority: real('priority').notNull(),
    progress: real('progress').notNull().default(0),
    status: text('status').notNull().default('active'),
    created_at: integer('created_at').notNull(),
    expires_at: integer('expires_at'),
  },
  (table) => [
    index('idx_goals_agent_status').on(table.agent_id, table.status),
    index('idx_goals_target').on(table.target_id),
  ]
);

// ─── 22. aspirations ──────────────────────────────────────────────────────────

export const aspirations = sqliteTable(
  'aspirations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent_id: integer('agent_id').notNull(),
    type: text('type').notNull(),
    intensity: real('intensity').notNull(),
    status: text('status').notNull().default('active'),
    adopted_at: integer('adopted_at').notNull(),
    shifted_at: integer('shifted_at'),
    trigger: text('trigger').notNull(),
    shifted_to: text('shifted_to'),
  },
  (table) => [
    index('idx_aspirations_agent_status').on(table.agent_id, table.status),
  ]
);

// ─── 23. interactionCooldowns ─────────────────────────────────────────────────

export const interactionCooldowns = sqliteTable(
  'interaction_cooldowns',
  {
    agent_a: integer('agent_a').notNull(),
    agent_b: integer('agent_b').notNull().default(0),
    type: text('type').notNull(),
    expires_at: integer('expires_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_cooldown_pk').on(table.agent_a, table.agent_b, table.type),
  ]
);
