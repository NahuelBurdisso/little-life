import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { agents, needs, economy, agentStates } from '../db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';

export const agentsRouter = router({
  getActive: publicProcedure.query(() => {
    const activeAgents = db
      .select()
      .from(agents)
      .where(eq(agents.is_active, true))
      .all();

    return activeAgents.map((agent) => {
      const agentNeeds = db
        .select()
        .from(needs)
        .where(eq(needs.agent_id, agent.id))
        .get();
      const activeStates = db
        .select({
          type: agentStates.type,
          severity: agentStates.severity,
          target_agent_id: agentStates.target_agent_id,
          metadata: agentStates.metadata,
        })
        .from(agentStates)
        .where(eq(agentStates.agent_id, agent.id))
        .all();
      return { ...agent, needs: agentNeeds ?? null, activeStates };
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

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('agents.all', opts.signal)) {
      yield data;
    }
  }),
});
