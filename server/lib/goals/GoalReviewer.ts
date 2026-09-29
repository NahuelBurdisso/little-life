import { db } from '../../db';
import { agents, aspirations, economy, goals, memories, relationships, relationshipEvents, worldState } from '../../db/schema';
import { callOllamaChat } from '../../ai/ollama';
import { getEffectivePersonality } from '../states';
import { logActivity } from '../activityLogger';
import { simEvents } from '../simEvents';
import { GoalMapper } from './GoalMapper';
import { parseGoalReview, parseAmbitionGeneration } from './goalParser';
import { buildGoalReviewPrompt, buildAmbitionGenerationPrompt } from './goalPrompts';
import type { GoalReviewAction } from './types';
import { MAX_LLM_GOALS } from './types';
import { CONFIG } from '../constants';
import { GOAL_REGISTRY } from '../../data/goalRegistry';
import { and, desc, eq, gt, or } from 'drizzle-orm';
import { compareOp, getRelationship, getRelField } from './relationshipConditions';
import { gameMinutesToMs } from '../worldClock';
import { currentWorldEpoch, isStaleWorldEpoch } from '../worldEpoch';

const MINUTES_PER_DAY = 1440;

/**
 * How long a finished goal blocks the review from re-adopting the same
 * (type, target). Several days, not one: the morning review runs daily, so a
 * one-day window would just move the churn to every other morning.
 */
const RECREATE_COOLDOWN_MINUTES = 3 * MINUTES_PER_DAY;

/**
 * Did something turn the agent against the target since game minute
 * `sinceMinutes`? A negative relationship event (their own friendship delta < 0,
 * or a sour exchange).
 *
 * CLOCK: relationship events carry WALL-CLOCK ms, goals carry GAME MINUTES. The
 * goal's completion is placed on the wall clock by its game-minute distance at
 * the current speed (`gameMinutesToMs`). Pauses make that estimate later than
 * the real completion, which can only miss a grievance (keep a goal blocked),
 * never invent one.
 */
function negativeEventSince(agentId: number, targetId: number, sinceMinutes: number, nowMinutes: number): boolean {
  const world = db.select({ tick_speed: worldState.tick_speed }).from(worldState).get();
  const sinceMs = Date.now() - gameMinutesToMs(nowMinutes - sinceMinutes, world?.tick_speed ?? 1);
  const [a, b] = agentId < targetId ? [agentId, targetId] : [targetId, agentId];
  const isA = a === agentId;
  return db.select().from(relationshipEvents)
    .where(and(eq(relationshipEvents.agent_a, a), eq(relationshipEvents.agent_b, b), gt(relationshipEvents.timestamp, sinceMs)))
    .all()
    .some((e) => (isA ? e.friendship_delta_ab : e.friendship_delta_ba) < 0 || e.sentiment < -0.3);
}

/**
 * Would this goal be dead on arrival? The morning review asks the LLM for fresh
 * goals every day, and a warm agent keeps proposing "befriend <best friend>".
 * `befriend` auto-completes at friendship > 50, so goalsTick closed it the very
 * next tick and the next morning recreated it — a daily created→completed pair
 * in the feed for every close friendship.
 *
 * Skips the goal when:
 *  - an `auto` relationship rule in its registry entry already holds (it would
 *    complete/fail/abandon on the first goals tick), or
 *  - the agent already has the same type for the same target active, or
 *    COMPLETED one within RECREATE_COOLDOWN_MINUTES (3 game days). Abandoned/failed goals don't
 *    block: giving up isn't having done it. A hostile goal (revenge) is allowed
 *    again inside the window if the target has wronged them since.
 *  `custom` goals are exempt from the recency rule: their type says nothing
 *  about their content.
 */
export function isRedundantGoal(
  agentId: number,
  type: string,
  targetId: number | null,
  /** Game minutes, the clock `goals.completed_at` is stamped in. */
  nowMinutes: number,
): boolean {
  if (targetId == null) return false;

  const def = GOAL_REGISTRY[type];
  if (def) {
    const rel = getRelationship(agentId, targetId);
    if (rel) {
      const isA = rel.agent_a === agentId;
      for (const rule of def.abandonment) {
        if (!rule.auto || !rule.condition.startsWith('relationship.')) continue;
        const [lhs, op, raw] = rule.condition.split(' ');
        if (compareOp(getRelField(rel, lhs.split('.')[1], isA), op, parseFloat(raw))) return true;
      }
    }
  }

  if (type === 'custom') return false;
  const sameGoals = db.select().from(goals)
    .where(and(eq(goals.agent_id, agentId), eq(goals.type, type), eq(goals.target_id, targetId)))
    .all();
  if (sameGoals.some((g) => g.status === 'active')) return true;

  const lastCompleted = Math.max(
    -Infinity,
    ...sameGoals.filter((g) => g.status === 'completed' && g.completed_at != null).map((g) => g.completed_at!),
  );
  if (nowMinutes - lastCompleted >= RECREATE_COOLDOWN_MINUTES) return false;
  if (def?.category === 'hostile' && negativeEventSince(agentId, targetId, lastCompleted, nowMinutes)) return false;
  return true;
}

