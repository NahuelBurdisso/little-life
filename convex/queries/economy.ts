import { query } from "../_generated/server";
import { v } from "convex/values";

export const getAgentEconomy = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("economy")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();
  },
});

export const getTransactionHistory = query({
  args: {
    agentId: v.id("agents"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const all = await ctx.db
      .query("economyTransactions")
      .withIndex("by_timestamp")
      .order("desc")
      .collect();

    const filtered = all.filter(
      (t) => t.fromAgent === args.agentId || t.toAgent === args.agentId
    );

    return filtered.slice(0, limit);
  },
});

export const getTownEconomyStats = query({
  args: {},
  handler: async (ctx) => {
    const economies = await ctx.db.query("economy").collect();
    const agentCount = economies.length;
    const totalMoney = economies.reduce((sum, e) => sum + e.money, 0);
    const averageMoney = agentCount > 0 ? totalMoney / agentCount : 0;

    return { totalMoney, averageMoney, agentCount };
  },
});
