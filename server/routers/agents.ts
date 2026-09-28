import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { agents, needs, economy, agentStates, goals, aspirations, relationships, memories, conversations } from '../db/schema';
import { eq, and, or, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';
import { getReputation, getReputationLabel } from '../lib/reputationEngine';
import { getAgentHobbies } from '../lib/hobbyEngine';

export const agentsRouter = router({
  getActive: publicProcedure.query(() => {
    const activeAgents = db
      .select()
      .from(agents)
      .where(eq(agents.is_active, true))
      .all();

    const allNeeds = db.select().from(needs).all();
    const allStates = db
      .select({
        agent_id: agentStates.agent_id,
        type: agentStates.type,
        severity: agentStates.severity,
        target_agent_id: agentStates.target_agent_id,
        metadata: agentStates.metadata,
      })
      .from(agentStates)
      .all();

    const needsMap = new Map(allNeeds.map(n => [n.agent_id, n]));
    const statesMap = new Map<number, typeof allStates>();
    for (const s of allStates) {
      const arr = statesMap.get(s.agent_id) ?? [];
      arr.push(s);
      statesMap.set(s.agent_id, arr);
    }

    return activeAgents.map((agent) => {
      const rep = getReputation(agent.id);
      return {
        ...agent,
        needs: needsMap.get(agent.id) ?? null,
        activeStates: statesMap.get(agent.id) ?? [],
        reputation: { score: rep, label: getReputationLabel(rep) },
        hobbies: getAgentHobbies(agent.id),
      };
    });
  }),

  getAgentThoughts: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      const activeGoals = db
        .select()
        .from(goals)
        .where(and(eq(goals.agent_id, input.agentId), eq(goals.status, 'active')))
        .all();

      const ambition = db
        .select()
        .from(aspirations)
        .where(and(eq(aspirations.agent_id, input.agentId), eq(aspirations.status, 'active')))
        .get() ?? null;

      return { goals: activeGoals, ambition };
    }),

  /**
   * Everything the agent panel shows, in one round trip. The panel used to open
   * five separate queries for the same agent, all of which refetch together on
   * every agent update.
   */
  getAgentSummary: publicProcedure
    .input(
      z.object({
        agentId: z.number(),
        memoryLimit: z.number().optional().default(20),
        conversationLimit: z.number().optional().default(5),
      }),
    )
    .query(({ input }) => {
      const agent = db.select().from(agents).where(eq(agents.id, input.agentId)).get();
      if (!agent) return null;

      const agentNeeds = db.select().from(needs).where(eq(needs.agent_id, input.agentId)).get();
      const agentEcon = db.select().from(economy).where(eq(economy.agent_id, input.agentId)).get();
      const states = db
        .select()
        .from(agentStates)
        .where(eq(agentStates.agent_id, input.agentId))
        .all();

      const rels = db
        .select()
        .from(relationships)
        .where(or(eq(relationships.agent_a, input.agentId), eq(relationships.agent_b, input.agentId)))
        .all();
      const nameOf = new Map(
        db.select({ id: agents.id, name: agents.name }).from(agents).all().map((a) => [a.id, a.name]),
      );
      const relationshipRows = rels.map((rel) => {
        const otherId = rel.agent_a === input.agentId ? rel.agent_b : rel.agent_a;
        const name = nameOf.get(otherId);
        return {
          relationship: rel,
          otherAgent: name != null ? { id: otherId, name } : null,
        };
      });

      // Projected, not `select()`: the row carries a 4 KB `embedding` blob that
      // no client field reads, and it was being serialised over the WebSocket on
      // every agent-detail open. `is_active` is filtered too — without it the
      // panel kept showing memories the consolidator had already retired, which
      // then crowded out the summary that replaced them.
      const recentMemories = db
        .select({
          id: memories.id,
          description: memories.description,
          type: memories.type,
          importance: memories.importance,
          emotional_valence: memories.emotional_valence,
          created_at: memories.created_at,
          metadata: memories.metadata,
        })
        .from(memories)
        .where(and(eq(memories.agent_id, input.agentId), eq(memories.is_active, 1)))
        .orderBy(desc(memories.created_at))
        .limit(input.memoryLimit)
        .all();

      const conversationHistory = db
        .select()
        .from(conversations)
        .where(
          sql`${conversations.status} = 'ended' AND EXISTS (SELECT 1 FROM json_each(${conversations.participants}) WHERE value = ${input.agentId})`,
        )
        .orderBy(desc(conversations.started_at))
        .limit(input.conversationLimit)
        .all();

      const rep = getReputation(input.agentId);
      return {
        agent,
        needs: agentNeeds ?? null,
        economy: agentEcon ?? null,
        reputation: { score: rep, label: getReputationLabel(rep) },
        hobbies: getAgentHobbies(input.agentId),
        states,
        relationships: relationshipRows,
        memories: recentMemories,
        conversationHistory,
      };
    }),

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('agents.all', opts.signal)) {
      yield data;
    }
  }),
});
