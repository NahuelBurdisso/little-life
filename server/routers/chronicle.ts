import { router, publicProcedure } from '../trpc';
import { z } from 'zod';
import { detectStoryArcs } from '../lib/chronicle';
import { getBrewing } from '../lib/brewing';

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
});
