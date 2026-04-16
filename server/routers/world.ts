import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { worldState, worldEvents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { emitter } from '../engine/emitter';
import { getLLMStats } from '../ai/llmSemaphore';

export const worldRouter = router({
  getState: publicProcedure.query(() => {
    return db.select().from(worldState).get();
  }),

  getLLMStats: publicProcedure.query(() => {
    return getLLMStats();
  }),

  getActiveEvents: publicProcedure.query(() => {
    return db
      .select()
      .from(worldEvents)
      .where(eq(worldEvents.is_active, true))
      .all();
  }),

  onStateChange: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('world.state', opts.signal)) {
      yield data;
    }
  }),
});
