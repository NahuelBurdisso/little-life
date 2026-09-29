import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { activityLog } from '../db/schema';
import { and, desc, gt, gte, lt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';
import { getTimeline, involvesAgent } from '../lib/timeline';
import { alertTier, MIN_ALERT_IMPORTANCE, type AlertTier } from '../lib/alertTiers';

export const activityRouter = router({
  /**
   * The log by game day: days newest first, each with its Town Crier headline
   * and the events that mattered (see lib/timeline.ts). Pages end on a day
   * boundary; pass `nextCursor` back as `cursor` for older days. `agentId` is
   * a resident's "story so far" — everything they did OR that happened to them.
   */
  getTimeline: publicProcedure
    .input(
      z.object({
        day: z.number().int().optional(),
        agentId: z.number().int().optional(),
        minImportance: z.number().min(0).max(1).optional().default(0.6),
        categories: z.array(z.string()).optional(),
        cursor: z.number().int().optional(),
        limit: z.number().int().min(1).max(200).optional().default(60),
        order: z.enum(['time', 'importance']).optional(),
      }).optional(),
    )
    .query(({ input }) => getTimeline(input ?? {})),

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
        // Not `initiator_id = agentId`: that showed only what the resident DID,
        // and dropped everything that happened TO them (see involvesAgent).
        conditions.push(involvesAgent(input.agentId));
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

  /** Alert-worthy events since a given row id, oldest first, each with its
   *  `tier` (lib/alertTiers.ts). The client passes back the highest id it has
   *  already shown, so each row is turned into a toast exactly once. Without
   *  `sinceId` the query returns nothing but the latest id, which is how a fresh
   *  client establishes its watermark instead of replaying the whole backlog as
   *  alerts. `favoriteIds` are the player's starred residents (kept in the
   *  browser), whose rows alert at a lower bar. */
  getAlerts: publicProcedure
    .input(
      z.object({
        sinceId: z.number().optional(),
        limit: z.number().optional().default(8),
        favoriteIds: z.array(z.number()).optional(),
      }).optional(),
    )
    .query(({ input }) => {
      // The watermark tracks the newest row in the whole table, not the newest
      // alert, or a long run of ordinary rows would be re-scanned every poll.
      const latest = db
        .select({ id: activityLog.id })
        .from(activityLog)
        .orderBy(desc(activityLog.id))
        .limit(1)
        .get();
      const latestId = latest?.id ?? input?.sinceId ?? 0;

      let alerts: Array<typeof activityLog.$inferSelect & { tier: AlertTier }> = [];
      if (input?.sinceId != null) {
        const favorites = new Set(input.favoriteIds ?? []);
        alerts = db
          .select()
          .from(activityLog)
          .where(and(
            gt(activityLog.id, input.sinceId),
            // Every tier rule sits at or above this; the rest is decided per row.
            gte(activityLog.importance, MIN_ALERT_IMPORTANCE),
          ))
          // Newest-first so the limit keeps the most recent alerts rather than
          // the oldest, then flipped so they surface in the order they happened.
          // Scan cap: the client polls on every activity update, so the gap
          // between watermarks is a handful of rows, not hundreds.
          .orderBy(desc(activityLog.id))
          .limit(200)
          .all()
          .flatMap((row) => {
            const tier = alertTier(row, favorites);
            return tier ? [{ ...row, tier }] : [];
          })
          .slice(0, input.limit ?? 8)
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
