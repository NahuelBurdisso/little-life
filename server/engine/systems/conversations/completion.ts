/**
 * Everything that happens once an LLM conversation ends.
 */

import { db } from '../../../db';
import {
  agents,
  needs,
  conversations,
  relationships,
  relationshipEvents,
  economy,
  locations,
} from '../../../db/schema';
import type { ConversationMessage } from '../../../db/schema';
import { logActivity } from '../../../lib/activityLogger';
import { eq, and } from 'drizzle-orm';
import { CONFIG } from '../../../lib/constants';
import { gameMinutes } from '../../../lib/gameClock';
import { addConversationModifier } from '../../../lib/moodModifiers';
import { emitter } from '../../emitter';
import { recordConversationTopics } from '../../../lib/topicMemory';
import { simEvents } from '../../../lib/simEvents';
import { extractTopics } from '../../../ai/topics';
import { clamp } from '../../../lib/utils';
import { calculateCompatibility, PersonalityProfile } from '../../../lib/personality';
import { computeRelationshipDeltas, ConversationImpactContext } from '../../../lib/relationshipImpact';
import { currentWorldSeed } from '../../../lib/intimacy/worldSeed';
import { wandersToward } from '../../../lib/intimacy/wandering';
import { llmSocialGain } from '../../../lib/socialGain';
import { getAgentStates } from '../../../lib/states';
import { spreadGossip, getShareableFacts } from '../../../lib/gossip';
import { emitFightBeat, emitFlirtBeat, emitInsultBeat } from '../../../lib/conversationBeats';
import { evaluateConversation } from '../../../lib/conversationEvaluator';
import type { ConversationRow, WorldRow } from './types';
import { partnerDistressState } from './helpers';
import { type CompletionContext, type RelationshipDeltaTotals, loadCompletion } from './completionContext';
import { recordDrunkIncident, recordReputation, recordSecretTold } from './facts';
import {
  affairDiscovery,
  alcoholismRecovery,
  beggingOutcome,
  blackmailReport,
  confessionOutcome,
  reconciliationOutcome,
} from './darkDynamics';

/**
 * Runs every post-conversation effect of a finished LLM conversation, in a fixed
 * order: listeners of the `conversation:ended` emit and the later sections read
 * what the earlier ones wrote. Nothing here is awaited — the whole completion
 * runs synchronously once called — so no tick can interleave with it.
 */
export async function finishCompletedConversation(
  conversation: ConversationRow,
  world: WorldRow,
  truncated: boolean,
): Promise<void> {
  const ctx = loadCompletion(conversation, world, truncated);
  if (!ctx) return;

  recordSpokenTopics(ctx);
  const totals = createRelationshipEvents(ctx);
  triggerInteractions(ctx, totals.romance);
  offerFinancialHelp(ctx);

  // --- Fact Creation ---
  recordDrunkIncident(ctx);
  recordSecretTold(ctx);
  recordReputation(ctx);

  recordParticipantOutcomes(ctx);
  spreadConversationGossip(ctx);

  // --- Dark Social Dynamics: Post-Conversation Effects ---
  beggingOutcome(ctx);
  confessionOutcome(ctx);
  reconciliationOutcome(ctx);
  alcoholismRecovery(ctx);
  affairDiscovery(ctx);
  blackmailReport(ctx);

  const evaluation = evaluateConversationQuality(ctx, totals);
  closeFinishedConversation(ctx, evaluation);
}

/** Remember what each side said, so their next conversations today steer off it. */
function recordSpokenTopics(ctx: CompletionContext): void {
  const { fresh, world, messages, isFallback, participantIds, participants } = ctx;
  // What each side said, so their next conversations today can be steered
  // off it (lib/topicMemory.ts: perception penalty + prompt hint). LLM
  // conversations only — template lines are canned and repeat by design.
  recordConversationTopics({
    conversationId: fresh.id,
    participants: participantIds,
    participantNames: participants.map((p) => p.name),
    topic: fresh.topic,
    messages: messages.map((m) => ({ speakerId: m.speakerId, text: m.text, fallback: isFallback(m) })),
    gameMinute: gameMinutes(world.time),
  });
}

