import { db } from '../../db';
import { agents, aspirations, economy, goals, memories, relationships } from '../../db/schema';
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
import { and, desc, eq, or } from 'drizzle-orm';

const TICKS_PER_DAY = 1440;

// ─── GoalReviewer ─────────────────────────────────────────────────────────────

export class GoalReviewer {
  private mapper = new GoalMapper();
  private agentCache: { data: { id: number; name: string }[]; tick: number } | null = null;
  private reviewedToday = new Set<number>(); // agent IDs already reviewed this day
  private lastDay = -1;

  /**
   * Drop cached world state for a world replace. `agentCache.tick` is a TICK stamp
   * and `totalTicks` restarts at 0, so a surviving entry makes
   * `currentTick - tick` negative — permanently under the 100-tick TTL, which feeds
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

  private getAllAgents(currentTick: number): { id: number; name: string }[] {
    if (this.agentCache && currentTick - this.agentCache.tick < 100) {
      return this.agentCache.data;
    }
    const data = db.select({ id: agents.id, name: agents.name }).from(agents).all();
    this.agentCache = { data, tick: currentTick };
    return data;
  }

  // ─── Main entry point ───────────────────────────────────────────────────────

  async review(agentId: number, currentTick: number, currentDay: number): Promise<void> {
    // Only review each agent once per day
    if (currentDay !== this.lastDay) {
      this.reviewedToday.clear();
      this.lastDay = currentDay;
    }
    if (this.reviewedToday.has(agentId)) return;
    this.reviewedToday.add(agentId);

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
      const ambition = await this.ensureAmbition(agentId, agent, personality, currentTick);

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

      const allAgents = this.getAllAgents(currentTick);
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
        daysActive: Math.floor((currentTick - g.created_at) / TICKS_PER_DAY),
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
      });

      // Single LLM call
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        priority: 'low',
        options: {
          temperature: CONFIG.AI.CHAT_TEMPERATURE,
          top_p: CONFIG.AI.CHAT_TOP_P,
          num_predict: 600,
        },
      });

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
            shifted_at: currentTick,
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
          adopted_at: currentTick,
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
        await this.processReview(reviewAction, agentId, currentTick);
      }

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

        const inserted = db.insert(goals).values({
          agent_id: agentId,
          type: mapped.type,
          target_id: mapped.target_id ?? undefined,
          motivation: ng.description,
          priority: ng.priority,
          progress: 0,
          status: 'active',
          created_at: currentTick,
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

  async processReview(review: GoalReviewAction, agentId: number, currentTick: number): Promise<void> {
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
        .set({ status: 'abandoned', completed_at: currentTick })
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
    currentTick: number
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

    const allAgents = this.getAllAgents(currentTick);
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

    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.LIGHT_MODEL,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        priority: 'low',
        options: {
          temperature: CONFIG.AI.CHAT_TEMPERATURE,
          top_p: CONFIG.AI.CHAT_TOP_P,
          num_predict: 200,
        },
      });

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
        adopted_at: currentTick,
        trigger: 'initial_generation',
        description: parsed.description,
      }).returning({ id: aspirations.id }).get();

      if (!inserted) return null;

      simEvents.emit('goal:ambition_generated', {
        agentId,
        agentName: agent.name,
        ambition: parsed.description,
        category: parsed.category,
      });

      logActivity({
        type: 'goal_ambition_generated',
        initiator: agentId,
        templateData: { name: agent.name, ambition: parsed.description },
      });

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
    currentTick: number
  ): Promise<{ id: number; type: string; description: string | null } | null> {
    const existing = db
      .select()
      .from(aspirations)
      .where(and(eq(aspirations.agent_id, agentId), eq(aspirations.status, 'active')))
      .get();

    if (existing) {
      return { id: existing.id, type: existing.type, description: existing.description };
    }

    return this.generateInitialAmbition(agentId, agent, currentTick);
  }
}
