/**
 * Template conversations: the brief canned exchange a queue entry gets when it
 * times out, or when no LLM exchange fits.
 */

import { db } from '../../../db';
import { needs, conversations, relationships, relationshipEvents } from '../../../db/schema';
import { eq, and } from 'drizzle-orm';
import { CONFIG } from '../../../lib/constants';
import { gameMinutes } from '../../../lib/gameClock';
import { addConversationModifier } from '../../../lib/moodModifiers';
import { recordScriptUsage, scriptLastUsed } from '../../../ai/templates';
import { queuedTopic } from '../../../ai/prompts';
import { composeTemplateChat } from '../../../lib/templateChat';
import { recordTownTemplate, townRecentTemplates } from '../../../lib/templateVariety';
import { buildTemplateChatContext } from '../../../helpers/templateChatContext';
import { newsKeyOf, partnerViewFor } from '../../../lib/partnerView';
import { simEvents } from '../../../lib/simEvents';
import { extractTopics } from '../../../ai/topics';
import { clamp } from '../../../lib/utils';
import { calculateCompatibility, PersonalityProfile } from '../../../lib/personality';
import { computeRelationshipDeltas, ConversationImpactContext } from '../../../lib/relationshipImpact';
import { currentWorldSeed } from '../../../lib/intimacy/worldSeed';
import { wandersToward } from '../../../lib/intimacy/wandering';
import { templateSocialGain } from '../../../lib/socialGain';
import { getAgentStates } from '../../../lib/states';
import { applyTemplateBeats } from '../../../lib/templateBeats';
import type { QueueRow, WorldRow } from './types';
import { loadTemplatePair, partnerDistressState } from './helpers';

// ---------------------------------------------------------------------------
// Process a timed-out queue entry with template fallback
// ---------------------------------------------------------------------------

