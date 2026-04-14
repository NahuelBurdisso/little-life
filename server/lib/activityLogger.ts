import { db } from '../db';
import { activityLog, worldState } from '../db/schema';
import { emitter } from '../engine/emitter';
import { ACTIVITY_REGISTRY } from '../data/activityRegistry';

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
  metadata?: { chainId?: string; chainDepth?: number; ruleId?: string } | null;
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
  const currentTick = (world?.time as any)?.totalTicks ?? 0;

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
    real_timestamp: Date.now(),
  }).run();

  emitter.markDirty('activity.all');
}
