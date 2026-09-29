import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { worldState, worldEvents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';
import { getLLMStats } from '../ai/llmSemaphore';
import { getLLMMetrics } from '../ai/llmMetrics';
import { startWorldEvent } from '../engine/systems/events';
import { PLAYER_EVENT_TYPES } from '../data/worldEventCatalog';

export const worldRouter = router({
  getState: publicProcedure.query(() => {
    return db.select().from(worldState).get() ?? null;
  }),

  getLLMStats: publicProcedure.query(() => {
    return getLLMStats();
  }),

  /** Per-purpose latency / token numbers since server start (llmMetrics.ts). */
  getLLMMetrics: publicProcedure.query(() => {
    return getLLMMetrics();
  }),

  getActiveEvents: publicProcedure.query(() => {
    return db
      .select()
      .from(worldEvents)
      .where(eq(worldEvents.is_active, true))
      .all();
  }),

  /** Player-triggered world event injection */
  triggerEvent: publicProcedure
    .input(z.object({ type: z.enum(PLAYER_EVENT_TYPES) }))
    .mutation(({ input }) => {
      const result = startWorldEvent(input.type, { triggeredBy: 'player' });
      if (!result.ok) return { ok: false, error: result.reason };
      emitter.flush();
      return { ok: true, event: result.event.name };
    }),

  /** Change weather directly */
  setWeather: publicProcedure
    .input(z.object({
      weather: z.enum(['sunny', 'cloudy', 'rainy', 'stormy', 'foggy', 'snowy', 'windy', 'hot']),
      durationHours: z.number().min(1).max(24).default(4),
    }))
    .mutation(({ input }) => {
      const world = db.select().from(worldState).get();
      if (!world) return { ok: false };

      db.update(worldState).set({
        weather: input.weather,
        weather_duration: input.durationHours * 60,
      }).where(eq(worldState.id, world.id)).run();

      emitter.markDirty('world.state');
      emitter.flush();
      return { ok: true };
    }),

  onStateChange: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate('world.state', opts.signal)) {
      yield data;
    }
  }),
});
