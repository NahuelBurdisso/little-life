import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { shared_knowledge, agents } from '../db/schema';
import { eq } from 'drizzle-orm';
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
      .where(eq(shared_knowledge.is_active, true))
      .all()
      .filter(f => f.sensitivity >= 2);

    // Enrich with agent names
    const allAgents = db.select({ id: agents.id, name: agents.name }).from(agents).all();
    const nameMap = new Map(allAgents.map(a => [a.id, a.name]));

    return allFacts.map(f => ({
      id: f.id,
      type: f.type,
      content: f.content,
      sensitivity: f.sensitivity,
      subjectName: nameMap.get(f.subject_id) ?? null,
      targetName: f.target_id ? nameMap.get(f.target_id) ?? null : null,
      knownByNames: (f.known_by as number[]).map(id => nameMap.get(id) ?? `Agent#${id}`),
      knownByCount: (f.known_by as number[]).length,
      totalAgents: allAgents.length,
    }));
  }),
});
