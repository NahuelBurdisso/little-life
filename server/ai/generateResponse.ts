import { callOllamaChat } from './ollama';
import { buildConversationPrompt, ConversationPromptParams } from './prompts';
import { analyzeSentiment } from './sentiment';
import { extractTopics } from './topics';
import { sanitizeDialogue, fallbackReply } from './sanitizeDialogue';
import {
  getConversationContext,
  addMessage,
  markConversationEnded,
} from '../helpers/conversationHelpers';
import { CONFIG } from '../lib/constants';
import { autoPlayer } from '../autoplay';

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
  // Force-ended between turns: don't spend a critical LLM slot on a reply
  // addMessage would refuse anyway.
  if (context.conversation.status === 'ended') return null;

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
    goalStakes,
    townNames,
  } = context;

  // Everything the model says passes through the sanitiser before it is judged,
  // stored or shown: stage directions, quotes, emoji and placeholders stored
  // raw would also be fed back as conversation history and teach the next turn
  // to do the same.
  // `truncated` (the token cap stopped the model mid-reply) lets it drop the
  // half-sentence the cap left behind — 8 of 104 playtest lines ended mid-clause.
  const clean = (raw: string, truncated?: boolean) => sanitizeDialogue(raw, {
    speakerName: speaker.name,
    listenerName: otherAgent.name,
    townNames: townNames ?? [],
    truncated,
  });

  // Situational prompts (begging, jealousy, affair discovery) get a bigger cap.
  // One value for both the first call and the nudge retry: the retry used the
  // normal cap, so a dramatic reply the validator rejected came back cut short.
  const maxTokens = situationalPrompt
    ? CONFIG.AI.CHAT_MAX_TOKENS_SITUATIONAL
    : CONFIG.AI.CHAT_MAX_TOKENS;

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
  const goalStakesContext = goalStakes
    ? `\n${goalStakes}`
    : '';
  const system = baseSystem + goalsContext + goalStakesContext;

  // 3. Call Ollama with retry
  let responseText: string | null = null;
  // The model's own words, kept only to show it what was rejected on a retry.
  let rawText: string | null = null;
  const contextItemCount = memories.length + (gossipFacts?.length ?? 0) + (situationalPrompt ? 1 : 0) + (statePrompts?.length ?? 0);

  for (let attempt = 0; attempt < CONFIG.AI.RETRY_ATTEMPTS; attempt++) {
    const llmStart = performance.now();
    try {
      const result = await callOllamaChat({
        model: CONFIG.AI.CHAT_MODEL,
        system,
        messages: promptMessages,
        priority: 'critical',
        options: {
          temperature: CONFIG.AI.CHAT_TEMPERATURE,
          top_p: CONFIG.AI.CHAT_TOP_P,
          num_predict: maxTokens,
          repeat_penalty: CONFIG.AI.CHAT_REPEAT_PENALTY,
        },
      });
      rawText = result.text;
      responseText = clean(result.text, result.truncated);
      // Only autoplay's analyze() drains perf records, so recording while it is
      // disabled just grows an array that is never reset.
      if (CONFIG.AUTOPLAY.ENABLED) {
        autoPlayer.perf.recordLlmCall({
          durationMs: performance.now() - llmStart,
          success: true,
          promptChars: system.length,
          contextItems: contextItemCount,
          retried: attempt > 0,
        });
      }
      autoPlayer.recordLlmResponse(performance.now() - llmStart, true);
      break;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const timedOut = msg.includes('timeout') || msg.includes('aborted');
      if (CONFIG.AUTOPLAY.ENABLED) {
        autoPlayer.perf.recordLlmCall({
          durationMs: performance.now() - llmStart,
          success: false,
          timedOut,
          promptChars: system.length,
          contextItems: contextItemCount,
          retried: attempt > 0,
        });
      }
      autoPlayer.recordLlmResponse(performance.now() - llmStart, false);
      console.warn(`[generateResponse] Attempt ${attempt + 1}/${CONFIG.AI.RETRY_ATTEMPTS} failed for conversation ${conversationId}: ${msg}`);
      if (attempt < CONFIG.AI.RETRY_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
      }
    }
  }

  // 3b. Validate response quality. A reply the sanitiser emptied (it was all
  // stage direction) is judged here like any too-short reply: one nudge retry,
  // then the canned fallback — the same path an empty model reply ends up on.
  if (rawText !== null && responseText !== null) {
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
      // One retry with nudge. The rejection is booked against this real call
      // instead of a synthetic { durationMs: 0, success: true } record — that
      // record counted as a completed request and pulled avgResponseMs and
      // p95ResponseMs toward zero.
      const nudgeStart = performance.now();
      let nudgeSucceeded = false;
      // Drop the rejected text now, so a failed retry reaches the fallback
      // below instead of saving the very reply the validator just refused.
      responseText = null;
      try {
        const nudge = await callOllamaChat({
          model: CONFIG.AI.CHAT_MODEL,
          system,
          messages: [
            ...promptMessages,
            { role: 'assistant' as const, content: rawText.trim() },
            { role: 'user' as const, content: `Please respond in character as ${speaker.name}. Say something natural in 1-2 sentences — only the words you say aloud, no actions or parentheses.` },
          ],
          priority: 'critical',
          options: {
            temperature: CONFIG.AI.CHAT_TEMPERATURE + 0.1,
            top_p: CONFIG.AI.CHAT_TOP_P,
            num_predict: maxTokens,
            repeat_penalty: CONFIG.AI.CHAT_REPEAT_PENALTY,
          },
        });
        // "Succeeded" means the retry produced text we actually used. A call
        // that returned but was still too short falls through to the fallback,
        // so booking it as a success overstated the retry's hit rate.
        const cleaned = nudge.text ? clean(nudge.text, nudge.truncated) : '';
        if (cleaned.length >= 2) {
          responseText = cleaned;
          nudgeSucceeded = true;
        }
      } catch {
        // nudge failed, fall through to fallback
      }
      const nudgeDurationMs = performance.now() - nudgeStart;
      if (CONFIG.AUTOPLAY.ENABLED) {
        autoPlayer.perf.recordLlmCall({
          durationMs: nudgeDurationMs,
          success: nudgeSucceeded,
          rejected: true,
        });
      }
      // Matches the two loop paths above — without this the response-time
      // timeline silently omitted every nudge retry.
      autoPlayer.recordLlmResponse(nudgeDurationMs, nudgeSucceeded);
    }
  }

  // 4. Fallback if LLM failed
  if (!responseText) {
    responseText = fallbackReply(speaker.name);
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
