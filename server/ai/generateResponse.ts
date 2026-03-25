import { callOllamaChat } from './ollama';
import { buildConversationPrompt, ConversationPromptParams } from './prompts';
import { analyzeSentiment } from './sentiment';
import { extractTopics } from './topics';
import {
  getConversationContext,
  addMessage,
  markConversationEnded,
} from '../helpers/conversationHelpers';
import { CONFIG } from '../lib/constants';

export interface GenerateResponseResult {
  messageCount: number;
  maxTurns: number;
  otherParticipantId: number | undefined;
}

export async function generateResponse(
  conversationId: number,
  speakerId: number,
): Promise<GenerateResponseResult | null> {
  // 1. Read all context
  const context = getConversationContext(conversationId, speakerId);

  if (!context) {
    markConversationEnded(conversationId);
    return null;
  }

  const {
    conversation,
    speaker,
    speakerNeeds,
    speakerEcon,
    otherAgent,
    relationship,
    memories,
    location,
    world,
    effectivePersonality,
    statePrompts,
    gossipFacts,
  } = context;

  // 2. Build prompt
  const promptParams: ConversationPromptParams = {
    speaker,
    speakerNeeds,
    speakerEcon,
    conversation,
    relationship: relationship ?? null,
    otherAgent,
    memories,
    world,
    location,
    effectivePersonality,
    statePrompts,
    gossipFacts,
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
        baseUrl: process.env.OLLAMA_BASE_URL,
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
  const result = addMessage(conversationId, speakerId, responseText, sentiment, topics, now);

  if (!result) return null;

  // 7. Return result for TaskRunner to handle chaining
  const otherParticipantId = (conversation.participants as number[]).find(
    (p) => p !== speakerId,
  );

  return {
    messageCount: result.messageCount,
    maxTurns: result.maxTurns,
    otherParticipantId,
  };
}
