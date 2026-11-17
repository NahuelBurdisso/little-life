import { db } from '../db';
import { activityLog, worldState } from '../db/schema';
import { and, inArray, lt } from 'drizzle-orm';
import { emitter } from '../engine/emitter';
import { ACTIVITY_REGISTRY } from '../data/activityRegistry';
import type { DramaBeat } from '../data/dramaBeats';
import { gameDaysToTicks, gameMinutes, type ClockTime } from './gameClock';

interface LogActivityParams {
  type: string;
  initiator?: number;
  target?: number;
  agents?: number[];
  location?: number;
  sourceType?: string;
  sourceId?: number;
  severity?: number;
  templateData: Record<string, string | number>;
  /**
   * `beat` tags a `drama` row with what it was about so the canvas needn't parse the
   * description (see data/dramaBeats.ts). It lives in this JSON column rather than a new one,
   * so old databases need no ALTER and old rows simply lack it.
   */
  metadata?: {
    chainId?: string; chainDepth?: number; ruleId?: string; beat?: DramaBeat;
    /** The shared_knowledge row a gossip beat retells (gazette.ts: old news). */ factId?: number;
    /** A `social_call` row's kind (lib/socialCalls): the soak counts calls per kind by it. */ callKind?: string;
  } | null;
}

export function logActivity(params: LogActivityParams): void {
  const def = ACTIVITY_REGISTRY[params.type];
  if (!def) {
    console.warn(`Unknown activity type: ${params.type}`);
    return;
  }

  const agentIds = params.agents ?? [params.initiator, params.target].filter((id): id is number => id != null);
  const importance = Math.min(1, def.base_importance + (params.severity ?? 0) * 0.3);

  const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  const currentTick = world?.time.totalTicks ?? 0;
  // The in-world instant, for the town timeline's day buckets. `timestamp` above
  // is a tick count and can't be turned into a day once the speed has changed.
  // No world row (a bare test DB) leaves it NULL rather than inventing day 0.
  const gameMinute = world?.time ? gameMinutes(world.time as ClockTime) : null;

  db.insert(activityLog).values({
    type: params.type,
    category: def.category,
    importance,
    initiator_id: params.initiator ?? null,
    target_id: params.target ?? null,
    agent_ids: agentIds,
    template_key: params.type,
    template_data: params.templateData,
    location_id: params.location ?? null,
    source_type: params.sourceType ?? null,
    source_id: params.sourceId ?? null,
    severity: params.severity ?? null,
    metadata: params.metadata ?? null,
    timestamp: currentTick,
    game_minute: gameMinute,
    real_timestamp: Date.now(),
  }).run();

  emitter.markDirty('activity.all');
}

// ─── Retention ────────────────────────────────────────────────────────────────

/** How long each retention tier survives, in game days. */
const RETENTION_DAYS: Record<string, number> = {
  short: 3,
  medium: 14,
  long: 60,
};

/** Registry types bucketed by tier, built once. `permanent` is absent on purpose. */
const TYPES_BY_RETENTION = Object.entries(ACTIVITY_REGISTRY).reduce<Record<string, string[]>>(
  (acc, [type, def]) => {
    if (def.retention in RETENTION_DAYS) (acc[def.retention] ??= []).push(type);
    return acc;
  },
  {},
);

/**
 * Drop activity rows past their declared retention. Without this the log grows
 * for the life of the world — at one tick per second the low-value tiers
 * (`state_gained`, `purchase`, zone actions) dominate the table within hours.
 *
 * Bounded by `timestamp` (ticks) so it rides `idx_activity_log_timestamp`, and
 * only ever removes types the registry marks as expendable: `permanent` rows,
 * and any type not in the registry, are never touched.
 *
 * CLOCK: the rows are TICK-stamped, the tiers are GAME days, so the window is
 * converted at the current `tickSpeed` (approximate if the speed changed within
 * it; see TickClock in gameClock.ts). A flat 1440 ticks per day kept rows four
 * times as many game days at 4x.
 */
export function pruneActivityLog(currentTick: number, tickSpeed: number): number {
  let deleted = 0;

  for (const [tier, days] of Object.entries(RETENTION_DAYS)) {
    const types = TYPES_BY_RETENTION[tier];
    if (!types?.length) continue;

    const cutoff = currentTick - gameDaysToTicks(days, tickSpeed);
    if (cutoff <= 0) continue;

    deleted += db
      .delete(activityLog)
      .where(and(inArray(activityLog.type, types), lt(activityLog.timestamp, cutoff)))
      .run().changes;
  }

  return deleted;
}
