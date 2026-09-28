import { router, publicProcedure } from '../trpc';
import { z } from 'zod';
import { detectStoryArcs } from '../lib/chronicle';
import { emitter } from '../engine/emitter';

export const chronicleRouter = router({
  /** Current story arcs, hottest first. Memoised in `detectStoryArcs`. */
  getArcs: publicProcedure
    .input(z.object({ limit: z.number().optional().default(12) }).optional())
    .query(({ input }) => detectStoryArcs().slice(0, input?.limit ?? 12)),

  // Arcs are derived from relationship events and secrets, both of which are
  // written during the same ticks that append to the activity log, so that
  // channel already signals "something story-shaped happened".
  onUpdate: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('activity.all', opts.signal)) {
      yield data;
    }
  }),
});
