import { planCache } from './PlanCache';
import { planLLMQueue } from './PlanLLMQueue';
import { PlanGenerator } from './PlanGenerator';
import { PlanDecomposer } from './PlanDecomposer';
import { PlanExecutor } from './PlanExecutor';
import { ReplanEvaluator } from './ReplanEvaluator';
import { memoryService } from '../memory/instance';
import { db } from '../../db';
import { worldState } from '../../db/schema';

export { planCache, planLLMQueue };

export const planGenerator = new PlanGenerator(planCache, planLLMQueue, memoryService);
export const planDecomposer = new PlanDecomposer(planCache, planLLMQueue);
export const planExecutor = new PlanExecutor(planCache, planDecomposer);
export const replanEvaluator = new ReplanEvaluator(
  planCache,
  planGenerator,
  () => {
    const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
    return (world?.time as any)?.hour ?? 12;
  },
  () => {
    const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
    return (world?.time as any)?.totalTicks ?? 0;
  },
);
