import { query } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";

export const getRelationship = query({
  args: { agentA: v.id("agents"), agentB: v.id("agents") },
  handler: async (ctx, args) => {
    // Normalize ordering so agentA < agentB for consistent lookups
    const [a, b] =
      args.agentA < args.agentB
        ? [args.agentA, args.agentB]
        : [args.agentB, args.agentA];
    return await ctx.db
      .query("relationships")
      .withIndex("by_pair", (q) => q.eq("agentA", a).eq("agentB", b))
      .first();
  },
});

export const getAgentRelationships = query({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const asA = await ctx.db
      .query("relationships")
      .withIndex("by_agentA", (q) => q.eq("agentA", args.agentId))
      .collect();
    const asB = await ctx.db
      .query("relationships")
      .withIndex("by_agentB", (q) => q.eq("agentB", args.agentId))
      .collect();

    // Deduplicate by _id
    const seen = new Set<string>();
    const all = [];
    for (const r of [...asA, ...asB]) {
      if (!seen.has(r._id)) {
        seen.add(r._id);
        all.push(r);
      }
    }

    // Fetch the other agent's name for each relationship
    return Promise.all(
      all.map(async (relationship) => {
        const otherId: Id<"agents"> =
          relationship.agentA === args.agentId
            ? relationship.agentB
            : relationship.agentA;
        const otherAgent = await ctx.db.get(otherId);
        return {
          relationship,
          otherAgent: otherAgent
            ? { _id: otherAgent._id, name: otherAgent.name }
            : null,
        };
      })
    );
  },
});

export const getRelationshipGraph = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("relationships").collect();
  },
});
