import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { relationships, agents } from '../db/schema';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { getCliques } from '../lib/cliques';

export const relationshipsRouter = router({
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

      // One lookup for every name rather than one query per row: this is the
      // agent panel's polling query, so it ran ~n statements per poll per agent.
      const nameMap = new Map(
        db.select({ id: agents.id, name: agents.name }).from(agents).all()
          .map((a) => [a.id, a] as const),
      );

      return rows.map((rel) => {
        const otherId =
          rel.agent_a === input.agentId ? rel.agent_b : rel.agent_a;
        return { relationship: rel, otherAgent: nameMap.get(otherId) ?? null };
      });
    }),

  getGraph: publicProcedure.query(() => {
    return db.select().from(relationships).all();
  }),

  /** Social groups derived from the friendship graph. Memoised server-side. */
  getCliques: publicProcedure.query(() => getCliques()),
});
