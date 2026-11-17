import { callOllamaChat } from './ollama';
import { buildConversationPrompt, ConversationPromptParams, firstMeetingOf, hasConcreteTopic, topicIntent } from './prompts';
import { analyzeSentiment } from './sentiment';
import { extractTopics } from './topics';
import { sanitizeDialogue, fallbackReply, stripGenericOpener } from './sanitizeDialogue';
import { firstName } from './names';
import {
  getConversationContext,
  addMessage,
  markConversationEnded,
} from '../helpers/conversationHelpers';
import { CONFIG } from '../lib/constants';
import { gameMinutesNow } from '../lib/worldClock';
import { recordTurnLatency } from '../lib/conversationPacing';
import { LLMAbortedError } from './llmErrors';
import { autoPlayer } from '../autoplay';
import { currentWorldEpoch, isStaleWorldEpoch } from '../lib/worldEpoch';

export interface GenerateResponseResult {
  messageCount: number;
  maxTurns: number;
  otherParticipantId: number | undefined;
}

export async function generateResponse(
  conversationId: number,
  speakerId: number,
  /** Aborted when the conversation is closed mid-turn (taskRunner.abortConversation). */
  signal?: AbortSignal,
): Promise<GenerateResponseResult | null> {
  const turnStart = performance.now();
  // The world this turn belongs to. A swap aborts the model call through the
  // world signal, but the check before the write below is what guarantees a
  // late line never lands in a new world's conversation that reuses this id.
  const worldEpoch = currentWorldEpoch();
  // Cancelled before it began (closed between turns): skip the context build,
  // which can itself wait on memory-retrieval embeddings.
  if (signal?.aborted) return null;
  // 1. Read all context
  const context = await getConversationContext(conversationId, speakerId);

  if (!context) {
    markConversationEnded(conversationId);
    return null;
  }
  // Force-ended between turns: don't spend a critical LLM slot on a reply
  // addMessage would refuse anyway.
  if (context.conversation.status === 'ended') return null;
  // Wrapped up between turns: the scheduler lowers `max_turns` to stop the chain
  // (conversationsTick Step A), and addMessage would refuse the line anyway.
  if (context.conversation.messages.length >= context.conversation.max_turns) return null;

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
    newcomer,
    otherJobTitle,
    recentSubjects,
    partnerLine,
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

  // G6: an opener that is nothing but "how are you doing today" gets its
  // pleasantry trimmed (free) when something concrete follows it. When the
  // WHOLE line is pleasantry and the conversation has a real topic, the line is
  // regenerated once through the nudge retry below — the only extra call, and
  // only on openers. A newcomer's introduction keeps its greeting: that is the
  // scene. Townsfolk who merely haven't talked before know each other already
  // (prompts.ts `firstMeetingOf`), so their opener is held to the same rule.
  const isOpener = conversation.messages.length === 0;
  const meeting = firstMeetingOf(relationship, newcomer);
  const checkOpener = isOpener && meeting !== 'speaker-new' && meeting !== 'listener-new';
  let genericOpener = false;
  const trimOpener = (text: string): string => {
    if (!checkOpener || !text) return text;
    const stripped = stripGenericOpener(text, otherAgent.name);
    if (stripped) return stripped;
    // Nothing but pleasantry: worth one regeneration when there is something
    // concrete to say instead; otherwise the greeting IS the conversation.
    if (hasConcreteTopic(conversation.topic)) genericOpener = true;
    return text;
  };

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
    newcomer,
    otherJobTitle,
    recentSubjects,
    partnerLine,
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
        purpose: 'conversation',
        system,
        messages: promptMessages,
        priority: 'critical',
        signal,
        options: {
          temperature: CONFIG.AI.CHAT_TEMPERATURE,
          top_p: CONFIG.AI.CHAT_TOP_P,
          num_predict: maxTokens,
          repeat_penalty: CONFIG.AI.CHAT_REPEAT_PENALTY,
        },
      });
      rawText = result.text;
      responseText = trimOpener(clean(result.text, result.truncated));
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
      // The conversation was closed under this turn: no retry, no fallback line,
      // no latency sample (Step A books a censored one for the abandoned turn).
      if (error instanceof LLMAbortedError || signal?.aborted) return null;
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
  const lastMsg = conversation.messages.length > 0
    ? conversation.messages[conversation.messages.length - 1]?.text
    : undefined;
  const isInvalid = (text: string) => {
    const trimmed = text.trim();
    return (
      trimmed.length < 2 ||                                    // too short
      trimmed === lastMsg?.trim() ||                            // exact repeat
      /^(undefined|null|error|Error)$/i.test(trimmed) ||        // broken output
      (trimmed.length < 10 && Math.abs(analyzeSentiment(trimmed)) < 0.2) // low-quality filler ("Ok", "Mm")
    );
  };
  if (rawText !== null && responseText !== null) {
    const retryForOpener = genericOpener && !isInvalid(responseText);
    // A pure pleasantry still beats a canned "X smiled and nodded." if the
    // regeneration fails or comes back as another pleasantry.
    const keepIfRetryFails = retryForOpener ? responseText : null;
    if (isInvalid(responseText) || retryForOpener) {
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
          purpose: 'conversation.retry',
          system,
          messages: [
            ...promptMessages,
            { role: 'assistant' as const, content: rawText.trim() },
            {
              role: 'user' as const,
              content: retryForOpener
                ? `That's just a pleasantry. As ${speaker.name}, skip the "how are you" and get straight to what's on your mind (${topicIntent(conversation.topic ?? '', firstName(otherAgent.name))}) in 1-2 sentences — only the words you say aloud.`
                : `Please respond in character as ${speaker.name}. Say something natural in 1-2 sentences — only the words you say aloud, no actions or parentheses.`,
            },
          ],
          priority: 'critical',
          signal,
          options: {
            temperature: CONFIG.AI.CHAT_TEMPERATURE + 0.1,
            top_p: CONFIG.AI.CHAT_TOP_P,
            num_predict: maxTokens,
            repeat_penalty: CONFIG.AI.CHAT_REPEAT_PENALTY,
          },
        });
        // "Succeeded" means the retry produced text we actually used. The retry
        // faces the same validator as the first reply: a nudge that came back
        // as "Ok" or a repeat of the last line used to be saved as is.
        const cleaned = nudge.text ? clean(nudge.text, nudge.truncated) : '';
        // On the opener, the retry gets the same trim. A retry that is still
        // pure pleasantry is only refused when the retry was FOR that (the
        // first line is then kept); on the ordinary invalid-reply retry a
        // pleasantry is better than the canned fallback.
        const usable = checkOpener && cleaned
          ? stripGenericOpener(cleaned, otherAgent.name) || (retryForOpener ? '' : cleaned)
          : cleaned;
        if (usable && !isInvalid(usable)) {
          responseText = usable;
          nudgeSucceeded = true;
        }
      } catch {
        // nudge failed, fall through to fallback
      }
      if (responseText === null && keepIfRetryFails) responseText = keepIfRetryFails;
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

  if (signal?.aborted || isStaleWorldEpoch(worldEpoch)) return null;

  // The LLM work for this turn is done — time it NOW, before addMessage. It used
  // to be timed by the task runner only when the line was accepted, so a turn so
  // slow that its conversation had already been closed never counted: the
  // slowest turns were exactly the ones the latency estimate never saw.
  // Stamped with the game minute NOW, not the start of the turn: a 60 s turn at
  // 4x spans four game hours, and sample expiry is measured in game minutes.
  recordTurnLatency(performance.now() - turnStart, gameMinutesNow());

  // 4. Fallback if LLM failed
  let isFallback = false;
  if (!responseText) {
    responseText = fallbackReply(speaker.name);
    isFallback = true;
  }

  // 5. Analyze response. A fallback is narration ("Omar smiled and nodded."),
  // not something the agent said: scoring it read "smiled" as warmth and
  // nudged the conversation's sentiment on a line nobody spoke.
  const sentiment = isFallback ? 0 : analyzeSentiment(responseText);
  const topics = isFallback ? [] : extractTopics([{ text: responseText }]);
  const now = Date.now();

  // 6. Write message — flagged, so sentiment averages, the evaluator, the
  // memory gist, the prompt history and the UI can treat it as an action.
  const result = addMessage(conversationId, speakerId, responseText, sentiment, topics, now, isFallback);

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
