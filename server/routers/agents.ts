import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { agents, needs, economy, agentStates, goals, aspirations } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';

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

    return activeAgents.map((agent) => ({
      ...agent,
      needs: needsMap.get(agent.id) ?? null,
      activeStates: statesMap.get(agent.id) ?? [],
    }));
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

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('agents.all', opts.signal)) {
      yield data;
    }
  }),
});
