"use node";
/* eslint-disable no-var */
declare var console: { log: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void };
declare function setTimeout(cb: (...args: any[]) => void, ms: number): any;
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { Doc } from "../_generated/dataModel";
import { callOllamaChat } from "../ai/ollama";
import { buildConversationPrompt, ConversationPromptParams } from "../ai/prompts";
import { analyzeSentiment } from "../ai/sentiment";
import { extractTopics } from "../ai/topics";
import { CONFIG } from "../engine/constants";

export const generateResponse = internalAction({
  args: {
    conversationId: v.id("conversations"),
    speakerId: v.id("agents"),
  },
  handler: async (ctx, args) => {
    // 1. Read all context
    const context = await ctx.runQuery(
      internal.helpers.actionHelpers.getConversationContext,
      { conversationId: args.conversationId, speakerId: args.speakerId },
    );

    if (!context) {
      await ctx.runMutation(
        internal.helpers.actionHelpers.markConversationEnded,
        { conversationId: args.conversationId },
      );
      return;
    }

    const {
      conversation, speaker, speakerNeeds, speakerEcon,
      otherAgent, relationship, memories, location, world,
    } = context;

    // 2. Build prompt
    const promptParams: ConversationPromptParams = {
      speaker: speaker as Doc<"agents">,
      speakerNeeds: speakerNeeds as Doc<"needs">,
      speakerEcon: speakerEcon as Doc<"economy">,
      conversation: conversation as Doc<"conversations">,
      relationship: relationship as Doc<"relationships"> | null,
      otherAgent: otherAgent as Doc<"agents">,
      memories: memories as Doc<"memories">[],
      world: world as Doc<"worldState">,
      location: location as Doc<"locations">,
    };

    const { system, messages: promptMessages } = buildConversationPrompt(promptParams);

    // 3. Call Ollama with retry
    let responseText: string | null = null;

    for (let attempt = 0; attempt < CONFIG.AI.RETRY_ATTEMPTS; attempt++) {
      try {
        const result = await callOllamaChat({
          model: CONFIG.AI.CHAT_MODEL,
          system,
          messages: promptMessages,
          options: {
            temperature: CONFIG.AI.CHAT_TEMPERATURE,
            top_p: CONFIG.AI.CHAT_TOP_P,
            num_predict: CONFIG.AI.CHAT_MAX_TOKENS,
            repeat_penalty: CONFIG.AI.CHAT_REPEAT_PENALTY,
          },
        });
        responseText = result.text;
        break;
      } catch (_error) {
        if (attempt < CONFIG.AI.RETRY_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
        }
      }
    }

    // 4. Fallback if LLM failed
    if (!responseText) {
      const fallbacks = [
        `${speaker.name} smiled and nodded.`,
        `${speaker.name} paused thoughtfully.`,
        `"Hmm, interesting," ${speaker.name} said.`,
        `${speaker.name} shrugged.`,
      ];
      responseText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    // 5. Analyze response
    const sentiment = analyzeSentiment(responseText);
    const topics = extractTopics([{ text: responseText }]);
    const now = Date.now();

    // 6. Write message
    const result = await ctx.runMutation(
      internal.helpers.actionHelpers.addMessage,
      {
        conversationId: args.conversationId,
        speaker: args.speakerId,
        text: responseText,
        sentiment,
        topics,
        timestamp: now,
      },
    );

    if (!result) return;

    // 7. Check if conversation should continue
    if (result.messageCount < result.maxTurns) {
      const otherParticipantId = (conversation as Doc<"conversations">).participants.find(
        (p: string) => p !== args.speakerId,
      );

      if (otherParticipantId) {
        await ctx.scheduler.runAfter(
          500,
          internal.actions.generateResponse.generateResponse,
          { conversationId: args.conversationId, speakerId: otherParticipantId },
        );
      }
    }
  },
});