// ─── GoalReviewer ─────────────────────────────────────────────────────────────

export class GoalReviewer {
  private mapper = new GoalMapper();
  private agentCache: { data: { id: number; name: string }[]; at: number } | null = null;
  private reviewedToday = new Set<number>(); // agent IDs already reviewed this day
  private lastDay = -1;

  /**
   * Drop cached world state for a world replace. `agentCache.at` is a game-minute
   * stamp and a new world's clock can start earlier, so a surviving entry makes
   * `nowMinutes - at` negative — permanently under the 100-minute TTL, which feeds
   * the PREVIOUS world's agent id/name list into goal-review prompts and goal target
   * mapping. `reviewedToday`/`lastDay` self-heal on the next day change, but if the
   * new world happens to start on the same day number they would suppress the first
   * review for every reused agent id, so they are reset here too.
   */
  clear(): void {
    this.agentCache = null;
    this.reviewedToday.clear();
    this.lastDay = -1;
  }

  private getAllAgents(nowMinutes: number): { id: number; name: string }[] {
    if (this.agentCache && nowMinutes - this.agentCache.at < 100) {
      return this.agentCache.data;
    }
    const data = db.select({ id: agents.id, name: agents.name }).from(agents).all();
    this.agentCache = { data, at: nowMinutes };
    return data;
  }

  // ─── Main entry point ───────────────────────────────────────────────────────

  async review(agentId: number, nowMinutes: number, currentDay: number): Promise<void> {
    // Only review each agent once per day
    if (currentDay !== this.lastDay) {
      this.reviewedToday.clear();
      this.lastDay = currentDay;
    }
    if (this.reviewedToday.has(agentId)) return;
    this.reviewedToday.add(agentId);
    // Everything below writes by agent/goal id after awaiting the LLM; ids
    // restart after a world swap, so each write-back first checks the world
    // is still the one this review started in.
    const worldEpoch = currentWorldEpoch();

    try {
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .get();

      if (!agent) return;

      const personality = getEffectivePersonality(agentId);
      if (!personality) return;

      // Ensure agent has a life ambition
      const ambition = await this.ensureAmbition(agentId, agent, personality, nowMinutes);
      if (isStaleWorldEpoch(worldEpoch)) return;

      // Load context
      const activeGoals = db
        .select()
        .from(goals)
        .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active')))
        .all();

      const llmGoals = activeGoals.filter(g => g.source === 'llm');

      // Bounded in SQL. `.all().slice(-10)` pulled every active memory the agent
      // has into JS to throw all but ten away, and took them in rowid order
      // rather than by recency. Reversed after the fetch so the prompt still
      // reads oldest → newest.
      const recentMemories = db
        .select({ description: memories.description })
        .from(memories)
        .where(and(eq(memories.agent_id, agentId), eq(memories.is_active, 1)))
        .orderBy(desc(memories.created_at))
        .limit(10)
        .all()
        .reverse()
        .map(m => m.description);

      const econ = db
        .select()
        .from(economy)
        .where(eq(economy.agent_id, agentId))
        .get();

      // Relationships — handle both directions (agent_a < agent_b constraint)
      const rels = db
        .select()
        .from(relationships)
        .where(
          or(
            eq(relationships.agent_a, agentId),
            eq(relationships.agent_b, agentId)
          )
        )
        .all();

      const allAgents = this.getAllAgents(nowMinutes);
      const agentNameMap = new Map(allAgents.map(a => [a.id, a.name]));

      const relationshipHighlights = rels
        .filter(r => r.familiarity > 20 || r.interaction_count > 3)
        .slice(0, 5)
        .map(r => {
          const isA = r.agent_a === agentId;
          const otherId = isA ? r.agent_b : r.agent_a;
          const otherName = agentNameMap.get(otherId) ?? `Agent ${otherId}`;
          // Use directional friendship/romance fields
          const friendship = isA ? r.friendship_ab : r.friendship_ba;
          const romance = isA ? r.romance_ab : r.romance_ba;
          const parts: string[] = [`${otherName}: friendship=${Math.round(friendship)}`];
          if (romance > 10) parts.push(`romance=${Math.round(romance)}`);
          if (r.tags.length > 0) parts.push(`tags=[${r.tags.join(', ')}]`);
          return parts.join(', ');
        });

      // Build prompt
      const activeGoalSummaries = llmGoals.map(g => ({
        id: g.id,
        description: g.description ?? g.type,
        strategy: g.strategy ?? '',
        progress: g.progress,
        daysActive: Math.floor((nowMinutes - g.created_at) / MINUTES_PER_DAY),
      }));

      const prompt = buildGoalReviewPrompt({
        name: agent.name,
        personality,
        traits: agent.traits,
        ambition: ambition ? { description: ambition.description ?? ambition.type, type: ambition.type } : null,
        activeGoals: activeGoalSummaries,
        recentMemories,
        relationshipHighlights,
        money: econ?.money ?? 0,
        job: econ?.job ?? null,
        dayNumber: currentDay,
        openSlots: Math.max(0, MAX_LLM_GOALS - llmGoals.length),
        otherAgents: allAgents.filter((a) => a.id !== agentId).map((a) => a.name),
      });

      // Single LLM call
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL,
        purpose: 'goal.review',
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        priority: 'low',
        format: prompt.format,
        // Decisions, not dialogue: 0.8 made the structure itself wobble.
        options: { temperature: 0.6, top_p: CONFIG.AI.CHAT_TOP_P, num_predict: 700 },
      });

