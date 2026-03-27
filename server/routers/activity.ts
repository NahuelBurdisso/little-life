import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { activityLog } from '../db/schema';
import { and, desc, eq, gte, lt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';

export const activityRouter = router({
  getRecent: publicProcedure
    .input(
      z.object({
        categories: z.array(z.string()).optional(),
        minImportance: z.number().optional(),
        cursor: z.number().optional(),
        limit: z.number().optional().default(30),
        agentId: z.number().optional(),
      }).optional()
    )
    .query(({ input }) => {
      const conditions = [];

      if (input?.categories?.length) {
        conditions.push(inArray(activityLog.category, input.categories));
      }
      if (input?.minImportance != null) {
        conditions.push(gte(activityLog.importance, input.minImportance));
      }
      if (input?.cursor) {
        conditions.push(lt(activityLog.id, input.cursor));
      }
      if (input?.agentId) {
        conditions.push(eq(activityLog.initiator_id, input.agentId));
      }

      const query = conditions.length
        ? db.select().from(activityLog).where(and(...conditions))
        : db.select().from(activityLog);

      return query
        .orderBy(desc(activityLog.real_timestamp))
        .limit(input?.limit ?? 30)
        .all();
    }),

  getByType: publicProcedure
    .input(
      z.object({
        type: z.string(),
        limit: z.number().optional().default(20),
      })
    )
    .query(({ input }) => {
      return db
        .select()
        .from(activityLog)
        .where(eq(activityLog.type, input.type))
        .orderBy(desc(activityLog.real_timestamp))
        .limit(input.limit)
        .all();
    }),

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('activity.all', opts.signal)) {
      yield data;
    }
  }),
});
