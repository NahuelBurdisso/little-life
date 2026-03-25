export const CONFIG = {
  // Simulation
  TICK_INTERVAL_MS: 1000,
  DEFAULT_TICK_SPEED: 1,
  MAX_TICK_SPEED: 4,
  MAX_AGENTS: 20,
  STARTING_AGENTS: 12,

  // Needs
  NEEDS: {
    DEFAULT_DECAY_RATES: {
      hunger: 4.2,
      energy: 3.5,
      social: 2.0,
      comfort: 1.0,
      fun: 2.5,
    },
    THRESHOLDS: { critical: 15, low: 35, satisfied: 70 },
    MOOD_MODIFIER_DURATION_TICKS: 120,
    STRESS_DECAY_AMPLIFIER: 200,
    MOOD_CRITICAL_THRESHOLD: 10,
  },

  // Economy
  ECONOMY: {
    STARTING_MONEY: 50,
    DAILY_EXPENSES: { min: 2, max: 5 },
    TAX_RATE: 0.05,
    TARGET_PER_CAPITA_MONEY: 50,
    INFLATION_THRESHOLD: 1.5,
    DEFLATION_THRESHOLD: 0.5,
    BASE_PRICES: {
      food_raw: 3,
      food_prepared: 6,
      drink: 4,
      medicine: 12,
      seeds: 2,
    } as Record<string, number>,
    SEASON_PRICE_MODIFIERS: {
      spring: 0.9,
      summer: 0.8,
      autumn: 1.0,
      winter: 1.5,
    } as Record<string, number>,
    MIN_PAYDAY_INTERVAL_HOURS: 6,
  },

  // Relationships
  RELATIONSHIPS: {
    PROXIMITY_FAMILIARITY_RATE: 0.5,
    DECAY_GRACE_PERIOD_DAYS: 3,
    DECAY_MAX_STRENGTH_DAYS: 30,
    DECAY_DAILY_RATE: 0.3,
    GRUDGE_DECAY_MULTIPLIER: 0.5,
    ROMANCE_DECAY_MULTIPLIER: 1.5,
    STRONG_RELATIONSHIP_RESISTANCE: 0.3,
    DIMINISHING_RETURNS_FACTOR: 0.6,
  },

  // Conversations
  CONVERSATIONS: {
    MAX_CONCURRENT_LLM: 2,
    MAX_QUEUE_SIZE: 4,
    MAX_TURNS_DEEP: 6,
    MAX_TURNS_STANDARD: 4,
    TEMPLATE_FALLBACK_MS: 10000,
    PLAYER_NUDGE_PRIORITY: 200,
    PLAYER_NUDGE_MAX_WAIT_MS: 30000,
    COOLDOWN_SAME_PAIR_HOURS: 2,
    TEMPLATE_COOLDOWN_PER_PAIR: 4,
  },

  // AI / Ollama
  AI: {
    CHAT_MODEL: "dolphin-qwen2.5:7b",
    EMBEDDING_MODEL: "mxbai-embed-large",
    CHAT_TEMPERATURE: 0.8,
    CHAT_TOP_P: 0.9,
    CHAT_MAX_TOKENS: 150,
    CHAT_REPEAT_PENALTY: 1.1,
    EMBEDDING_DIMENSIONS: 1024,
    MEMORY_RETRIEVAL_LIMIT: 6,
    MEMORY_RECENCY_BIAS: 0.3,
    MEMORY_ACCESS_PENALTY: 0.02,
    MEMORY_ACCESS_PENALTY_MAX: 0.2,
    REFLECTION_IMPORTANCE: 7,
    RETRY_ATTEMPTS: 2,
    TIMEOUT_MS: 15000,
  },

  // Decision Engine
  DECISIONS: {
    ACTION_MIN_DURATIONS: {
      sleeping: 360,
      working: 60,
      eating: 20,
      talking: 5,
      shopping: 10,
      walking: 0,
      idle: 10,
      socializing: 15,
    } as Record<string, number>,
    NOISE_FACTOR: 0.1,
    EMERGENCY_OVERRIDE: true,
  },

  // Movement
  MOVEMENT: {
    PIXELS_PER_GAME_MINUTE: 16,
    ARRIVAL_THRESHOLD_PX: 8,
    TILE_SIZE: 32,
  },

  // Events
  EVENTS: {
    RANDOM_EVENT_CHANCE_PER_HOUR: 0.05,
    MAX_CONCURRENT_EVENTS: 3,
    WEATHER_DURATION_RANGE: { min: 2, max: 8 },
  },

  // Time
  TIME: {
    SEASON_LENGTH_DAYS: 28,
    DAY_PHASES: {
      dawn: { start: 5, end: 7 },
      morning: { start: 7, end: 12 },
      afternoon: { start: 12, end: 17 },
      evening: { start: 17, end: 20 },
      night: { start: 20, end: 5 },
    },
  },

  // UI
  UI: {
    ACTIVITY_FEED_MAX_ENTRIES: 50,
    AGENT_TOOLTIP_DELAY_MS: 300,
    PANEL_ANIMATION_MS: 200,
    MAX_VISIBLE_MEMORIES: 20,
    MAX_VISIBLE_TRANSACTIONS: 30,
  },
} as const;

export const SYSTEM_PHASES = [
  { name: "needs", tickPriority: 10, contextKey: "needs" },
  { name: "economy", tickPriority: 20, contextKey: "economy" },
  { name: "relationships", tickPriority: 30, contextKey: "relationships" },
  { name: "conversations", tickPriority: 40, contextKey: null },
  { name: "decisions", tickPriority: 50, contextKey: null },
  { name: "movement", tickPriority: 60, contextKey: null },
  { name: "events", tickPriority: 70, contextKey: null },
] as const;