      if (isStaleWorldEpoch(worldEpoch)) return;
      const reviewResult = parseGoalReview(response.text);
      if (!reviewResult) {
        console.warn(`[GoalReviewer] Failed to parse review response for agent ${agentId}`);
        return;
      }

      // Process ambition shift
      if (reviewResult.ambition !== 'keep' && ambition) {
        const shift = reviewResult.ambition;
        db.update(aspirations)
          .set({
            status: 'shifted',
            shifted_at: nowMinutes,
            shifted_to: shift.category,
            shifted_reason: shift.reason,
          })
          .where(and(eq(aspirations.agent_id, agentId), eq(aspirations.id, ambition.id)))
          .run();

        db.insert(aspirations).values({
          agent_id: agentId,
          type: shift.category,
          intensity: 0.7,
          status: 'active',
          adopted_at: nowMinutes,
          trigger: 'morning_review',
          description: shift.shift,
        }).run();

        simEvents.emit('goal:ambition_shifted', {
          agentId,
          agentName: agent.name,
          from: ambition.description ?? ambition.type,
          to: shift.shift,
          reason: shift.reason,
        });

        logActivity({
          type: 'goal_ambition_shifted',
          initiator: agentId,
          templateData: { name: agent.name, from: ambition.type, to: shift.category },
        });
      }

      // Process goal reviews
      for (const reviewAction of reviewResult.reviews) {
        if (isStaleWorldEpoch(worldEpoch)) return;
        await this.processReview(reviewAction, agentId, nowMinutes);
      }
      if (isStaleWorldEpoch(worldEpoch)) return;

      // Create new goals (up to MAX_LLM_GOALS)
      const currentLlmGoalCount = db
        .select()
        .from(goals)
        .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active'), eq(goals.source, 'llm')))
        .all()
        .length;

      const slotsAvailable = MAX_LLM_GOALS - currentLlmGoalCount;
      const newGoalsToCreate = reviewResult.new_goals.slice(0, Math.max(0, slotsAvailable));

