import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { agents, needs, economy, agentStates, goals, aspirations, relationships, memories, shared_knowledge, activityLog } from '../db/schema';
import { eq, and, or, desc, inArray } from 'drizzle-orm';
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

  getAgent: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      return db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .get() ?? null;
    }),

  getFull: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      const agent = db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .get();
      if (!agent) return null;

      const agentNeeds = db
        .select()
        .from(needs)
        .where(eq(needs.agent_id, input.agentId))
        .get();

      const agentEconomy = db
        .select()
        .from(economy)
        .where(eq(economy.agent_id, input.agentId))
        .get();

      return {
        agent,
        needs: agentNeeds ?? null,
        economy: agentEconomy ?? null,
      };
    }),

  getStates: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      return db
        .select()
        .from(agentStates)
        .where(eq(agentStates.agent_id, input.agentId))
        .all();
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

  /** Complete agent profile — everything about an agent in one call for focus mode */
  getAgentSummary: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      const agent = db.select().from(agents).where(eq(agents.id, input.agentId)).get();
      if (!agent) return null;

      const agentNeeds = db.select().from(needs).where(eq(needs.agent_id, input.agentId)).get();
      const agentEcon = db.select().from(economy).where(eq(economy.agent_id, input.agentId)).get();
      const states = db.select().from(agentStates).where(eq(agentStates.agent_id, input.agentId)).all();
      const activeGoals = db.select().from(goals)
        .where(and(eq(goals.agent_id, input.agentId), eq(goals.status, 'active'))).all();
      const ambition = db.select().from(aspirations)
        .where(and(eq(aspirations.agent_id, input.agentId), eq(aspirations.status, 'active'))).get();

      // Key relationships (friendship > 30 or romance > 15 or trust < -30)
      const rels = db.select().from(relationships)
        .where(or(eq(relationships.agent_a, input.agentId), eq(relationships.agent_b, input.agentId))).all();
      const significantRels = rels.filter(r => {
        const isA = r.agent_a === input.agentId;
        const f = isA ? r.friendship_ab : r.friendship_ba;
        const ro = isA ? r.romance_ab : r.romance_ba;
        const t = isA ? r.trust_ab : r.trust_ba;
        return Math.abs(f) > 30 || ro > 15 || t < -30;
      }).map(r => {
        const otherId = r.agent_a === input.agentId ? r.agent_b : r.agent_a;
        const otherAgent = db.select({ name: agents.name }).from(agents).where(eq(agents.id, otherId)).get();
        const isA = r.agent_a === input.agentId;
        return {
          otherName: otherAgent?.name ?? `Agent#${otherId}`,
          friendship: isA ? r.friendship_ab : r.friendship_ba,
          romance: isA ? r.romance_ab : r.romance_ba,
          trust: isA ? r.trust_ab : r.trust_ba,
          status: r.status,
          tags: r.tags,
        };
      });

      // Recent memories (last 10)
      const recentMemories = db.select({ description: memories.description, importance: memories.importance })
        .from(memories)
        .where(and(eq(memories.agent_id, input.agentId), eq(memories.is_active, 1 as any)))
        .orderBy(desc(memories.created_at))
        .limit(10).all();

      // Known secrets about others
      const knownSecrets = db.select().from(shared_knowledge)
        .where(eq(shared_knowledge.is_active, true)).all()
        .filter(f => (f.known_by as number[]).includes(input.agentId) && f.sensitivity >= 2)
        .slice(0, 5);

      // Recent dramatic activity involving this agent
      const recentDrama = db.select().from(activityLog)
        .where(and(
          eq(activityLog.initiator_id, input.agentId),
          inArray(activityLog.category, ['drama', 'relationship', 'goal']),
        ))
        .orderBy(desc(activityLog.real_timestamp))
        .limit(5).all();

      return {
        agent,
        needs: agentNeeds,
        economy: agentEcon,
        states,
        goals: activeGoals,
        ambition,
        relationships: significantRels,
        recentMemories,
        knownSecrets,
        recentDrama,
      };
    }),

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('agents.all', opts.signal)) {
      yield data;
    }
  }),
});
