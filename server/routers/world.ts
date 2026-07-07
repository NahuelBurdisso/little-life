import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { worldState, worldEvents, agents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { emitter } from '../engine/emitter';
import { getLLMStats } from '../ai/llmSemaphore';
import { logActivity } from '../lib/activityLogger';
import { simEvents } from '../lib/simEvents';

export const worldRouter = router({
  getState: publicProcedure.query(() => {
    return db.select().from(worldState).get() ?? null;
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

  /** Player-triggered world event injection */
  triggerEvent: publicProcedure
    .input(z.object({
      type: z.enum(['festival', 'storm', 'market_day', 'sickness', 'harvest', 'scandal', 'blessing']),
    }))
    .mutation(({ input }) => {
      const world = db.select().from(worldState).get();
      if (!world) return { ok: false, error: 'No world state' };

      const EVENT_DEFS: Record<string, { name: string; description: string; duration: number; effects: Record<string, unknown> }> = {
        festival: { name: 'Town Festival', description: 'A grand celebration fills the streets with music and laughter!', duration: 6, effects: { social_boost: 20, fun_boost: 15 } },
        storm: { name: 'Sudden Storm', description: 'Dark clouds roll in and rain hammers the town.', duration: 3, effects: { mood_outdoor: -15 } },
        market_day: { name: 'Market Day', description: 'Merchants arrive with discounted goods!', duration: 8, effects: { shop_prices: 0.5 } },
        sickness: { name: 'Flu Outbreak', description: 'A flu spreads through town. Stay healthy!', duration: 24, effects: { energy_drain: 1.5 } },
        harvest: { name: 'Bountiful Harvest', description: 'The harvest is exceptional this season!', duration: 12, effects: { farm_production: 2.0 } },
        scandal: { name: 'Town Scandal', description: 'A shocking rumor sweeps through town, putting everyone on edge.', duration: 4, effects: { trust_penalty: -5 } },
        blessing: { name: 'Beautiful Day', description: 'The weather is perfect. Everyone feels lighter.', duration: 6, effects: { mood_boost: 10 } },
      };

      const def = EVENT_DEFS[input.type];
      if (!def) return { ok: false, error: 'Unknown event type' };

      db.insert(worldEvents).values({
        type: input.type,
        name: def.name,
        description: def.description,
        started_at: world.time!.totalTicks,
        duration: def.duration,
        effects: def.effects,
        location_id: null,
        triggered_by: 'player',
        is_active: true,
      }).run();

      logActivity({
        type: 'player_event',
        templateData: { description: `${def.name}: ${def.description}` },
      });

      // Notify all agents
      const activeAgents = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all();
      for (const agent of activeAgents) {
        simEvents.emit('event:world', { agentId: agent.id, event: `${def.name}: ${def.description}` });
      }

      emitter.markDirty('world.state');
      emitter.flush();
      return { ok: true, event: def.name };
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