/**
 * One relationship event per pair, with the deltas the impact engine derives
 * from the conversation. Returns the deltas summed over every pair: the flirt
 * trigger and the quality evaluation read them.
 */
function createRelationshipEvents(ctx: CompletionContext): RelationshipDeltaTotals {
  const { fresh, world, messages, now, overallSentiment, participants } = ctx;
  // Accumulate relationship deltas across all pairs for quality evaluation
  let totalFriendshipDelta = 0;
  let totalRomanceDelta = 0;
  let totalTrustDelta = 0;

  // Salt for per-pair chemistry, read once for every pair of this conversation.
  const worldSeed = currentWorldSeed();

  // Create relationship events for each pair
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const agentA = participants[i];
      const agentB = participants[j];

      // Enforce A < B ordering for consistency with relationship table.
      // The personalities MUST be swapped alongside the ids: the engine returns
      // `*AB` deltas keyed to `personalityA`, and those are written into
      // `friendship_delta_ab`, which relationships.ts applies to orderedA -> orderedB.
      const aIsFirst = agentA.id < agentB.id;
      const [orderedA, orderedB] = aIsFirst
        ? [agentA.id, agentB.id]
        : [agentB.id, agentA.id];

      // --- Compute relationship deltas via engine ---
      const rowA = aIsFirst ? agentA : agentB;
      const rowB = aIsFirst ? agentB : agentA;
      const personalityA = rowA.personality as PersonalityProfile | null;
      const personalityB = rowB.personality as PersonalityProfile | null;

      let compat = 1.0;
      if (personalityA && personalityB) {
        compat = calculateCompatibility(personalityA, personalityB);
      }

      const existingRelationship = db.select().from(relationships)
        .where(and(eq(relationships.agent_a, orderedA), eq(relationships.agent_b, orderedB))).get();

      const impactCtx: ConversationImpactContext = {
        overallSentiment,
        turnCount: messages.length,
        topic: fresh.topic,
        personalityA,
        personalityB,
        compatibility: compat,
        existingFriendshipAB: existingRelationship?.friendship_ab ?? 0,
        existingFriendshipBA: existingRelationship?.friendship_ba ?? 0,
        existingRomanceAB: existingRelationship?.romance_ab ?? 0,
        existingRomanceBA: existingRelationship?.romance_ba ?? 0,
        isTemplate: false,
        // Same order as the personalities: `*AB` is orderedA -> orderedB.
        partyA: rowA,
        partyB: rowB,
        // A neglected, weakly loyal person's eye wanders to anyone but their partner (wandering.ts).
        neglectedA: wandersToward(rowA, rowB, gameMinutes(world.time)),
        neglectedB: wandersToward(rowB, rowA, gameMinutes(world.time)),
        worldSeed,
      };

      const deltas = computeRelationshipDeltas(impactCtx);
      const { friendshipAB: friendshipDeltaAB, friendshipBA: friendshipDeltaBA } = deltas;
      const { romanceAB: romanceDeltaAB, romanceBA: romanceDeltaBA } = deltas;
      const { trustAB: trustDeltaAB, trustBA: trustDeltaBA } = deltas;

      totalFriendshipDelta += friendshipDeltaAB + friendshipDeltaBA;
      totalRomanceDelta += romanceDeltaAB + romanceDeltaBA;
      totalTrustDelta += trustDeltaAB + trustDeltaBA;

      // Derive event type from deltas
      let eventType = 'conversation';
      let eventDescription = `Conversation about ${fresh.topic ?? 'various things'}`;
      if (romanceDeltaAB > 2 || romanceDeltaBA > 2) {
        eventType = 'flirting';
        eventDescription = `Flirtatious conversation between them`;
      } else if (overallSentiment < -0.3) {
        eventType = 'conflict';
        eventDescription = `Heated argument about ${fresh.topic ?? 'something'}`;
      } else if (overallSentiment > 0.5 && (trustDeltaAB > 2 || trustDeltaBA > 2)) {
        eventType = 'bonding';
        eventDescription = `Deep bonding conversation about ${fresh.topic ?? 'personal matters'}`;
      } else if (fresh.topic?.includes('gossip')) {
        eventType = 'gossip';
        eventDescription = `Shared gossip about ${fresh.topic.replace('gossip about ', '')}`;
      }

      db.insert(relationshipEvents)
        .values({
          agent_a: orderedA,
          agent_b: orderedB,
          event_type: eventType,
          description: eventDescription,
          friendship_delta_ab: friendshipDeltaAB,
          friendship_delta_ba: friendshipDeltaBA,
          romance_delta_ab: romanceDeltaAB,
          romance_delta_ba: romanceDeltaBA,
          trust_delta_ab: trustDeltaAB,
          trust_delta_ba: trustDeltaBA,
          sentiment: overallSentiment,
          processed: false,
          timestamp: now,
        })
        .run();
    }
  }

  return { friendship: totalFriendshipDelta, romance: totalRomanceDelta, trust: totalTrustDelta };
}