export async function processTimedOutEntry(
  entry: QueueRow,
  world: WorldRow,
): Promise<void> {
  const now = Date.now();

  const agentList = loadTemplatePair(entry.participants as number[]);
  if (!agentList) {
    // The pair drifted apart between the tick's check and this async run.
    simEvents.emit('conversation:queue_dropped', { entry, reason: 'apart' });
    return;
  }
  const locationId = agentList[0].current_location!;

  const [orderedA, orderedB] =
    entry.participants[0] < entry.participants[1]
      ? [entry.participants[0], entry.participants[1]]
      : [entry.participants[1], entry.participants[0]];

  // One topic, played as a mini-exchange: opener, a reply written for it, an
  // optional follow-up and a farewell that stays on the topic (G5). The topic
  // is grounded in this moment — weather, place, a live event, someone both
  // know, how the listener looks, the relationship — and each speaker's lines
  // come from THEIR OWN feelings and mood. The old picker drew each line from
  // a different category, so "Glad to be in out of the rain" was answered with
  // "I've got so much to do today" (playtest #2).
  const nowGameMin = gameMinutes(world.time);
  // The reason it was queued ("flirting", "offering help"…) picks scripts
  // written for it, and what other pairs just said is avoided (playtest #3:
  // partners fell back to the same full-moon line as another pair that night).
  // The trigger too: a social call (lib/socialCalls) plays the scripts written
  // for why the caller came (data/socialCallScripts.ts), never the weather.
  const chatContext = {
    ...buildTemplateChatContext(agentList, locationId, world),
    intent: entry.topic ?? null,
    trigger: entry.trigger_reason,
    // What the opener has heard of the listener (out of jail, out of work…): the
    // same knowledge gate the LLM tier's prompt uses (lib/partnerView.ts).
    news: newsKeyOf(partnerViewFor(agentList[0].id, agentList[1].id, gameMinutes(world.time))),
  };
  const chat = composeTemplateChat(chatContext, {
    lastUsed: scriptLastUsed(orderedA, orderedB),
    nowGameMin,
    townRecent: townRecentTemplates(nowGameMin),
  });
  // The per-pair cooldown is per topic: this pair won't rehash the same one
  // for the script's cooldown hours (template_usage, game time).
  if (chat) {
    recordScriptUsage(orderedA, orderedB, chat.scriptId, nowGameMin);
    recordTownTemplate(chat.scriptId, chat.turns[0].text, nowGameMin);
  }

  // No speaker name in the text: the UI already labels every message with its
  // speaker. `composeTemplateChat` only returns null if no script at all can
  // be voiced here ("the day" always can), so the nod is a last resort.
  const turns: Array<{ text: string; sentiment: number; speaker: 0 | 1 }> = chat
    ? chat.turns.map((t) => ({ text: t.text, sentiment: t.sentiment, speaker: t.speaker }))
    : [{ text: `*nods at ${chatContext.people[1].first}*`, sentiment: 0, speaker: 0 }];

  const messageSentiment = turns.reduce((sum, t) => sum + t.sentiment, 0) / turns.length;

  // Create a completed conversation with the template messages
  const conversationDoc = {
    participants: entry.participants,
    messages: turns.map((turn) => ({
      speakerId: agentList[turn.speaker].id,
      text: turn.text,
      sentiment: turn.sentiment,
      topics: extractTopics([{ text: turn.text }]),
      timestamp: now,
    })),
    location: locationId,
    trigger_reason: entry.trigger_reason + ' (template)',
    topic: chat?.topic ?? queuedTopic(entry),
    status: 'ended' as const,
    started_at: now,
    ended_at: now,
    sentiment: messageSentiment,
    max_turns: turns.length,
  };

  const templateConversationId = db.insert(conversations)
    .values(conversationDoc)
    .returning({ id: conversations.id })
    .get().id;

  // Lighter relationship event for template conversations.
  // Personalities follow orderedA/orderedB, not agentList order — the engine keys its
  // `*AB` deltas to personalityA and those are stored as `*_delta_ab`.
  const agentA = agentList.find((a) => a.id === orderedA) ?? agentList[0];
  const agentB = agentList.find((a) => a.id === orderedB) ?? agentList[1];
  const personalityA = agentA.personality as PersonalityProfile | null;
  const personalityB = agentB.personality as PersonalityProfile | null;

  let compat = 1.0;
  if (personalityA && personalityB) {
    compat = calculateCompatibility(personalityA, personalityB);
  }

  const existingRel = db.select().from(relationships)
    .where(and(eq(relationships.agent_a, orderedA), eq(relationships.agent_b, orderedB))).get();

  const templateImpactCtx: ConversationImpactContext = {
    overallSentiment: messageSentiment,
    turnCount: turns.length,
    topic: conversationDoc.topic,
    personalityA,
    personalityB,
    compatibility: compat,
    existingFriendshipAB: existingRel?.friendship_ab ?? 0,
    existingFriendshipBA: existingRel?.friendship_ba ?? 0,
    existingRomanceAB: existingRel?.romance_ab ?? 0,
    existingRomanceBA: existingRel?.romance_ba ?? 0,
    isTemplate: true,
    partyA: agentA,
    partyB: agentB,
    neglectedA: wandersToward(agentA, agentB, nowGameMin),
    neglectedB: wandersToward(agentB, agentA, nowGameMin),
    worldSeed: currentWorldSeed(),
  };

  const templateDeltas = computeRelationshipDeltas(templateImpactCtx);

  db.insert(relationshipEvents)
    .values({
      agent_a: orderedA,
      agent_b: orderedB,
      event_type: 'conversation',
      description: 'Brief exchange (template)',
      friendship_delta_ab: templateDeltas.friendshipAB,
      friendship_delta_ba: templateDeltas.friendshipBA,
      romance_delta_ab: templateDeltas.romanceAB,
      romance_delta_ba: templateDeltas.romanceBA,
      trust_delta_ab: templateDeltas.trustAB,
      trust_delta_ba: templateDeltas.trustBA,
      sentiment: messageSentiment,
      processed: false,
      timestamp: now,
    })
    .run();

  // What the exchange came to: an insult or a fight between enemies, a flirt, a confession,
  // making up (lib/templateBeats.ts). The LLM tier reads these off its transcript above; a
  // template chat's lines were chosen FROM the pair's state, so the same state decides here.
  // Before the conversation:ended emit, the same order as the LLM tier, so the goal and
  // memory listeners see the beat and the chat together.
  if (chat) applyTemplateBeats([agentList[0], agentList[1]], chat.scriptId, messageSentiment, nowGameMin);

  // Lighter memory for each participant
  for (const agent of agentList) {
    const otherAgent = agentList.find((a) => a.id !== agent.id)!;
    const templatePartnerStates = getAgentStates(otherAgent.id);
    const templatePartnerState = partnerDistressState(templatePartnerStates);

    simEvents.emit('conversation:ended', {
      agentId: agent.id,
      // Lets once-per-conversation listeners dedupe the two emits (the player-
      // outcome reporter reports a nudge that fell back to a template chat). The
      // memory observer's LLM summary also keys on it, but a template exchange
      // is under its minimum line count, so it still gets the template memory.
      conversationId: templateConversationId,
      // Says so, because an id no longer tells the two tiers apart: the proposal
      // listener (lib/milestonesEngine.ts) decides a template exchange by the
      // answerer's feelings but waits for the proposal topic on an LLM one.
      template: true,
      // What was queued ('rendezvous', 'suspicion', 'proposal'...): the script topic in `summary` no longer says.
      triggerReason: entry.trigger_reason,
      perpetratorId: otherAgent.id,
      otherName: otherAgent.name,
      summary: conversationDoc.topic ?? '',
      turns: (conversationDoc.messages as Array<unknown>).length,
      sentiment: messageSentiment ?? 0,
      topics: [],
      partnerState: templatePartnerState,
      romanceLevel: agent.id === orderedA
        ? (existingRel?.romance_ab ?? 0)
        : (existingRel?.romance_ba ?? 0),
      hadRecentConflict: false,
      // Lets the memory quote a loaded template line (conversationGist.ts);
      // plain small talk scores too low and keeps the topic template.
      messages: conversationDoc.messages,
    });
  }

  // Social + fun + mood boost (consistent with LLM conversation effects)
  const avgSentiment = agentList.length === 2 ? (messageSentiment ?? 0) : 0;
  for (const agent of agentList) {
    const agentNeeds = db
      .select()
      .from(needs)
      .where(eq(needs.agent_id, agent.id))
      .get();

    if (agentNeeds) {
      // Fun delta mirrors LLM conversations: positive sentiment → fun boost
      const funDelta = avgSentiment > 0 ? 2 : avgSentiment < -0.3 ? -1 : 0.5;
      // Social payoff (E10): a flat +3 left 4x towns lonely, since most chats
      // there are templates. Scales with the exchange and this agent's bond to
      // the other speaker (lib/socialGain.ts); still under a full LLM chat.
      const socialGain = templateSocialGain({
        sentiment: avgSentiment,
        turns: turns.length,
        friendship: agent.id === orderedA ? (existingRel?.friendship_ab ?? 0) : (existingRel?.friendship_ba ?? 0),
      });
      const currentTime = agentNeeds.last_updated ?? 0;

      // Add mood modifier like LLM conversations do
      // Same budget as the LLM chats above: both sources share one +/-6 allowance.
      const moodModifiers = Math.abs(avgSentiment) > 0.1
        ? addConversationModifier(agentNeeds.mood_modifiers, {
          value: avgSentiment * 3,
          source: 'template_conversation',
          expiresAt: currentTime + CONFIG.NEEDS.MOOD_MODIFIER_DURATION_GAME_MINUTES,
        }, currentTime)
        : [...agentNeeds.mood_modifiers];

      db.update(needs)
        .set({
          social: clamp(agentNeeds.social + socialGain, 0, 100),
          fun: clamp(agentNeeds.fun + funDelta, 0, 100),
          mood_modifiers: moodModifiers,
        })
        .where(eq(needs.id, agentNeeds.id))
        .run();
    }
  }
}
