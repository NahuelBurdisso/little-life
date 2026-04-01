import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { memories } from '../db/schema';
import { eq, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { vectorStore } from '../lib/vectors';

export const memoriesRouter = router({
  getRecent: publicProcedure
    .input(
      z.object({
        agentId: z.number(),
        limit: z.number().optional().default(20),
      })
    )
    .query(({ input }) => {
      return db
        .select()
        .from(memories)
        .where(eq(memories.agent_id, input.agentId))
        .orderBy(desc(memories.created_at))
        .limit(input.limit)
        .all();
    }),

  vectorSearch: publicProcedure
    .input(
      z.object({
        agentId: z.number(),
        embedding: z.array(z.number()),
        limit: z.number().optional().default(6),
      })
    )
    .query(({ input }) => {
      const queryVec = new Float32Array(input.embedding);
      const ids = vectorStore.search(queryVec, input.agentId, input.limit);
      if (ids.length === 0) return [];

      return db
        .select()
        .from(memories)
        .where(inArray(memories.id, ids))
        .all();
    }),
});