/**
 * A very negative conversation can tip into an insult or a fight, a warm one
 * into a flirt. `totalRomanceDelta` is the summed romance delta of every pair.
 */
function triggerInteractions(ctx: CompletionContext, totalRomanceDelta: number): void {
  const { overallSentiment, participantIds, participants } = ctx;
  // --- Conversation-triggered interactions ---
  // Very negative conversations can escalate to insults or confrontations
  if (overallSentiment < -0.5) {
    const aggressorId = participantIds[0];
    const targetId = participantIds[1];
    const aggressorAgent = participants.find(p => p.id === aggressorId);
    const targetAgent = participants.find(p => p.id === targetId);
    const aggressorPersonality = aggressorAgent?.personality as PersonalityProfile | null;

    if (aggressorPersonality && aggressorAgent && targetAgent) {
      // High aggression + very negative → insult
      if (aggressorPersonality.aggression > 45 && overallSentiment < -0.6 && Math.random() < 0.3) {
        emitInsultBeat(aggressorAgent, targetAgent);
      }
      // Low morality + very negative + drunk → confrontation
      if (aggressorPersonality.morality < 40 && overallSentiment < -0.7 &&
          getAgentStates(aggressorId).includes('drunk') && Math.random() < 0.4) {
        emitFightBeat(aggressorAgent, targetAgent);
      }
    }
  }

  // Flirtatious conversations can trigger romance interactions
  if (overallSentiment > 0.3) {
    const p1 = participants[0];
    const p2 = participants[1];
    const p1Personality = p1.personality as PersonalityProfile | null;

    if (p1Personality && p1Personality.sensuality > 50 && totalRomanceDelta > 3 && Math.random() < 0.25) {
      emitFlirtBeat(p1, p2);
    }
  }
}

/** A warm, well-off close friend slips a little money to one who is nearly broke. */
function offerFinancialHelp(ctx: CompletionContext): void {
  const { overallSentiment, participants } = ctx;
  // --- Proactive Financial Help ---
  if (overallSentiment > 0) {
    const speaker = participants[0];
    const otherParticipants = participants.slice(1);
    const speakerId = speaker.id;
    const otherId = otherParticipants[0].id;

    const rel = db.select().from(relationships).where(
      and(
        eq(relationships.agent_a, Math.min(speakerId, otherId)),
        eq(relationships.agent_b, Math.max(speakerId, otherId)),
      )
    ).get();
    const friendship = rel ? (speakerId < otherId ? rel.friendship_ab : rel.friendship_ba) : 0;

    if (friendship > 50) {
      const speakerEcon = db.select().from(economy).where(eq(economy.agent_id, speakerId)).get();
      const otherEcon = db.select().from(economy).where(eq(economy.agent_id, otherId)).get();
      if (speakerEcon && otherEcon) {
        let giverId: number | null = null;
        let receiverId: number | null = null;
        let giverMoney = 0;
        if (speakerEcon.money > 60 && otherEcon.money < 15) { giverId = speakerId; receiverId = otherId; giverMoney = speakerEcon.money; }
        else if (otherEcon.money > 60 && speakerEcon.money < 15) { giverId = otherId; receiverId = speakerId; giverMoney = otherEcon.money; }

        if (giverId && receiverId) {
          const giverAgent = giverId === speakerId ? speaker : otherParticipants[0];
          const warmth = giverAgent?.personality?.warmth ?? 50;
          if (warmth > 55) {
            const gift = Math.min(10, Math.round(giverMoney * 0.1));
            if (gift >= 2) {
              db.update(economy).set({ money: giverMoney - gift }).where(eq(economy.agent_id, giverId)).run();
              const recvEcon = db.select().from(economy).where(eq(economy.agent_id, receiverId)).get();
              if (recvEcon) db.update(economy).set({ money: recvEcon.money + gift }).where(eq(economy.agent_id, receiverId)).run();
            }
          }
        }
      }
    }
  }
}

