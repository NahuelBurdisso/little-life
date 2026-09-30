import { db } from '../../db';
import { agents, goals, memories } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import { getEffectivePersonality } from '../states';
import { simEvents } from '../simEvents';
import { logActivity } from '../activityLogger';
import { parsePivotResult } from './goalParser';
import { buildPivotPrompt } from './goalPrompts';
import { PIVOT_THRESHOLD_MINUTES, STALE_ABANDON_MINUTES, STALE_ABANDON_UNTARGETED_MINUTES } from './types';
import { currentWorldEpoch, isStaleWorldEpoch } from '../worldEpoch';
import { mentionsInventedPerson } from '../../helpers/knownPeople';

export function shouldPivot(progress: number, pivotCount: number, minutesElapsed: number): boolean {
  return progress === 0 && pivotCount === 0 && minutesElapsed >= PIVOT_THRESHOLD_MINUTES;
}

export function shouldAbandonStale(progress: number, minutesElapsed: number, targeted = true): boolean {
  return progress === 0 && minutesElapsed >= (targeted ? STALE_ABANDON_MINUTES : STALE_ABANDON_UNTARGETED_MINUTES);
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
  private inFlight = new Set<number>(); // goal IDs currently being pivoted
  private lastEvalAt = new Map<number, number>(); // agentId → game minute last evaluated
  private static EVAL_COOLDOWN = 60; // only evaluate once per game hour

  /**
   * Drop per-agent state for a world replace. `lastEvalAt` holds game-minute stamps
   * and a new world's clock can start earlier, so a surviving stamp makes `nowMinutes - lastAt`
   * negative — permanently below EVAL_COOLDOWN, which silently disables pivoting and
   * stale-goal abandonment for every reused agent id. `inFlight` holds goal ids from
   * the wiped world's id space, which SQLite reuses.
   */
  clear(): void {
    this.lastEvalAt.clear();
    this.inFlight.clear();
  }

  async evaluate(agentId: number, nowMinutes: number): Promise<void> {
    // Cooldown: don't re-evaluate same agent every tick
    const lastAt = this.lastEvalAt.get(agentId) ?? 0;
    if (nowMinutes - lastAt < PivotEvaluator.EVAL_COOLDOWN) return;
    this.lastEvalAt.set(agentId, nowMinutes);
    const activeGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active'))).all();
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent) return;

    for (const goal of activeGoals) {
      const minutesElapsed = nowMinutes - goal.created_at;

      // Dead target check
      if (goal.target_id) {
        const target = db.select({ is_active: agents.is_active }).from(agents).where(eq(agents.id, goal.target_id)).get();
        if (target && !target.is_active) {
          this.abandonGoal(goal, agentId, 'target is no longer around', nowMinutes);
          continue;
        }
      }

      // 3-day stale safety net
      if (shouldAbandonStale(goal.progress, minutesElapsed, goal.target_id != null)) {
        this.abandonGoal(goal, agentId, 'no progress after extended time', nowMinutes);
        continue;
      }

      // Pivot (LLM goals only, skip if already in-flight)
      if (goal.source === 'llm' && !this.inFlight.has(goal.id) && shouldPivot(goal.progress, goal.pivot_count, minutesElapsed)) {
        this.inFlight.add(goal.id);
        await this.attemptPivot(goal, agent, nowMinutes).finally(() => this.inFlight.delete(goal.id));
      }
    }
  }

  private async attemptPivot(goal: any, agent: any, nowMinutes: number): Promise<void> {
    const recentMems = db.select({ description: memories.description }).from(memories)
      .where(and(eq(memories.agent_id, agent.id), eq(memories.is_active, 1)))
      .orderBy(desc(memories.created_at)).limit(10).all();

    const personality = getEffectivePersonality(agent.id);
    if (!personality) return;
    const daysActive = Math.max(1, Math.floor((nowMinutes - goal.created_at) / 1440));

    const prompt = buildPivotPrompt({
      name: agent.name, age: agent.age, personality,
      goalDescription: goal.description ?? goal.type,
      strategy: goal.strategy ?? '', progress: goal.progress,
      daysActive, recentMemories: recentMems.map(m => m.description),
    });

    // Goal ids restart after a world swap: a late answer (or the abort the swap
    // causes, which lands in the catch) must not rewrite or abandon a new
    // world's goal that reuses this id.
    const worldEpoch = currentWorldEpoch();
    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL, system: prompt.system,
        purpose: 'goal.pivot',
        messages: [{ role: 'user', content: prompt.user }],
        priority: 'low',
        format: prompt.format,
        options: { temperature: 0.7, num_predict: 200 },
      });

      if (isStaleWorldEpoch(worldEpoch)) return;
      const result = parsePivotResult(response.text);
      if (!result) {
        this.abandonGoal(goal, agent.id, 'could not find a new approach', nowMinutes);
        return;
      }

      // A strategy about a made-up person keeps the old one (knownPeople.ts).
      const strategy = mentionsInventedPerson(result.new_strategy) ? goal.strategy : result.new_strategy;
      db.update(goals).set({ strategy, pivot_count: 1 }).where(eq(goals.id, goal.id)).run();

      simEvents.emit('goal:pivoted', {
        agentId: agent.id,
        description: goal.description ?? goal.type,
        newStrategy: result.new_strategy,
      });
    } catch (error: any) {
      if (isStaleWorldEpoch(worldEpoch)) return;
      const errMsg = error?.message ?? String(error);
      logActivity({ type: 'error', templateData: { system: 'goals', message: `Pivot LLM failed for ${agent.name}: ${errMsg}` } });
      this.abandonGoal(goal, agent.id, 'failed to find alternative approach', nowMinutes);
    }
  }

  private abandonGoal(goal: any, agentId: number, reason: string, nowMinutes: number): void {
    db.update(goals)
      .set({ status: 'abandoned', completed_at: nowMinutes })
      .where(eq(goals.id, goal.id))
      .run();

    simEvents.emit('goal:abandoned', {
      agentId, goalType: goal.type,
      description: goal.description ?? goal.type, reason,
    });

    if (goal.pivot_count > 0) {
      const personality = getEffectivePersonality(agentId);
      if (!personality) return;
      const daysActive = Math.max(1, Math.floor((nowMinutes - goal.created_at) / 1440));
      const importance = computeEmotionalImportance(goal.priority, daysActive, personality);
      if (importance > 0.6) {
        simEvents.emit('goal:emotional_failure', { agentId, importance, personality });
      }
    }
  }
}
