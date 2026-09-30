import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { relationships, agents } from '../db/schema';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { getCliques } from '../lib/cliques';
import { getPairDossier } from '../lib/pairDossier';
import { emitter } from '../engine/emitter';
import { RELATIONSHIPS_CHANNEL } from '../engine/relationshipsChannel';

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

  /**
   * Everything about one pair: both directions, the events that shaped it, the
   * last conversations, the secrets around it, its story arcs and a
   * friendship/romance history. Oriented to the arguments (`a` first). Null when
   * either id isn't a resident. The dossier modal refetches it off the same
   * agents channel as the graph (`useAgents`).
   */
  getPair: publicProcedure
    .input(z.object({ a: z.number().int(), b: z.number().int() }))
    .query(({ input }) => getPairDossier(input.a, input.b)),

  /** Social groups derived from the friendship graph. Memoised server-side. */
  getCliques: publicProcedure.query(() => getCliques()),

  /**
   * Fires when the relationships table was written (engine/relationshipsChannel.ts).
   * The graph, the pair dossier and the canvas tension lines refetch on this,
   * not on every agents.all flush.
   */
  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate(RELATIONSHIPS_CHANNEL, opts.signal)) {
      yield data;
    }
  }),
});