/**
 * Per participant: the `conversation:ended` emit (memory, goals, cascades listen
 * synchronously) and then the social, fun and mood effects on their needs.
 */
function recordParticipantOutcomes(ctx: CompletionContext): void {
  const { fresh, messages, cutShort, overallSentiment, participants, time } = ctx;
  // For each participant: create memory, queue embedding, update needs
  for (const participant of participants) {
    const otherParticipants = participants.filter(
      (p) => p.id !== participant.id,
    );
    const otherNames = otherParticipants.map((p) => p.name);

    // Gather partner state and romance level for cascade rules
    const otherIds = otherParticipants.map((p) => p.id);
    const partnerStates = otherIds.flatMap((oid) => getAgentStates(oid));
    const partnerState = partnerDistressState(partnerStates);
    const relForRomance = otherIds.length === 1
      ? db.select().from(relationships).where(
          and(eq(relationships.agent_a, Math.min(participant.id, otherIds[0])),
              eq(relationships.agent_b, Math.max(participant.id, otherIds[0]))),
        ).get() ?? null
      : null;
    const romanceLevel = relForRomance
      ? (relForRomance.agent_a === participant.id ? relForRomance.romance_ab : relForRomance.romance_ba)
      : 0;
    // Check for recent conflict between this pair
    const hadRecentConflict = otherIds.length === 1 && db.select().from(relationshipEvents)
      .where(eq(relationshipEvents.processed, false)).all()
      .some((re) => {
        const reParticipants = [re.agent_a, re.agent_b];
        return reParticipants.includes(participant.id) && reParticipants.includes(otherIds[0]) &&
               (re.sentiment ?? 0) < -0.3;
      });

    simEvents.emit('conversation:ended', {
      agentId: participant.id,
      // Lets the memory observer summarise the conversation once for all
      // participants (lib/memory/conversationSummary.ts).
      conversationId: fresh.id,
      perpetratorId: otherIds[0] ?? null,
      otherName: otherNames.join(' and '),
      summary: fresh.topic ?? '',
      turns: messages.length,
      sentiment: overallSentiment ?? 0,
      topics: extractTopics(messages.map((m: ConversationMessage) => ({ text: m.text }))),
      partnerState,
      romanceLevel,
      hadRecentConflict,
      // Lets the memory stream record "we got cut off" instead of "we wrapped up
      // our conversation" for an exchange the turn budget amputated mid-flow.
      truncated: cutShort,
      // The memory quotes the transcript's most loaded line instead of only
      // naming the topic (see lib/memory/conversationGist.ts).
      messages,
    });

    // Update needs: social boost + mood modifier
    const agentNeeds = db
      .select()
      .from(needs)
      .where(eq(needs.agent_id, participant.id))
      .get();

    if (agentNeeds) {
      const personality = participant.personality as PersonalityProfile | null;

      const socialBoost = llmSocialGain(overallSentiment, personality?.warmth ?? null);
      const newSocial = clamp(agentNeeds.social + socialBoost, 0, 100);

      // Fun boost from enjoyable conversations
      let funBoost = 0;
      if (overallSentiment > 0.3) {
        funBoost = clamp(overallSentiment * 4, 0, 8); // good convos are fun
      } else if (overallSentiment < -0.3) {
        funBoost = clamp(overallSentiment * 2, -4, 0); // arguments drain fun
      }
      const newFun = clamp(agentNeeds.fun + funBoost, 0, 100);

      const currentTime = gameMinutes(time);
      let moodModifierDuration: number = CONFIG.NEEDS.MOOD_MODIFIER_DURATION_GAME_MINUTES;
      if (personality && personality.neuroticism > 60) {
        moodModifierDuration = Math.round(moodModifierDuration * 1.5);
      }
      // Capped: the needs phase sums every active modifier, and chats used to pile up
      // unchecked (lib/moodModifiers.ts), so a warm afternoon lifted the mood by a dozen +4s.
      const moodModifiers = addConversationModifier(agentNeeds.mood_modifiers, {
        source: 'conversation',
        value: overallSentiment * 5,
        expiresAt: currentTime + moodModifierDuration,
      }, currentTime);

      db.update(needs)
        .set({
          social: newSocial,
          fun: newFun,
          mood_modifiers: moodModifiers,
        })
        .where(eq(needs.id, agentNeeds.id))
        .run();
    }
  }
}

