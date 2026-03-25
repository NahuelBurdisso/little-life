import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { conversations } from '../db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';

export const conversationsRouter = router({
  getActive: publicProcedure.query(() => {
    return db
      .select()
      .from(conversations)
      .where(eq(conversations.status, 'active'))
      .all();
  }),

  getOne: publicProcedure
    .input(z.object({ conversationId: z.number() }))
    .query(({ input }) => {
      return db
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .get() ?? null;
    }),

  getHistory: publicProcedure
    .input(
      z.object({
        agentId: z.number(),
        limit: z.number().optional().default(10),
      })
    )
    .query(({ input }) => {
      return db
        .select()
        .from(conversations)
        .where(
          sql`${conversations.status} = 'ended' AND EXISTS (SELECT 1 FROM json_each(${conversations.participants}) WHERE value = ${input.agentId})`
        )
        .orderBy(desc(conversations.started_at))
        .limit(input.limit)
        .all();
    }),

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('conversations', opts.signal)) {
      yield data;
    }
  }),
});
