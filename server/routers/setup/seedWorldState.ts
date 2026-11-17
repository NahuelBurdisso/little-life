/**
 * Seeding steps 9-11: the world row, the conversation scheduler's singleton and
 * the opening activity log line.
 */
import { randomUUID } from 'crypto';
import { db } from '../../db';
import { conversationSchedulerState, economy, worldState } from '../../db/schema';
import { logActivity } from '../../lib/activityLogger';
import { CONFIG } from '../../lib/constants';
import { queueMaxWait } from '../../lib/conversationPacing';
import { moneyTargetFor, startingTreasury } from '../../lib/townTreasury';
import type { SeedContext } from './seedContext';

// ─── Helper: determine day phase from hour ────────────────────────────────────

function getDayPhase(hour: number): string {
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'evening';
  return 'night';
}

/**
 * Step 9: the world row (clock, weather, map, treasury, the config itself).
 * Must follow step 4: the money target is read back from the economy rows.
 * Returns the starting day phase, which the opening log line names.
 */
export function insertWorldState(ctx: SeedContext): string {
  const { config, genResult, now } = ctx;

  // 9. Create worldState. The rules are read back from `setup_config` (below),
  // through lib/worldRules.ts: a copy in the clock JSON would not survive the
  // first tick, which rebuilds `time` field by field.
  const startHour = config.world.startHour;
  const dayPhase = getDayPhase(startHour);

  db.insert(worldState).values({
    time: {
      day: config.world.startDay,
      hour: startHour,
      minute: 0,
      totalTicks: 0,
      seasonDay: config.world.startDay,
      season: config.world.season,
    },
    day_phase: dayPhase,
    weather: config.world.weather,
    weather_duration: 6,
    tick_speed: (config.rules.tickSpeed as number) ?? 1,
    is_paused: false,
    last_tick_completed: now,
    current_tick_phase: 0,
    tick_id: 'init',
    pending_transitions: [],
    // The town's opening reserve (townTreasury.ts): wages are paid from it.
    tax_pool: startingTreasury(config.agents.length, CONFIG.ECONOMY.TREASURY_START_PER_CAPITA),
    // The residents' economy rows were written above (every table was cleared).
    money_target_per_capita: moneyTargetFor(
      db.select({ money: economy.money }).from(economy).all().map((e) => e.money),
      CONFIG.ECONOMY.MONEY_TARGET_RANGE,
    ),
    map_width: genResult.dimensions.width,
    map_height: genResult.dimensions.height,
    collision_grid: genResult.collisionGrid,
    road_tiles: genResult.roads,
    terrain_tiles: genResult.terrainTiles,
    setup_config: config,
    // A new town, even from the same seed: its saves rotate on their own.
    world_id: randomUUID(),
  }).run();

  return dayPhase;
}

/** Step 10: the conversation scheduler's singleton row, at the configured limits. */
export function insertSchedulerState(): void {
  // 10. Create conversationSchedulerState singleton
  db.insert(conversationSchedulerState).values({
    active_llm_conversations: [],
    max_concurrent_llm: CONFIG.CONVERSATIONS.MAX_CONCURRENT_LLM,
    max_queue_size: CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE,
    max_turns_deep: CONFIG.CONVERSATIONS.MAX_TURNS_DEEP,
    max_turns_standard: CONFIG.CONVERSATIONS.MAX_TURNS_STANDARD,
    template_fallback_after_ms: queueMaxWait(CONFIG.CONVERSATIONS.QUEUE_MAX_WAIT_GAME_MINUTES),
    stats: {
      llmConversationsTotal: 0,
      templateConversationsTotal: 0,
      averageResponseTimeMs: 0,
      queueTimeoutsTotal: 0,
    },
  }).run();
}

/** Step 11: the activity log's opening line. */
export function logWorldCreated(ctx: SeedContext, dayPhase: string): void {
  const { config, agentMap } = ctx;
  const startHour = config.world.startHour;

  // 11. Create initial activity log entry
  const seasonLabel =
    config.world.season.charAt(0).toUpperCase() + config.world.season.slice(1);
  logActivity({
    type: 'system',
    templateData: { message: `Little Life begins. Day ${config.world.startDay}, ${seasonLabel} ${dayPhase}. ${agentMap.size} residents ${startHour >= 17 || startHour < 5 ? 'go about their evening' : 'start their day'}.` },
  });
}
