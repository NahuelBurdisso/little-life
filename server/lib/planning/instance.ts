import { planCache } from './PlanCache';
import { planLLMQueue } from './PlanLLMQueue';
import { PlanGenerator } from './PlanGenerator';
import { PlanDecomposer } from './PlanDecomposer';
import { PlanExecutor } from './PlanExecutor';
import { ReplanEvaluator } from './ReplanEvaluator';
import { PlanLLMGate } from './PlanLLMGate';
import { gameMinutesNow } from '../worldClock';
import { memoryService, selfDescriptionGenerator } from '../memory/instance';
import { NightPlanner, listNightPlannerAgents } from './nightPlanner';
import { getAgentStates } from '../states';
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

/** Tomorrow's plans and the self-descriptions, asked for overnight (nightPlanner.ts). */
export const nightPlanner = new NightPlanner({
  listAgents: () => listNightPlannerAgents((id) => getAgentStates(id).includes('arrested')),
  hasPlanFor: (agentId, day) => {
    const plan = planCache.get(agentId);
    return !!plan && plan.day >= day && plan.source !== 'fallback';
  },
  queuePlan: (agentId, time) => planGenerator.queueGeneration(agentId, time),
  refreshSelfDescription: (agentId, day) => { void selfDescriptionGenerator.maybeRegenerate(agentId, day); },
});
