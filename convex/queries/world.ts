import { query } from "../_generated/server";

export const getWorldState = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("worldState").first();
  },
});

export const getActiveEvents = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("worldEvents")
      .withIndex("by_isActive", (q) => q.eq("isActive", true))
      .collect();
  },
});

export const getWeather = query({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query("worldState").first();
    if (!state) return null;
    return {
      weather: state.weather,
      dayPhase: state.dayPhase,
      time: state.time,
    };
  },
});
