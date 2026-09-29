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
import { getHealthSnapshot, HEALTH_CHANNEL } from '../lib/health';
import { nightSkip, NIGHT_SKIP_CHANNEL } from '../engine/nightSkip';

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

  /**
   * Is the machinery behind the town working? LLM verdict (ok / degraded /
   * down + reason), the planning breaker, embeddings and tick overruns — what
   * the health banner shows. Fresh via `onHealthChange`, which fires only when
   * the verdict changes (lib/health.ts), not per tick.
   */
  getHealth: publicProcedure.query(() => {
    return getHealthSnapshot();
  }),

  onHealthChange: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate(HEALTH_CHANNEL, opts.signal)) {
      yield data;
    }
  }),

  /**
   * State of the "skip to morning" fast-forward (engine/nightSkip.ts): whether
   * one runs, its target, and how the last one ended. Whether the button may be
   * OFFERED is decided client-side from the clock and who is asleep, with the
   * same pure rules (lib/nightSkip.ts); this is only the running state.
   */
  getNightSkip: publicProcedure.query(() => {
    return nightSkip.status();
  }),

  onNightSkipChange: publicProcedure.subscription(async function* (opts) {
    for await (const data of emitter.iterate(NIGHT_SKIP_CHANNEL, opts.signal)) {
      yield data;
    }
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
