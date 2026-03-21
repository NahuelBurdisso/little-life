import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { CONFIG } from "../engine/constants";

// ---------------------------------------------------------------------------
// Helpers for generateEmbedding action
// ---------------------------------------------------------------------------

export const writeEmbedding = internalMutation({
  args: {
    memoryId: v.id("memories"),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.memoryId);
    if (!memory) return;
    await ctx.db.patch(args.memoryId, { embedding: args.embedding });
  },
});

// ---------------------------------------------------------------------------
// Helpers for generateResponse action
// ---------------------------------------------------------------------------

export const getConversationContext = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    speakerId: v.id("agents"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;

    const speaker = await ctx.db.get(args.speakerId);
    if (!speaker) return null;

    const speakerNeeds = await ctx.db
      .query("needs")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.speakerId))
      .first();

    const speakerEcon = await ctx.db
      .query("economy")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.speakerId))
      .first();

    if (!speakerNeeds || !speakerEcon) return null;

    const otherId = conversation.participants.find(
      (p: string) => p !== args.speakerId,
    );
    if (!otherId) return null;

    const otherAgent = await ctx.db.get(otherId);
    if (!otherAgent) return null;

    const [a, b] =
      args.speakerId < otherId
        ? [args.speakerId, otherId]
        : [otherId, args.speakerId];

    const relationship = await ctx.db
      .query("relationships")
      .withIndex("by_pair", (q) => q.eq("agentA", a).eq("agentB", b))
      .first();

    const memories = await ctx.db
      .query("memories")
      .withIndex("by_agentId_timestamp", (q) =>
        q.eq("agentId", args.speakerId),
      )
      .order("desc")
      .take(CONFIG.AI.MEMORY_RETRIEVAL_LIMIT);

    const location = await ctx.db.get(conversation.location);
    if (!location) return null;

    const world = await ctx.db.query("worldState").first();
    if (!world) return null;

    return {
      conversation,
      speaker,
      speakerNeeds,
      speakerEcon,
      otherAgent,
      relationship,
      memories,
      location,
      world,
    };
  },
});

export const addMessage = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    speaker: v.id("agents"),
    text: v.string(),
    sentiment: v.number(),
    topics: v.array(v.string()),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;

    const messages = [
      ...(conversation.messages as Array<Record<string, unknown>>),
      {
        speaker: args.speaker as string,
        text: args.text,
        sentiment: args.sentiment,
        topics: args.topics,
        timestamp: args.timestamp,
      },
    ];

    await ctx.db.patch(args.conversationId, { messages });
    return { messageCount: messages.length, maxTurns: conversation.maxTurns };
  },
});

export const markConversationEnded = internalMutation({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.status === "ended") return;

    const messages = conversation.messages as Array<{ sentiment?: number }>;
    const avgSentiment =
      messages.length > 0
        ? messages.reduce((sum, m) => sum + (m.sentiment ?? 0), 0) /
          messages.length
        : 0;

    await ctx.db.patch(args.conversationId, {
      status: "ended",
      endedAt: Date.now(),
      sentiment: avgSentiment,
    });
  },
});

// ---------------------------------------------------------------------------
// Helpers for generateReflection action
// ---------------------------------------------------------------------------

export const getReflectionContext = internalQuery({
  args: {
    agentId: v.id("agents"),
  },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) return null;

    const needs = await ctx.db
      .query("needs")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();

    const economy = await ctx.db
      .query("economy")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .first();

    const world = await ctx.db.query("worldState").first();
    if (!world) return null;

    const cutoffTick = world.time.totalTicks - 1440;
    const recentMemories = await ctx.db
      .query("memories")
      .withIndex("by_agentId_timestamp", (q) =>
        q.eq("agentId", args.agentId).gte("timestamp", cutoffTick),
      )
      .order("desc")
      .take(20);

    return { agent, needs, economy, world, recentMemories };
  },
});

export const insertReflectionMemory = internalMutation({
  args: {
    agentId: v.id("agents"),
    content: v.string(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const memoryId = await ctx.db.insert("memories", {
      agentId: args.agentId,
      content: args.content,
      type: "emotional",
      importance: CONFIG.AI.REFLECTION_IMPORTANCE,
      emotional_valence: 0,
      embedding: [],
      relatedAgents: [],
      relatedLocation: null,
      tags: ["reflection", "daily"],
      timestamp: args.timestamp,
      accessCount: 0,
      lastAccessed: args.timestamp,
    });
    return memoryId;
  },
});
