import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { activityLog } from '../db/schema';
import { and, desc, eq, gt, gte, lt, inArray } from 'drizzle-orm';
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
        // Ordering on `id` rather than `real_timestamp`: rows are only ever
        // appended by this process, so id order is insert order is timestamp
        // order — but id is the rowid, so SQLite walks the index backwards and
        // stops at `limit` instead of sorting the whole table (there is no
        // index on `real_timestamp`). It also breaks ties deterministically,
        // which matters because a cascade writes its whole chain inside one
        // millisecond.
        .orderBy(desc(activityLog.id))
        .limit(input?.limit ?? 30)
        .all();
    }),

  /** Get dramatic events — high importance drama/relationship/state changes */
  getDramaticEvents: publicProcedure
    .input(z.object({ limit: z.number().optional().default(15) }).optional())
    .query(({ input }) => {
      const dramaticCategories = ['drama', 'relationship', 'aspiration', 'goal'];
      return db
        .select()
        .from(activityLog)
        .where(and(
          inArray(activityLog.category, dramaticCategories),
          gte(activityLog.importance, 0.5),
        ))
        .orderBy(desc(activityLog.id))
        .limit(input?.limit ?? 15)
        .all();
    }),

  /** Alert-worthy events since a given row id, oldest first.
   *  The client passes back the highest id it has already shown, so each row
   *  is turned into a toast exactly once. Without `sinceId` the query returns
   *  nothing but the latest id, which is how a fresh client establishes its
   *  watermark instead of replaying the whole backlog as alerts. */
  getAlerts: publicProcedure
    .input(
      z.object({
        sinceId: z.number().optional(),
        limit: z.number().optional().default(5),
      }).optional(),
    )
    .query(({ input }) => {
      const alertCategories = ['drama', 'world_event', 'aspiration'];

      // The watermark tracks the newest row in the whole table, not the newest
      // alert, or a long run of ordinary rows would be re-scanned every poll.
      const latest = db
        .select({ id: activityLog.id })
        .from(activityLog)
        .orderBy(desc(activityLog.id))
        .limit(1)
        .get();
      const latestId = latest?.id ?? input?.sinceId ?? 0;

      let alerts: (typeof activityLog.$inferSelect)[] = [];
      if (input?.sinceId != null) {
        alerts = db
          .select()
          .from(activityLog)
          .where(and(
            gt(activityLog.id, input.sinceId),
            inArray(activityLog.category, alertCategories),
            gte(activityLog.importance, 0.8),
          ))
          // Newest-first so the limit keeps the most recent alerts rather than
          // the oldest, then flipped so they surface in the order they happened.
          .orderBy(desc(activityLog.id))
          .limit(input.limit ?? 5)
          .all()
          .reverse();
      }

      return { latestId, alerts };
    }),

  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('activity.all', opts.signal)) {
      yield data;
    }
  }),
});
