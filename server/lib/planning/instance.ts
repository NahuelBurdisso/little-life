import { planCache } from './PlanCache';
import { planLLMQueue } from './PlanLLMQueue';
import { PlanGenerator } from './PlanGenerator';
import { PlanDecomposer } from './PlanDecomposer';
import { PlanExecutor } from './PlanExecutor';
import { ReplanEvaluator } from './ReplanEvaluator';
import { PlanLLMGate } from './PlanLLMGate';
import { gameMinutes } from '../gameClock';
import { memoryService } from '../memory/instance';
import { db } from '../../db';
import { worldState } from '../../db/schema';

export { planCache, planLLMQueue };

function worldTime(): { day?: number; hour?: number; minute?: number } | undefined {
  const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
  return world?.time as { day?: number; hour?: number; minute?: number } | undefined;
}

function currentGameMinute(): number {
  const t = worldTime();
  return gameMinutes({ day: t?.day ?? 1, hour: t?.hour ?? 0, minute: t?.minute ?? 0 });
}

/** One gate for every planning LLM call: plans, decompositions and replans. */
export const planLLMGate = new PlanLLMGate(currentGameMinute);
export const planGenerator = new PlanGenerator(planCache, planLLMQueue, memoryService, planLLMGate);
export const planDecomposer = new PlanDecomposer(planCache, planLLMQueue, planLLMGate);
export const planExecutor = new PlanExecutor(planCache, planDecomposer);
export const replanEvaluator = new ReplanEvaluator(
  planCache,
  planGenerator,
  () => worldTime()?.hour ?? 12,
  currentGameMinute,
);
