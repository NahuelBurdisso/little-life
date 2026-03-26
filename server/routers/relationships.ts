import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { relationships, agents } from '../db/schema';
import { eq, or, and } from 'drizzle-orm';
import { z } from 'zod';

export const relationshipsRouter = router({
  getOne: publicProcedure
    .input(z.object({ agentA: z.number(), agentB: z.number() }))
    .query(({ input }) => {
      // Normalize ordering so agentA < agentB for consistent lookups
      const [a, b] =
        input.agentA < input.agentB
          ? [input.agentA, input.agentB]
          : [input.agentB, input.agentA];

      return db
        .select()
        .from(relationships)
        .where(
          and(
            eq(relationships.agent_a, a),
            eq(relationships.agent_b, b)
          )
        )
        .get() ?? null;
    }),

  getAgentRelationships: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      const rows = db
        .select()
        .from(relationships)
        .where(
          or(
            eq(relationships.agent_a, input.agentId),
            eq(relationships.agent_b, input.agentId)
          )
        )
        .all();

      // Fetch the other agent's name for each relationship
      return rows.map((rel) => {
        const otherId =
          rel.agent_a === input.agentId ? rel.agent_b : rel.agent_a;
        const otherAgent = db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(eq(agents.id, otherId))
          .get();
        return { relationship: rel, otherAgent: otherAgent ?? null };
      });
    }),

  getGraph: publicProcedure.query(() => {
    return db.select().from(relationships).all();
  }),
});
