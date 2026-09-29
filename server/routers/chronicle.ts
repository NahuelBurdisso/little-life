import { router, publicProcedure } from '../trpc';
import { z } from 'zod';
import { and, desc, gt, gte, lte } from 'drizzle-orm';
import { db } from '../db';
import { activityLog, gazetteIssues } from '../db/schema';
import { detectStoryArcs } from '../lib/chronicle';
import { getBrewing } from '../lib/brewing';
import { buildRecap, RECAP_MIN_IMPORTANCE } from '../lib/recap';
import { gameMinutesNow } from '../lib/worldClock';
import { MINUTES_PER_DAY } from '../lib/gameClock';

/**
 * Rows a recap may read. A week away at 4x is a few thousand rows above the
 * importance bar; the newest win, since the builder only keeps six anyway.
 */
const RECAP_ROW_CAP = 3000;

export const chronicleRouter = router({
  /** Current story arcs, hottest first. Memoised in `detectStoryArcs`. */
  getArcs: publicProcedure
    .input(z.object({ limit: z.number().optional().default(12) }).optional())
    .query(({ input }) => detectStoryArcs().slice(0, input?.limit ?? 12)),

  /**
   * What is about to boil over: residents near a snap, spreading secrets,
   * queued confrontations, goals nearly won. Hottest first, capped. Memoised in
   * `getBrewing`; the client refreshes it off the activity channel.
   */
  getBrewing: publicProcedure.query(() => getBrewing()),

  /**
   * "Previously on…" since a game minute (lib/recap.ts): the client asks once
   * when the player comes back after a gap or a night skip ends, so no channel.
   */
  getRecap: publicProcedure
    .input(z.object({ sinceMinute: z.number().int().min(0) }))
    .query(({ input }) => {
      const untilMinute = gameMinutesNow();
      const rows = db.select().from(activityLog)
        .where(and(
          gt(activityLog.game_minute, input.sinceMinute),
          lte(activityLog.game_minute, untilMinute),
          gte(activityLog.importance, RECAP_MIN_IMPORTANCE),
        ))
        .orderBy(desc(activityLog.id))
        .limit(RECAP_ROW_CAP)
        .all();
      const headlines = db.select({ id: gazetteIssues.id, day: gazetteIssues.day, headline: gazetteIssues.headline })
        .from(gazetteIssues)
        .where(and(
          gte(gazetteIssues.day, Math.floor(input.sinceMinute / MINUTES_PER_DAY)),
          lte(gazetteIssues.day, Math.floor(untilMinute / MINUTES_PER_DAY)),
        ))
        .all();
      return buildRecap({ sinceMinute: input.sinceMinute, untilMinute, rows, headlines });
    }),
});