/** Pass on what each speaker knows about anyone they mentioned themselves. */
function spreadConversationGossip(ctx: CompletionContext): void {
  const { messages, participantIds } = ctx;
  // Spread gossip: for each participant, share known shared_knowledge if the subject
  // was mentioned. Only the speaker's OWN lines count — matching against the whole
  // transcript leaked a secret whenever the *listener* happened to say the subject's name.
  for (const pid of participantIds) {
    const otherId = participantIds.find((p) => p !== pid);
    if (!otherId) continue;
    const agent = db.select().from(agents).where(eq(agents.id, pid)).get();
    if (!agent?.personality) continue;
    const personalityData = agent.personality;
    const sharable = getShareableFacts(pid, otherId, personalityData);
    const spokenTexts = messages.filter((m) => m.speakerId === pid).map((m) => m.text);
    if (spokenTexts.length === 0) continue;
    spreadGossip(pid, otherId, spokenTexts, sharable);
  }
}

/** Score the conversation; the score is stored on the row when it is closed. */
function evaluateConversationQuality(
  ctx: CompletionContext,
  totals: RelationshipDeltaTotals,
): ReturnType<typeof evaluateConversation> {
  const { fresh, messages, cutShort, isFallback } = ctx;
  // --- Conversation Quality Evaluation ---
  return evaluateConversation({
    messages: messages.map(m => ({ text: m.text || '', sentiment: m.sentiment || 0, fallback: isFallback(m) })),
    injectedMemories: [], // Memories are in the LLM prompt, not stored on conversation record; evaluator redistributes this weight
    topic: (fresh.topic as string) || null,
    maxTurns: fresh.max_turns || 6,
    relationshipDeltas: {
      friendship: totals.friendship,
      romance: totals.romance,
      trust: totals.trust,
    },
    truncated: cutShort,
  });
}

/**
 * The last writes of a completion: the row ends with its sentiment and score,
 * the participants go back to idle, and the feed gets its "finished talking" line.
 */
function closeFinishedConversation(
  ctx: CompletionContext,
  evaluation: ReturnType<typeof evaluateConversation>,
): void {
  const { fresh, now, overallSentiment, participantIds, participants } = ctx;
  // Mark conversation as ended
  db.update(conversations)
    .set({
      status: 'ended',
      ended_at: now,
      sentiment: overallSentiment,
      quality_score: evaluation.quality_score,
      quality_breakdown: evaluation.quality_breakdown,
    })
    .where(eq(conversations.id, fresh.id))
    .run();

  // Reset participants back to idle — only if still talking THIS conversation
  for (const participantId of participantIds) {
    const agent = db.select().from(agents).where(eq(agents.id, participantId)).get();
    if (agent) {
      const action = agent.current_action;
      // Only reset if agent is still talking in THIS conversation
      if (action?.type === 'talking' && String(action?.conversationId) === String(fresh.id)) {
        db.update(agents)
          .set({ current_action: { type: 'idle' }, action_duration: null })
          .where(eq(agents.id, participantId))
          .run();
      }
    }
  }

  emitter.markDirty('agents.all');

  // Log activity. `location` is the registry template's `{location}` slot; it
  // used to be fed the topic, so the feed read "finished talking at flirting".
  // The topic rides along under its own key.
  const locationName = fresh.location != null
    ? db.select({ name: locations.name }).from(locations).where(eq(locations.id, fresh.location)).get()?.name
    : undefined;
  logActivity({
    type: 'conversation_ended',
    agents: participants.map((p) => p.id),
    location: fresh.location ?? undefined,
    templateData: {
      agent1: participants[0]?.name ?? '',
      agent2: participants[1]?.name ?? '',
      location: locationName ?? '',
      topic: fresh.topic ?? '',
    },
  });
}
