"use node";
/* eslint-disable no-var */
declare var console: { log: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void };
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { callOllamaChat } from "../ai/ollama";
import { CONFIG } from "../engine/constants";

export const generateReflection = internalAction({
  args: {
    agentId: v.id("agents"),
  },
  handler: async (ctx, args) => {
    // 1. Read context
    const context = await ctx.runQuery(
      internal.helpers.actionHelpers.getReflectionContext,
      { agentId: args.agentId },
    );

    if (!context) return;

    const { agent, needs, economy, world, recentMemories } = context;

    // 2. Skip if no memories today
    if (recentMemories.length === 0) return;

    // 3. Build reflection prompt
    const memoryDescriptions = recentMemories
      .map((m: { content: string }) => `- ${m.content}`)
      .join("\n");

    const moodValue = needs ? Math.round(needs.mood) : 50;
    const moodDescription =
      moodValue > 80 ? "very happy"
        : moodValue > 60 ? "content"
        : moodValue > 40 ? "okay"
        : moodValue > 20 ? "down"
        : "miserable";

    const jobTitle = economy ? economy.jobTitle : "resident";

    const system = `You are ${agent.name}, a ${agent.age}-year-old ${jobTitle}. ${agent.bio}\nYour traits: ${agent.traits.join(", ")}.\nRespond with a single introspective thought in first person. One sentence only.`;
    const userMessage = `Today's events:\n${memoryDescriptions}\n\nYour mood: ${moodDescription} (${moodValue}/100). Write a single reflective thought about your day.`;

    // 4. Call Ollama
    let reflectionText: string | null = null;

    try {
      const result = await callOllamaChat({
        model: CONFIG.AI.CHAT_MODEL,
        system,
        messages: [{ role: "user", content: userMessage }],
        options: { temperature: 0.9, num_predict: 80 },
      });
      reflectionText = result.text.trim();
    } catch (error) {
      console.error(
        `Reflection generation failed for agent ${agent.name}:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!reflectionText) return;

    // Clean up to single sentence
    const firstSentenceEnd = reflectionText.search(/[.!?]/);
    if (firstSentenceEnd > 0 && firstSentenceEnd < reflectionText.length - 1) {
      reflectionText = reflectionText.slice(0, firstSentenceEnd + 1);
    }

    // 5. Insert memory
    const memoryId = await ctx.runMutation(
      internal.helpers.actionHelpers.insertReflectionMemory,
      { agentId: args.agentId, content: reflectionText, timestamp: world!.time.totalTicks },
    );

    // 6. Queue embedding generation
    await ctx.scheduler.runAfter(
      0,
      internal.actions.generateEmbedding.generateEmbedding,
      { memoryId, text: reflectionText },
    );
  },
});
