import { db } from '../../db';
import { agents, goals, memories } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import { getEffectivePersonality } from '../states';
import { simEvents } from '../simEvents';
import { logActivity } from '../activityLogger';
import { GoalMapper } from './GoalMapper';
import { parsePivotResult } from './goalParser';
import { buildPivotPrompt } from './goalPrompts';
import { PIVOT_THRESHOLD_TICKS, STALE_ABANDON_TICKS } from './types';

export function shouldPivot(progress: number, pivotCount: number, ticksElapsed: number): boolean {
  return progress === 0 && pivotCount === 0 && ticksElapsed >= PIVOT_THRESHOLD_TICKS;
}

export function shouldAbandonStale(progress: number, ticksElapsed: number): boolean {
  return progress === 0 && ticksElapsed >= STALE_ABANDON_TICKS;
}

export function computeEmotionalImportance(
  priority: number,
  daysActive: number,
  personality: { neuroticism: number; impulsiveness: number },
): number {
  let factor = 1.0;
  if (personality.neuroticism > 60) factor = 1.5;
  else if (personality.impulsiveness > 60) factor = 0.7;
  return priority * Math.min(daysActive, 7) / 7 * factor;
}

export class PivotEvaluator {
  private mapper = new GoalMapper();
  private inFlight = new Set<number>(); // goal IDs currently being pivoted
  private lastEvalTick = new Map<number, number>(); // agentId → last tick evaluated
  private static EVAL_COOLDOWN = 60; // only evaluate once per 60 ticks (~1 game hour)

  async evaluate(agentId: number, currentTick: number): Promise<void> {
    // Cooldown: don't re-evaluate same agent every tick
    const lastTick = this.lastEvalTick.get(agentId) ?? 0;
    if (currentTick - lastTick < PivotEvaluator.EVAL_COOLDOWN) return;
    this.lastEvalTick.set(agentId, currentTick);
    const activeGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active'))).all();
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent) return;

    for (const goal of activeGoals) {
      const ticksElapsed = currentTick - goal.created_at;

      // Dead target check
      if (goal.target_id) {
        const target = db.select({ is_active: agents.is_active }).from(agents).where(eq(agents.id, goal.target_id)).get();
        if (target && !target.is_active) {
          this.abandonGoal(goal, agentId, 'target is no longer around', currentTick);
          continue;
        }
      }

      // 3-day stale safety net
      if (shouldAbandonStale(goal.progress, ticksElapsed)) {
        this.abandonGoal(goal, agentId, 'no progress after extended time', currentTick);
        continue;
      }

      // Pivot (LLM goals only, skip if already in-flight)
      if (goal.source === 'llm' && !this.inFlight.has(goal.id) && shouldPivot(goal.progress, goal.pivot_count, ticksElapsed)) {
        this.inFlight.add(goal.id);
        await this.attemptPivot(goal, agent, currentTick).finally(() => this.inFlight.delete(goal.id));
      }
    }
  }

  private async attemptPivot(goal: any, agent: any, currentTick: number): Promise<void> {
    const recentMems = db.select({ description: memories.description }).from(memories)
      .where(and(eq(memories.agent_id, agent.id), eq(memories.is_active, 1)))
      .orderBy(desc(memories.created_at)).limit(10).all();

    const personality = getEffectivePersonality(agent.id);
    if (!personality) return;
    const daysActive = Math.max(1, Math.floor((currentTick - goal.created_at) / 1440));

    const prompt = buildPivotPrompt({
      name: agent.name, personality,
      goalDescription: goal.description ?? goal.type,
      strategy: goal.strategy ?? '', progress: goal.progress,
      daysActive, recentMemories: recentMems.map(m => m.description),
    });

    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.CHAT_MODEL, system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        priority: 'low',
        options: { temperature: 0.7, num_predict: 200 },
      });

      const result = parsePivotResult(response.text);
      if (!result) {
        this.abandonGoal(goal, agent.id, 'could not find a new approach', currentTick);
        return;
      }

      const updates: Record<string, unknown> = { strategy: result.new_strategy, pivot_count: 1 };
      if (result.new_category_hint) {
        const mapped = this.mapper.mapCategory(result.new_category_hint);
        updates.mapped_interactions = JSON.stringify(mapped.interactions);
        updates.type = mapped.type;
      }
      db.update(goals).set(updates).where(eq(goals.id, goal.id)).run();

      simEvents.emit('goal:pivoted', {
        agentId: agent.id,
        description: goal.description ?? goal.type,
        newStrategy: result.new_strategy,
      });
    } catch (error: any) {
      const errMsg = error?.message ?? String(error);
      logActivity({ type: 'error', templateData: { system: 'goals', message: `Pivot LLM failed for ${agent.name}: ${errMsg}` } });
      this.abandonGoal(goal, agent.id, 'failed to find alternative approach', currentTick);
    }
  }

  private abandonGoal(goal: any, agentId: number, reason: string, currentTick: number): void {
    db.update(goals).set({ status: 'abandoned' }).where(eq(goals.id, goal.id)).run();

    simEvents.emit('goal:abandoned', {
      agentId, goalType: goal.type,
      description: goal.description ?? goal.type, reason,
    });

    if (goal.pivot_count > 0) {
      const personality = getEffectivePersonality(agentId);
      if (!personality) return;
      const daysActive = Math.max(1, Math.floor((currentTick - goal.created_at) / 1440));
      const importance = computeEmotionalImportance(goal.priority, daysActive, personality);
      if (importance > 0.6) {
        simEvents.emit('goal:emotional_failure', { agentId, importance, personality });
      }
    }
  }
}
