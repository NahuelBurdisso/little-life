import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { activityLog } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';

export const activityRouter = router({
  getRecent: publicProcedure
    .input(
      z.object({
        limit: z.number().optional().default(50),
      })
    )
    .query(({ input }) => {
      return db
        .select()
        .from(activityLog)
        .orderBy(desc(activityLog.timestamp))
        .limit(input.limit)
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
        .orderBy(desc(activityLog.timestamp))
        .limit(input.limit)
        .all();
    }),

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('activity.all', opts.signal)) {
      yield data;
    }
  }),
});