      for (const ng of newGoalsToCreate) {
        const mapped = this.mapper.map(ng, allAgents);
        if (isRedundantGoal(agentId, mapped.type, mapped.target_id, nowMinutes)) continue;

        const inserted = db.insert(goals).values({
          agent_id: agentId,
          type: mapped.type,
          target_id: mapped.target_id ?? undefined,
          motivation: ng.description,
          priority: ng.priority,
          progress: 0,
          status: 'active',
          created_at: nowMinutes,
          description: ng.description,
          strategy: ng.strategy,
          mapped_interactions: JSON.stringify(mapped.mapped_interactions),
          pivot_count: 0,
          source: 'llm',
        }).returning({ id: goals.id }).get();

        if (inserted) {
          simEvents.emit('goal:created', {
            agentId,
            agentName: agent.name,
            goalId: inserted.id,
            description: ng.description,
            strategy: ng.strategy,
          });

          logActivity({
            type: 'goal_created',
            initiator: agentId,
            templateData: { name: agent.name, goal: ng.description },
          });
        }
      }
    } catch (err) {
      console.error(`[GoalReviewer] Error reviewing goals for agent ${agentId}:`, err);
    }
  }

  // ─── Process a single goal review action ───────────────────────────────────

  async processReview(review: GoalReviewAction, agentId: number, nowMinutes: number): Promise<void> {
    const goal = db
      .select()
      .from(goals)
      .where(and(eq(goals.id, review.goal_id), eq(goals.agent_id, agentId)))
      .get();

    if (!goal) return;

    const agent = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).get();
    const agentName = agent?.name ?? `Agent ${agentId}`;

    if (review.action === 'continue') {
      // No DB change needed — goal stays active as-is
      return;
    }

    if (review.action === 'adjust' && review.new_strategy) {
      db.update(goals)
        .set({ strategy: review.new_strategy })
        .where(eq(goals.id, review.goal_id))
        .run();
    }

    if (review.action === 'abandon') {
      db.update(goals)
        .set({ status: 'abandoned', completed_at: nowMinutes })
        .where(eq(goals.id, review.goal_id))
        .run();

      simEvents.emit('goal:abandoned', {
        agentId,
        agentName,
        goalId: review.goal_id,
        description: goal.description ?? goal.type,
        reason: review.reason,
      });

      logActivity({
        type: 'goal_abandoned',
        initiator: agentId,
        templateData: { name: agentName, goal: goal.description ?? goal.type },
      });
    }
  }

  // ─── Generate initial life ambition ────────────────────────────────────────

  async generateInitialAmbition(
    agentId: number,
    agent: typeof agents.$inferSelect,
    nowMinutes: number
  ): Promise<{ id: number; type: string; description: string | null } | null> {
    const personality = getEffectivePersonality(agentId);
    if (!personality) return null;

    // Bounded in SQL — see the note on the same pattern in reviewGoals().
    const recentMemories = db
      .select({ description: memories.description })
      .from(memories)
      .where(and(eq(memories.agent_id, agentId), eq(memories.is_active, 1)))
      .orderBy(desc(memories.created_at))
      .limit(6)
      .all()
      .reverse()
      .map(m => m.description);

    const econ = db
      .select()
      .from(economy)
      .where(eq(economy.agent_id, agentId))
      .get();

    const rels = db
      .select()
      .from(relationships)
      .where(or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId)))
      .all();

    const allAgents = this.getAllAgents(nowMinutes);
    const agentNameMap = new Map(allAgents.map(a => [a.id, a.name]));

    const relationshipHighlights = rels
      .filter(r => r.familiarity > 10)
      .slice(0, 4)
      .map(r => {
        const isA = r.agent_a === agentId;
        const otherId = isA ? r.agent_b : r.agent_a;
        const otherName = agentNameMap.get(otherId) ?? `Agent ${otherId}`;
        const friendship = isA ? r.friendship_ab : r.friendship_ba;
        return `${otherName}: friendship=${Math.round(friendship)}`;
      });

    const prompt = buildAmbitionGenerationPrompt({
      name: agent.name,
      personality,
      traits: agent.traits,
      recentMemories,
      money: econ?.money ?? 0,
      job: econ?.job ?? null,
      relationshipHighlights,
    });

    const worldEpoch = currentWorldEpoch();
    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL,
        purpose: 'goal.ambition',
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        priority: 'low',
        format: prompt.format,
        options: { temperature: CONFIG.AI.CHAT_TEMPERATURE, top_p: CONFIG.AI.CHAT_TOP_P, num_predict: 250 },
      });

      // World swapped while the model answered: the aspiration would go to
      // whoever holds this agent id now.
      if (isStaleWorldEpoch(worldEpoch)) return null;
      const parsed = parseAmbitionGeneration(response.text);
      if (!parsed) {
        console.warn(`[GoalReviewer] Failed to parse ambition generation for agent ${agentId}`);
        return null;
      }

      const inserted = db.insert(aspirations).values({
        agent_id: agentId,
        type: parsed.category,
        intensity: 0.7,
        status: 'active',
        adopted_at: nowMinutes,
        trigger: 'initial_generation',
        description: parsed.description,
      }).returning({ id: aspirations.id }).get();

      if (!inserted) return null;

      logActivity({
        type: 'goal_ambition_generated',
        initiator: agentId,
        templateData: { name: agent.name, ambition: parsed.description },
      });
      // A first ambition can name a trade as surely as a changed one
      // (lib/vacancies.ts turns either into a career move).
      simEvents.emit('goal:ambition_generated', { agentId, agentName: agent.name, description: parsed.description });

      return { id: inserted.id, type: parsed.category, description: parsed.description };
    } catch (err) {
      console.error(`[GoalReviewer] Error generating initial ambition for agent ${agentId}:`, err);
      return null;
    }
  }

  // ─── Private: ensure agent has an active ambition ──────────────────────────

  private async ensureAmbition(
    agentId: number,
    agent: typeof agents.$inferSelect,
    _personality: ReturnType<typeof getEffectivePersonality>,
    nowMinutes: number
  ): Promise<{ id: number; type: string; description: string | null } | null> {
    const existing = db
      .select()
      .from(aspirations)
      .where(and(eq(aspirations.agent_id, agentId), eq(aspirations.status, 'active')))
      .get();

    if (existing) {
      return { id: existing.id, type: existing.type, description: existing.description };
    }

    return this.generateInitialAmbition(agentId, agent, nowMinutes);
  }
}
