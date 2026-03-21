"use node";
/* eslint-disable no-var */
declare var console: { log: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void };
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { callOllamaEmbedding } from "../ai/ollama";

export const generateEmbedding = internalAction({
  args: {
    memoryId: v.id("memories"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const embedding = await callOllamaEmbedding(args.text);
      await ctx.runMutation(
        internal.helpers.actionHelpers.writeEmbedding,
        { memoryId: args.memoryId, embedding },
      );
    } catch (error) {
      console.error(
        `Failed to generate embedding for memory ${args.memoryId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  },
});
