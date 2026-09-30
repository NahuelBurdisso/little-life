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
    // GAME MINUTE of the last interaction — the clock relationship decay reads.
    // `last_interaction` is Date.now(), so a gap measured on it counted time the
    // server was off or paused as game time. Nullable because it was added to
    // existing worlds; startup backfills NULLs to the current game minute
    // (clockMigration.ts) and the decay pass stamps any it still meets.
    last_interaction_minute: integer('last_interaction_minute'),
    // GAME MINUTE at which `status` last changed. Life milestones read it: a
    // couple proposes after being `partners` for a few game days. Nullable
    // because it was added to existing worlds; a NULL means "unknown", and the
    // milestones engine stamps it the first time it meets the pair.
    status_since_minute: integer('status_since_minute'),
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
    // GAME MINUTE the event happened — the clock story arcs and retention read.
    // `timestamp` is Date.now(), so on it a paused game kept ageing its stories
    // and an overnight session aged them by the night. No insert site sets this:
    // a TEMP trigger installed at DB open (server/db/index.ts) copies the world
    // clock into every new row, so the dozen writers across the engine can't
    // forget it. Nullable because it was added to existing worlds; startup
    // backfills the old rows (clockMigration.ts).
    game_minute: integer('game_minute'),
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
    quality_score: real('quality_score'),
    quality_breakdown: text('quality_breakdown', { mode: 'json' }).$type<Record<string, number> | null>(),
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
    /** WALL-CLOCK ms (Date.now()) — diagnostics only; expiry runs on game time. */
    queued_at: integer('queued_at').notNull(),
    /**
     * How long the entry may wait, in ms OF 1x PLAY: one game minute per
     * TICK_INTERVAL_MS (`queueMaxWait()` builds it from game minutes; the
     * decisions.ts literal 10000 is 10 game minutes). The scheduler converts it
     * into `deadline_game_min` the first time it sees the entry.
     */
    max_wait: integer('max_wait').notNull(),
    /** GAME MINUTES at which the entry times out; stamped by conversationsTick. */
    deadline_game_min: integer('deadline_game_min'),
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
  road_tiles: text('road_tiles', { mode: 'json' }).$type<Array<{x: number; y: number}>>().notNull().$defaultFn(() => []),
  terrain_tiles: text('terrain_tiles', { mode: 'json' }).$type<Array<{x: number; y: number; kind: string}>>().notNull().$defaultFn(() => []),
  setup_config: text('setup_config', { mode: 'json' }).$type<Record<string, any> | null>(),
  // Rules the player changed while the town runs (the Storyteller presets,
  // `world.setRules`), layered over `setup_config.rules` by lib/worldRules.ts.
  // Kept apart from setup_config so a Restart replays the wizard's scenario
  // without them. NULL = no overrides.
  rule_overrides: text('rule_overrides', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  // Identity of this town, minted when a world is built (setup.replaceWorld)
  // and carried by its saves: autosaves rotate per world and the Saves dialog
  // tells this town's saves from other towns' (lib/saves.ts). Two Restarts of
  // one seed are two worlds. NULL on worlds from before it existed; the first
  // save of such a world assigns one.
  world_id: text('world_id'),
  // The town calendar (lib/townCalendar.ts): which announcements, festival
  // starts and contests already happened, the running mayoral election (its
  // candidates and the hidden support they canvassed) and the last result.
  // Kept on the world row rather than in memory so a restart mid-campaign
  // neither forgets the candidates nor holds the Spring Fair twice, and a save
  // carries its election with it. NULL = nothing yet.
  civic: text('civic', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  // Money per resident the balancer steers to (townTreasury.ts moneyTargetFor),
  // stored at world creation from the starting cash. NULL on saves from before
  // it existed: CONFIG.ECONOMY.TARGET_PER_CAPITA_MONEY.
  money_target_per_capita: real('money_target_per_capita'),
  // Nights of eased-in lifestyle upkeep still to come (townTreasury.ts upkeepRamp).
  // NULL = not evaluated yet: the first economy tick sets it — 0 for a world made
  // with the treasury loop, UPKEEP_RAMP_NIGHTS for an old save whose loop starts late.
  treasury_ramp_left: integer('treasury_ramp_left'),
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
//
// LEGACY, unused (B19). This held the old per-category chat-line catalog, copied in at seed/setup
// but never read: template chats are played from topic scripts (data/smallTalkScripts.ts,
// lib/templateChat.ts) and their cooldowns live in `template_usage`. Nothing writes it now and the
// catalog is gone. The definition stays only so old databases (which still have the table and its
// rows) and the ALL_TABLES clear in db/worldTables.ts keep working; a world replace empties it.
// It can be dropped for good together with a `DROP TABLE` migration once old saves are not a concern.

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
    /** WALL-CLOCK ms — ordering only. */
    used_at: integer('used_at').notNull(),
    /**
     * GAME MINUTES — what the per-pair cooldown is measured on. Null on rows
     * written before it existed; those count as expired.
     */
    used_game_min: integer('used_game_min'),
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
    metadata: text('metadata', { mode: 'json' }).$type<{ chainId?: string; chainDepth?: number; ruleId?: string; beat?: string } | null>(),
    timestamp: integer('timestamp').notNull(),
    // GAME MINUTE the row was logged at (`gameMinutes(world.time)`) — what the
    // town timeline groups into days. `timestamp` is a TICK count, and a tick is
    // `tick_speed` game minutes, so bucketing it by 1440 drifted every time the
    // speed changed (B13b). Stamped by logActivity, the only writer; nullable
    // because it was added to existing worlds (startup backfills them from the
    // tick age, db/activityLogClock.ts) and a row logged with no world row has
    // no clock to copy.
    game_minute: integer('game_minute'),
    real_timestamp: integer('real_timestamp').notNull(),
  },
  (table) => [
    index('idx_activity_log_game_minute').on(table.game_minute),
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
  /** Set once most of the town knows: the secret has become common knowledge. */
  is_public: integer('is_public', { mode: 'boolean' }).notNull().default(false),
  /** Real ms at which it crossed the threshold, null while still a secret. */
  revealed_at: integer('revealed_at'),
  /**
   * GAME MINUTE the jail sentence this fact earned ends; null while unpunished. An arrest
   * marks the facts it was for (lib/arrests.ts): the town still knows them, but the constable
   * doesn't arrest anyone twice for the same misdeeds, which re-jailed the same resident on
   * every release (facts never expire).
   */
  paid_at: integer('paid_at'),
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
    /** Tick at which the goal reached a terminal status (completed/abandoned). */
    completed_at: integer('completed_at'),
    // NEW columns for LLM-driven goals
    description: text('description'),
    strategy: text('strategy'),
    mapped_interactions: text('mapped_interactions'),
    pivot_count: integer('pivot_count').notNull().default(0),
    source: text('source').notNull().default('reactive'),
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
    // NEW columns for LLM-driven ambitions
    description: text('description'),
    shifted_reason: text('shifted_reason'),
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

// ─── 24. gazetteIssues ────────────────────────────────────────────────────────
// The Town Crier, one LLM-written edition per game day (server/lib/gazette.ts).
// Created at runtime by CREATE TABLE IF NOT EXISTS in server/db/index.ts.

export interface GazetteArticle {
  headline: string;
  body: string;
}

export const gazetteIssues = sqliteTable('gazette_issues', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Game day the edition reports on. */
  day: integer('day').notNull(),
  season: text('season').notNull(),
  headline: text('headline').notNull(),
  articles: text('articles', { mode: 'json' }).notNull().$type<GazetteArticle[]>(),
  gossip: text('gossip'),
  /** totalTicks when it was written: the next edition covers activity after this. */
  covers_to_tick: integer('covers_to_tick').notNull(),
  /** Real ms. */
  created_at: integer('created_at').notNull(),
});

// ─── 25. simSnapshots ─────────────────────────────────────────────────────────
// Checkpoints of the simulation state that lives in module memory rather than
// in a table (hobby skills, favors, tension, mood momentum, personality drift
// baselines, state trackers — see server/engine/simSnapshots.ts). One row per
// store, JSON blob, rewritten every game hour and on graceful shutdown, read
// back at boot. Created at runtime by CREATE TABLE IF NOT EXISTS in
// server/db/index.ts.

export const simSnapshots = sqliteTable('sim_snapshots', {
  /** Store name, e.g. 'hobbies'. One row per store: the DB holds one world. */
  key: text('key').primaryKey(),
  /**
   * `world_state.id` of the world that wrote it. That id is AUTOINCREMENT, so
   * unlike agent ids it is not reused by a later world: a row whose world_id
   * is not the current world's is a leftover and is ignored on load.
   */
  world_id: integer('world_id').notNull(),
  /** The store's own format version; a mismatch is dropped, not misread. */
  version: integer('version').notNull(),
  /** Game minute (`gameMinutes`) of the world clock when it was written. */
  game_minute: integer('game_minute').notNull(),
  data: text('data', { mode: 'json' }).notNull().$type<unknown>(),
  /** Real ms. */
  saved_at: integer('saved_at').notNull(),
});

// ─── 26. children ─────────────────────────────────────────────────────────────
// Babies born to married residents (server/lib/family.ts). A child is a
// lightweight household member, NOT an agent: no needs, no plan, no LLM, no
// sprite of their own. They exist so parents can talk and plan around them,
// the feed and the Crier can celebrate them, and an estate has someone to be
// held in trust for (server/lib/heirs.ts). Created at runtime by CREATE TABLE
// IF NOT EXISTS in server/db/index.ts; the rows belong to one world
// (db/worldTables.ts ALL_TABLES).

export const children = sqliteTable('children', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** First name only ("Ada"); the family is named by the parents' rows. */
  name: text('name').notNull(),
  /** 'female' | 'male', the same vocabulary as `agents.gender`. */
  sex: text('sex').notNull(),
  /** Game minute (`gameMinutes`) of the birth: the child's age is read off the clock. */
  birth_game_minute: integer('birth_game_minute').notNull(),
  mother_id: integer('mother_id').notNull().references(() => agents.id),
  /** The father as the town (and he) believes. */
  father_id: integer('father_id').references(() => agents.id),
  /** Set only when the real father is someone else (an affair): the paternity drama. */
  true_father_id: integer('true_father_id').references(() => agents.id),
  /** The house the child lives in; null once they left town with their parent. */
  home: integer('home').references(() => locations.id),
  /** Always true: no child ever dies in Little Life, whatever the death rule says. */
  alive: integer('alive', { mode: 'boolean' }).notNull().default(true),
  /** The `paternity` secret about this child (shared_knowledge id), if there is one. */
  paternity_fact_id: integer('paternity_fact_id'),
  /** The believed father (or the whole town) has learned the truth: the drama has played. */
  paternity_revealed: integer('paternity_revealed', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  index('idx_children_mother').on(table.mother_id),
  index('idx_children_father').on(table.father_id),
]);
