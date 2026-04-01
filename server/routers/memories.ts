import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { memories } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';

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
});
