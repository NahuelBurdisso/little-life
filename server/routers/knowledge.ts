import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { shared_knowledge, agents } from '../db/schema';
import { and, eq, gte } from 'drizzle-orm';
import { z } from 'zod';

export const knowledgeRouter = router({
  /** What does a specific agent know? */
  getKnownBy: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      return db.select().from(shared_knowledge)
        .where(eq(shared_knowledge.is_active, true))
        .all()
        .filter(f => (f.known_by as number[]).includes(input.agentId));
    }),

  /** What does everyone know about a specific agent? */
  getAboutAgent: publicProcedure
    .input(z.object({ agentId: z.number() }))
    .query(({ input }) => {
      return db.select().from(shared_knowledge)
        .where(eq(shared_knowledge.is_active, true))
        .all()
        .filter(f => f.subject_id === input.agentId || f.target_id === input.agentId);
    }),

  /** All active secrets (sensitivity >= 2) with who knows what */
  getSecretNetwork: publicProcedure.query(() => {
    const allFacts = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.is_active, true), gte(shared_knowledge.sensitivity, 2)))
      .all();

    // Enrich with agent names. Only living agents count: `totalAgents` is the
    // denominator of the spread bar, and removed agents used to inflate it so a
    // fully-spread secret never read as fully spread.
    const allAgents = db.select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.is_active, true))
      .all();
    const nameMap = new Map(allAgents.map(a => [a.id, a.name]));

    return allFacts.map(f => {
      // Drop knowers who are no longer in town, so knownByCount/totalAgents is
      // a ratio over the same population and can never exceed 1.
      const knowers = (f.known_by as number[]).filter(id => nameMap.has(id));
      return {
        id: f.id,
        type: f.type,
        content: f.content,
        sensitivity: f.sensitivity,
        isPublic: f.is_public,
        revealedAt: f.revealed_at,
        subjectName: nameMap.get(f.subject_id) ?? null,
        targetName: f.target_id ? nameMap.get(f.target_id) ?? null : null,
        knownByNames: knowers.map(id => nameMap.get(id)!),
        knownByCount: knowers.length,
        totalAgents: allAgents.length,
      };
    });
  }),
});
