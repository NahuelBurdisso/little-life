/**
 * AutoPlay knobs, hoisted out of CONFIG because they are the only settings
 * mutated at runtime (`autoplayRouter.configure`). Keeping them in a separate
 * non-const object lets CONFIG itself stay `as const`, which is what makes
 * `CONFIG.TYPO` a compile error and `CONFIG.AI.BACKEND` a literal union again.
 */
export const AUTOPLAY_CONFIG = {
  // Opt-in via `autoplay.configure({ enabled: true })`. Off by default: the
  // profiler adds per-tick DB reads and the nudger injects events into the
  // player's town outside the tick transactions, and there is no UI yet.
  ENABLED: false,
  WINDOW_SIZE: 60,           // ticks per analysis window (~1 game hour)
  BOREDOM_THRESHOLD: 55,     // score to trigger auto-nudges
  AUTO_NUDGE: true,
  MAX_NUDGES_PER_DAY: 12,
  HISTORY_WINDOWS: 24,
};

export const CONFIG = {
  // Simulation
  TICK_INTERVAL_MS: 1000,
  DEFAULT_TICK_SPEED: 1,
  MAX_TICK_SPEED: 4,
  MAX_AGENTS: 20,
  STARTING_AGENTS: 12,

  // Needs
  NEEDS: {
    // Per GAME HOUR (needs.ts multiplies by `gameHoursElapsed`). Social and fun
    // are pushed hardest: they are what drives agents to seek each other out, and
    // interaction is where the story comes from. Hunger and energy are nudged only
    // slightly — steep values there produce a town that starves instead of one
    // that argues.
    DEFAULT_DECAY_RATES: {
      hunger: 4.8,
      energy: 3.8,
      social: 3.2,
      comfort: 1.4,
      fun: 3.6,
    },
    THRESHOLDS: { critical: 15, low: 35, satisfied: 70 },
    // CLOCK: GAME MINUTES, not ticks. This is added to `needs.last_updated`
    // (`day*1440 + hour*60 + minute`) to produce `mood_modifiers[].expiresAt`, which
    // `needsTick` compares against the same game-minute clock. Ticks equal game
    // minutes only at tick_speed 1, so at speed 4 this lasts 30 ticks of wall
    // progress — that is correct and intended; the value was tuned against the game
    // clock. Do NOT "fix" it by differencing it against `world.time.totalTicks`.
    MOOD_MODIFIER_DURATION_GAME_MINUTES: 120,
    STRESS_DECAY_AMPLIFIER: 200,
    MOOD_CRITICAL_THRESHOLD: 10,
  },

  // Economy
  ECONOMY: {
    STARTING_MONEY: 50,
    DAILY_EXPENSES: { min: 2, max: 5 }, // legacy fallback
    TAX_RATE: 0.05,
    TARGET_PER_CAPITA_MONEY: 50,
    INFLATION_THRESHOLD: 1.5,
    DEFLATION_THRESHOLD: 0.5,
    MIN_PAYDAY_INTERVAL_HOURS: 6,
    // BASE_PRICES and SEASON_PRICE_MODIFIERS moved to server/data/economyData.ts
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
    MAX_CONCURRENT_LLM: 4,
    // Headroom for the raised social drive — at 6 the queue capped out and
    // decisions.ts silently dropped the surplus socializing intents.
    MAX_QUEUE_SIZE: 10,
    MAX_TURNS_DEEP: 10,
    MAX_TURNS_STANDARD: 6,
    // CLOCK: GAME MINUTES. How long a queue entry may wait for its pair to be
    // free (or for an LLM slot) before it falls back to a template chat or is
    // dropped. These were wall-clock ms (10 s / 30 s), so at 4x an entry waited
    // 40 / 120 game minutes and the conversation rate followed real time. The
    // 1x behaviour is unchanged: one game minute per real second.
    QUEUE_MAX_WAIT_GAME_MINUTES: 10,
    PLAYER_NUDGE_PRIORITY: 200,
    PLAYER_NUDGE_MAX_WAIT_GAME_MINUTES: 30,
    // CLOCK: GAME MINUTES. Extra wait a protected entry (player nudge, comfort
    // visit) gets past the latest end of the conversation blocking it.
    PROTECTED_WAIT_MARGIN_GAME_MINUTES: 30,
    COOLDOWN_SAME_PAIR_HOURS: 0.5,
    TEMPLATE_COOLDOWN_PER_PAIR: 2,
    // Ended conversations kept for history/UI; older ones are pruned on day change.
    // Nothing references conversation ids, and every engine reader looks back hours, not weeks.
    MAX_ENDED_RETAINED: 2000,
    // CLOCK: GAME MINUTES. An LLM conversation's budget is its tier's max turns ×
    // this allowance: standard 6 → 90 game min, deep 10 → 150. Fifteen is the old
    // wall-clock allowance (MS_PER_LLM_TURN = 15 s) at one tick per second, so 1x
    // keeps its old per-turn budget; what changes is that at 4x the budget no
    // longer stretches to 4 × 150 = 600 game minutes (pairs talked through the
    // night and never slept).
    GAME_MINUTES_PER_TURN: 15,
    // CLOCK: GAME MINUTES. Once a conversation has to wrap up (budget spent, or a
    // participant needs sleep/food), the in-flight LLM turn gets this long to land
    // before a canned farewell closes it without that line — or one expected turn
    // (latency × speed), whichever is longer, capped by MAX_WRAP_UP_GRACE.
    WRAP_UP_GRACE_GAME_MINUTES: 15,
    MAX_WRAP_UP_GRACE_GAME_MINUTES: 120,
    // Fewest turns an LLM conversation is worth running: each side speaks once.
    // When the expected LLM latency at the current speed can't fit that inside the
    // budget, an ordinary conversation runs on the template tier instead.
    MIN_LLM_TURNS: 2,
    // CLOCK: GAME MINUTES. Player-requested conversations (nudges, confront,
    // tell-secret, autoplay) and comfort visits — and the occasional latency
    // probe — get a budget stretched to MIN_LLM_TURNS expected turns so both sides
    // actually speak, up to this ceiling.
    EXTENDED_BUDGET_CAP_GAME_MINUTES: 240,
    // Recent LLM turns whose MEDIAN estimates how long a turn takes (a median, so
    // one stalled call doesn't flip the whole town onto templates).
    TURN_LATENCY_WINDOW: 8,
    // WALL-CLOCK MS. Assumed turn latency before any has been measured — only
    // used above 1x, where guessing low is what let conversations eat the night.
    TURN_LATENCY_PRIOR_MS: 20_000,
    // CLOCK: GAME MINUTES. Samples older than this are dropped, and with none left
    // one ordinary conversation per this period runs as a MIN_LLM_TURNS probe even
    // if the prior says it won't fit, so a town pushed onto templates by a slow
    // spell (or a high speed) re-measures the model instead of staying there.
    TURN_LATENCY_MAX_AGE_GAME_MINUTES: 360,
  },

  // AI / LLM
  AI: {
    // Heavy model — conversations, reflections, snap resolution (needs personality/depth)
    CHAT_MODEL: process.env.CHAT_MODEL ?? "huihui_ai/gemma-4-abliterated:e4b",
    // Light model — planning, decomposition, goals, self-descriptions (structured output, speed)
    LIGHT_MODEL: process.env.LIGHT_MODEL ?? "huihui_ai/gemma-4-abliterated:e4b",
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? "mxbai-embed-large",
    // Backend: "ollama" (default) or "openai" (llama-server, vLLM, etc.)
    BACKEND: (process.env.LLM_BACKEND ?? "ollama") as "ollama" | "openai",
    // Base URL for chat models (Ollama or OpenAI-compatible server)
    CHAT_BASE_URL: process.env.LLM_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    // Separate base URL for embeddings (always Ollama)
    EMBED_BASE_URL: process.env.EMBED_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    CHAT_TEMPERATURE: 0.8,
    CHAT_TOP_P: 0.9,
    CHAT_MAX_TOKENS: 80,
    CHAT_MAX_TOKENS_SITUATIONAL: 120,
    CHAT_REPEAT_PENALTY: 1.1,
    EMBEDDING_DIMENSIONS: 1024,
    MEMORY_RETRIEVAL_LIMIT: 6,
    MEMORY_RECENCY_BIAS: 0.3,
    MEMORY_ACCESS_PENALTY: 0.02,
    MEMORY_ACCESS_PENALTY_MAX: 0.2,
    REFLECTION_IMPORTANCE: 7,
    RETRY_ATTEMPTS: 2,
    TIMEOUT_MS: 60000,
    // Context window for every chat call (see ollama.ts). The largest prompt
    // (reflection questions over 50 memories) is ~2k tokens plus 256 out; 8k
    // leaves room without sizing each parallel slot's KV cache for 32k. Ollama
    // truncates an over-long prompt from the FRONT — the system prompt — so
    // err high rather than low.
    NUM_CTX: Number(process.env.LLM_NUM_CTX ?? 8192),
    // How long Ollama keeps the model loaded after the last call. The default
    // 5 min unloads it whenever the game sits paused a while, and the next
    // conversation turn then pays a multi-second reload.
    KEEP_ALIVE: process.env.LLM_KEEP_ALIVE ?? '30m',
  },

  // Decision Engine
  DECISIONS: {
    ACTION_MIN_DURATIONS: {
      sleeping: 360,
      working: 60,
      // A meal is one eating action (economy.ts serveMeal: one purchase or one
      // item). At 20 minutes a meal restored ~10-12 hunger against ~106/day of
      // decay, so a town that has to pay for food needed ~10 meals a day and
      // spent its day at the table. An hour makes a meal ~30-37 (3 a day).
      eating: 60,
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
    // Rolled once per game hour (events.ts gates on the clock crossing an hour), so 0.20 is
    // ~5 world events a day against the old ~1. The random pool in
    // data/worldEventCatalog.ts mixes good (festival, harvest, wedding,
    // competition) and bad (storm, flu outbreak, fire), gated by season and
    // day phase.
    RANDOM_EVENT_CHANCE_PER_HOUR: 0.20,
    MAX_CONCURRENT_EVENTS: 5,
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


  // AutoPlay (boredom detection + sim profiler) — mutable, see AUTOPLAY_CONFIG
  AUTOPLAY: AUTOPLAY_CONFIG,
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
