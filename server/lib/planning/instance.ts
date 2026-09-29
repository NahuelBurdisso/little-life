import { planCache } from './PlanCache';
import { planLLMQueue } from './PlanLLMQueue';
import { PlanGenerator } from './PlanGenerator';
import { PlanDecomposer } from './PlanDecomposer';
import { PlanExecutor } from './PlanExecutor';
import { ReplanEvaluator } from './ReplanEvaluator';
import { PlanLLMGate } from './PlanLLMGate';
import { gameMinutesNow } from '../worldClock';
import { memoryService } from '../memory/instance';
import { db } from '../../db';
import { worldState } from '../../db/schema';

export { planCache, planLLMQueue };

function worldTime(): { day?: number; hour?: number; minute?: number } | undefined {
  const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  return world?.time as { day?: number; hour?: number; minute?: number } | undefined;
}

/** One gate for every planning LLM call: plans, decompositions and replans. */
export const planLLMGate = new PlanLLMGate(gameMinutesNow);
export const planGenerator = new PlanGenerator(planCache, planLLMQueue, memoryService, planLLMGate);
export const planDecomposer = new PlanDecomposer(planCache, planLLMQueue, planLLMGate);
export const planExecutor = new PlanExecutor(planCache, planDecomposer);
export const replanEvaluator = new ReplanEvaluator(
  planCache,
  planGenerator,
  () => worldTime()?.hour ?? 12,
  gameMinutesNow,
);
