import { router, publicProcedure } from '../trpc';
import { z } from 'zod';
import { detectStoryArcs } from '../lib/chronicle';

export const chronicleRouter = router({
  /** Current story arcs, hottest first. Memoised in `detectStoryArcs`. */
  getArcs: publicProcedure
    .input(z.object({ limit: z.number().optional().default(12) }).optional())
    .query(({ input }) => detectStoryArcs().slice(0, input?.limit ?? 12)),
});
