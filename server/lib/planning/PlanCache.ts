import { db } from '../../db';
import { agents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import type { DailyPlan, PlanExecutionState } from './types';

class PlanCache {
  private plans = new Map<number, DailyPlan | null>();
  private execStates = new Map<number, PlanExecutionState>();
  private loaded = new Set<number>();

  private loadFromDB(agentId: number): void {
    const row = db
      .select({ daily_plan: agents.daily_plan })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();

    const plan = row?.daily_plan ?? null;
    this.plans.set(agentId, plan as DailyPlan | null);
    this.loaded.add(agentId);
  }

  get(agentId: number): DailyPlan | null {
    if (!this.loaded.has(agentId)) {
      this.loadFromDB(agentId);
    }
    return this.plans.get(agentId) ?? null;
  }

  set(agentId: number, plan: DailyPlan): void {
    this.plans.set(agentId, plan);
    this.loaded.add(agentId);
    db.update(agents)
      .set({ daily_plan: plan })
      .where(eq(agents.id, agentId))
      .run();
  }

  getExecState(agentId: number): PlanExecutionState | null {
    return this.execStates.get(agentId) ?? null;
  }

  setExecState(agentId: number, state: PlanExecutionState): void {
    this.execStates.set(agentId, state);
  }

  invalidate(agentId: number): void {
    this.plans.delete(agentId);
    this.execStates.delete(agentId);
    this.loaded.delete(agentId);
  }

  clear(): void {
    this.plans.clear();
    this.execStates.clear();
    this.loaded.clear();
  }
}

export const planCache = new PlanCache();
