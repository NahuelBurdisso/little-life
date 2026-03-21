import { query, internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";

export const getRecentMemories = query({
  args: {
    agentId: v.id("agents"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    return await ctx.db
      .query("memories")
      .withIndex("by_agentId_timestamp", (q) =>
        q.eq("agentId", args.agentId)
      )
      .order("desc")
      .take(limit);
  },
});

export const getMemoryById = internalQuery({
  args: { memoryId: v.id("memories") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.memoryId);
  },
});

export const vectorSearchMemories = internalAction({
  args: {
    agentId: v.id("agents"),
    embedding: v.array(v.float64()),
    limit: v.number(),
  },
  handler: async (ctx, args): Promise<any[]> => {
    const results = await ctx.vectorSearch("memories", "by_embedding", {
      vector: args.embedding,
      limit: args.limit,
      filter: (q: any) => q.eq("agentId", args.agentId),
    });
    const docs: any[] = await Promise.all(
      results.map(async (r: { _id: Id<"memories">; _score: number }): Promise<any> => {
        const doc = await ctx.runQuery(
          internal.queries.memories.getMemoryById,
          { memoryId: r._id },
        );
        return { ...doc, _score: r._score };
      })
    );
    return docs;
  },
});
