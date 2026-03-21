import { query } from "../_generated/server";
import { v } from "convex/values";

export const getActiveConversations = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("conversations")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
  },
});

export const getConversation = query({
  args: { id: v.id("conversations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getConversationHistory = query({
  args: {
    agentId: v.id("agents"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    const ended = await ctx.db
      .query("conversations")
      .withIndex("by_status", (q) => q.eq("status", "ended"))
      .order("desc")
      .collect();

    const filtered = ended.filter((c) =>
      c.participants.includes(args.agentId)
    );

    return filtered.slice(0, limit);
  },
});
