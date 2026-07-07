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
  const context = await getConversationContext(conversationId, speakerId);

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
    situationalPrompt,
    speakerGoals,
    enrichment,
  } = context;

  const hasSituationalPrompt = !!situationalPrompt;

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
    situationalPrompt,
    enrichment,
  };

  const { system: baseSystem, messages: promptMessages } = buildConversationPrompt(promptParams);

  const goalsContext = speakerGoals?.length
    ? `\nYour goals: ${speakerGoals.join('; ')}`
    : '';
  const system = baseSystem + goalsContext;

  // TODO: pass goal-target context to turn instruction for even richer steering

  // 3. Call Ollama with retry
  let responseText: string | null = null;

  for (let attempt = 0; attempt < CONFIG.AI.RETRY_ATTEMPTS; attempt++) {
    try {
      const result = await callOllamaChat({
        model: CONFIG.AI.CHAT_MODEL,
        system,
        messages: promptMessages,
        priority: 'critical',
        options: {
          temperature: CONFIG.AI.CHAT_TEMPERATURE,
          top_p: CONFIG.AI.CHAT_TOP_P,
          num_predict: hasSituationalPrompt
            ? CONFIG.AI.CHAT_MAX_TOKENS_SITUATIONAL
            : CONFIG.AI.CHAT_MAX_TOKENS,
          repeat_penalty: CONFIG.AI.CHAT_REPEAT_PENALTY,
        },
      });
      responseText = result.text;
      break;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[generateResponse] Attempt ${attempt + 1}/${CONFIG.AI.RETRY_ATTEMPTS} failed for conversation ${conversationId}: ${msg}`);
      if (attempt < CONFIG.AI.RETRY_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
      }
    }
  }

  // 3b. Validate response quality
  if (responseText) {
    const trimmed = responseText.trim();
    const lastMsg = conversation.messages.length > 0
      ? (conversation.messages[conversation.messages.length - 1] as Record<string, any>)?.text as string | undefined
      : undefined;
    const sentiment = analyzeSentiment(trimmed);
    const isInvalid =
      trimmed.length < 2 ||                                    // too short
      trimmed === lastMsg?.trim() ||                            // exact repeat
      /^(undefined|null|error|Error)$/i.test(trimmed) ||        // broken output
      (trimmed.length < 10 && Math.abs(sentiment) < 0.2);       // low-quality filler ("Ok", "Mm")

    if (isInvalid) {
      // One retry with nudge
      try {
        const nudge = await callOllamaChat({
          model: CONFIG.AI.CHAT_MODEL,
          system,
          messages: [
            ...promptMessages,
            { role: 'assistant' as const, content: trimmed },
            { role: 'user' as const, content: `Please respond in character as ${speaker.name}. Say something natural in 1-2 sentences.` },
          ],
          priority: 'critical',
          options: {
            temperature: CONFIG.AI.CHAT_TEMPERATURE + 0.1,
            top_p: CONFIG.AI.CHAT_TOP_P,
            num_predict: CONFIG.AI.CHAT_MAX_TOKENS,
            repeat_penalty: CONFIG.AI.CHAT_REPEAT_PENALTY,
          },
        });
        if (nudge.text && nudge.text.trim().length >= 2) {
          responseText = nudge.text;
        }
      } catch {
        // nudge failed, fall through to fallback
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
