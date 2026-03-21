import { query } from "../_generated/server";
import { v } from "convex/values";

export const getAgent = query({
  args: { id: v.id("agents") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getActiveAgents = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("agents").collect();
    return all.filter((a) => a.isActive);
  },
});

export const getAgentFull = query({
  args: { id: v.id("agents") },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.id);
    if (!agent) return null;
    const needs = await ctx.db
      .query("needs")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.id))
      .first();
    const economy = await ctx.db
      .query("economy")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.id))
      .first();
    return { agent, needs, economy };
  },
});
