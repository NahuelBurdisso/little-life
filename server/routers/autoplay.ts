import { router, publicProcedure } from '../trpc';
import { z } from 'zod';
import { autoPlayer } from '../autoplay';
import { CONFIG } from '../lib/constants';
import { persistAutoplayConfig } from '../lib/autoplaySettings';

export const autoplayRouter = router({
  getReport: publicProcedure.query(() => {
    return autoPlayer.getLatestReport();
  }),

  getHistory: publicProcedure.input(z.object({
    windows: z.number().default(24),
  })).query(({ input }) => {
    return autoPlayer.getHistory(input.windows);
  }),

  getAgentProfiles: publicProcedure.query(() => {
    return autoPlayer.getAgentProfiles();
  }),

  getLlmDashboard: publicProcedure.query(() => {
    return autoPlayer.getLlmDashboard();
  }),

  getLlmTimeline: publicProcedure.query(() => {
    return autoPlayer.getLlmResponseTimeline();
  }),

  configure: publicProcedure.input(z.object({
    enabled: z.boolean().optional(),
    autoNudge: z.boolean().optional(),
    boredThreshold: z.number().min(0).max(100).optional(),
    // Game minutes per analysis window.
    windowMinutes: z.number().min(10).max(300).optional(),
    maxNudgesPerDay: z.number().min(0).max(20).optional(),
  })).mutation(({ input }) => {
    if (input.enabled !== undefined) {
      // Re-enabling starts a fresh window: the analyzer's wall-clock cursor is
      // frozen for as long as autoplay is off, and the sustained-pattern run
      // counter it clears alongside would otherwise judge the first window of
      // the new session against windows recorded before the gap.
      if (input.enabled && !CONFIG.AUTOPLAY.ENABLED) autoPlayer.resetWindowClock();
      CONFIG.AUTOPLAY.ENABLED = input.enabled;
    }
    if (input.autoNudge !== undefined) CONFIG.AUTOPLAY.AUTO_NUDGE = input.autoNudge;
    if (input.boredThreshold !== undefined) CONFIG.AUTOPLAY.BOREDOM_THRESHOLD = input.boredThreshold;
    if (input.windowMinutes !== undefined && input.windowMinutes !== CONFIG.AUTOPLAY.WINDOW_MINUTES) {
      CONFIG.AUTOPLAY.WINDOW_MINUTES = input.windowMinutes;
      // tick.ts fires analyze() when the game clock crosses a WINDOW_MINUTES
      // boundary; changing the size re-aligns that boundary, so already-buffered samples belong to a
      // window that will never be closed. Drop them.
      autoPlayer.perf.reset();
      // The wall-clock cursor has to move with them, or the first post-resize
      // window keeps the old `startMs` while its tick span has changed. This
      // also drops the sustained-pattern run counter, which is correct: its
      // entries were measured over the OLD tick span, so "3 consecutive
      // windows" would no longer denote a fixed duration.
      // Not `reset()` — a size change should not discard baselines or the
      // nudge cooldown, both of which stay meaningful across a resize.
      autoPlayer.resetWindowClock();
    }
    if (input.maxNudgesPerDay !== undefined) CONFIG.AUTOPLAY.MAX_NUDGES_PER_DAY = input.maxNudgesPerDay;
    // Per world, so a restart (or a save load) brings the same storyteller back.
    persistAutoplayConfig();
    return CONFIG.AUTOPLAY;
  }),

  getConfig: publicProcedure.query(() => {
    return CONFIG.AUTOPLAY;
  }),
});
