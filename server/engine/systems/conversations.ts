/**
 * Conversations System — Tick Handler
 *
 * Manages the conversation lifecycle:
 *   A) Check active LLM conversations for completion
 *   C) Process queue timeouts with template fallback
 *   D) Fill open LLM slots from the queue
 *
 * Also handles post-conversation effects: relationship events, memories,
 * embedding generation, and needs updates.
 */

import { db } from '../../db';
import {
  agents,
  needs,
  conversations,
  conversationQueue,
  conversationSchedulerState,
  relationships,
  relationshipEvents,
  memories,
  activityLog,
  worldState,
} from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { emitter } from '../emitter';
import { taskRunner } from '../../ai/taskRunner';
import { selectTemplate, interpolateTemplate } from '../../ai/templates';
import { createConversationMemory } from '../../ai/memories';
import { extractTopics } from '../../ai/topics';
import { clamp } from '../../lib/utils';
import { calculateCompatibility, PersonalityProfile } from '../../lib/personality';
import { getAgentStates } from '../../lib/states';
import { createFact, spreadGossip, getShareableFacts } from '../../lib/gossip';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConversationMessage {
  speakerId: number;
  text: string;
  sentiment: number;
  topics: string[];
  timestamp: number;
}

interface ActiveLLMEntry {
  conversationId: number;
  startedAt: number;
}

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type QueueRow = typeof conversationQueue.$inferSelect;
type WorldRow = typeof worldState.$inferSelect;

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

export async function conversationsTick(): Promise<void> {
  // Collected LLM dispatch tasks — executed OUTSIDE the transaction (fire-and-forget async)
  const dispatches: Array<{ conversationId: number; speakerId: number; participantIds: number[] }> = [];
  // Completed LLM conversations to process asynchronously — OUTSIDE the transaction
  const completedConversations: Array<{ conversation: ConversationRow; world: WorldRow }> = [];
  // Timed-out queue entries needing template fallback — OUTSIDE the transaction
  const timedOutQueue: Array<{ entry: QueueRow; world: WorldRow }> = [];

  let changed = false;

  // ── Sync part: all DB reads and writes inside a single transaction ──────────
  db.transaction(() => {
    const world = db.select().from(worldState).get();
    if (!world) return;

    // Read scheduler state singleton
    const schedulerState = db.select().from(conversationSchedulerState).get();
    if (!schedulerState) return;

    const activeLLM: ActiveLLMEntry[] = [
      ...(schedulerState.active_llm_conversations as ActiveLLMEntry[]),
    ];
    let llmTotal = schedulerState.stats.llmConversationsTotal;
    let templateTotal = schedulerState.stats.templateConversationsTotal;
    let queueTimeouts = schedulerState.stats.queueTimeoutsTotal;

    // --- Step A: Check active LLM conversations ---
    const toRemove = new Set<number>();
    const LLM_CONVERSATION_TIMEOUT_MS = 60000; // 60 seconds
    const now = Date.now();

    for (const entry of activeLLM) {
      // Timeout check — force-end hung conversations
      if (now - entry.startedAt > LLM_CONVERSATION_TIMEOUT_MS) {
        const convo = db.select().from(conversations).where(eq(conversations.id, entry.conversationId)).get();
        if (convo && convo.status !== 'ended') {
          db.update(conversations).set({ status: 'ended', ended_at: now, sentiment: 0 })
            .where(eq(conversations.id, entry.conversationId)).run();
          // Reset agents
          const participants = convo.participants as number[];
          for (const pid of participants) {
            const agent = db.select().from(agents).where(eq(agents.id, pid)).get();
            if (agent && (agent.current_action as any)?.type === 'talking') {
              db.update(agents).set({ current_action: { type: 'idle' }, action_duration: null })
                .where(eq(agents.id, pid)).run();
            }
          }
          changed = true;
        }
        toRemove.add(entry.conversationId);
        continue;
      }

      const conversation = db
        .select()
        .from(conversations)
        .where(eq(conversations.id, entry.conversationId))
        .get();

      if (!conversation) {
        toRemove.add(entry.conversationId);
        continue;
      }

      const messages = conversation.messages as ConversationMessage[];
      if (
        conversation.status === 'ended' ||
        messages.length >= conversation.max_turns
      ) {
        // Collect for async processing outside the transaction
        completedConversations.push({ conversation, world });
        toRemove.add(entry.conversationId);
        llmTotal++;
        changed = true;
      }
    }

    const updatedActiveLLM = activeLLM.filter(
      (e) => !toRemove.has(e.conversationId),
    );

    // --- Step C: Process queue timeouts ---
    const queueEntries = db
      .select()
      .from(conversationQueue)
      .orderBy(desc(conversationQueue.priority))
      .all();

    const timedOutEntries: QueueRow[] = [];
    const validEntries: QueueRow[] = [];

    for (const entry of queueEntries) {
      if (now > entry.queued_at + entry.max_wait) {
        timedOutEntries.push(entry);
      } else {
        validEntries.push(entry);
      }
    }

    // Delete timed-out entries from queue; async template processing happens outside
    for (const entry of timedOutEntries) {
      db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
      timedOutQueue.push({ entry, world });
      templateTotal++;
      queueTimeouts++;
      changed = true;
    }

    // --- Step D: Fill open LLM slots ---
    let currentActive = updatedActiveLLM.length;
    const fillEntries = [...updatedActiveLLM];

    const time = world.time as { totalTicks: number };

    for (const entry of validEntries) {
      if (currentActive >= schedulerState.max_concurrent_llm) break;

      // Depressed agents skip conversations — remove from queue
      const firstParticipantStates = getAgentStates(entry.participants[0]);
      if (firstParticipantStates.includes('depressed')) {
        db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
        continue;
      }

      // Get first participant's position for location
      const firstParticipant = db
        .select()
        .from(agents)
        .where(eq(agents.id, entry.participants[0]))
        .get();

      if (!firstParticipant) {
        db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
        continue;
      }

      const locationId = firstParticipant.current_location;
      if (!locationId) {
        // Can't start a conversation without a location; skip for now
        continue;
      }

      const maxTurns =
        entry.tier === 'llm_deep'
          ? schedulerState.max_turns_deep
          : schedulerState.max_turns_standard;

      // Create conversation record
      const result = db
        .insert(conversations)
        .values({
          participants: entry.participants,
          messages: [],
          location: locationId,
          trigger_reason: entry.trigger_reason,
          topic: entry.topic,
          status: 'active',
          started_at: now,
          ended_at: null,
          sentiment: 0,
          max_turns: maxTurns,
        })
        .returning({ id: conversations.id })
        .get();

      const conversationId = result.id;

      // Update both agents' currentAction to "talking"
      for (const participantId of entry.participants) {
        db.update(agents)
          .set({
            current_action: {
              type: 'talking',
              conversationId,
            },
            action_started: time.totalTicks,
            action_duration: maxTurns * 2, // ticks, not milliseconds
          })
          .where(eq(agents.id, participantId))
          .run();
      }

      // Collect dispatch — actual startConversation() call goes outside transaction
      dispatches.push({
        conversationId,
        speakerId: entry.participants[0],
        participantIds: entry.participants as number[],
      });

      fillEntries.push({
        conversationId,
        startedAt: now,
      });
      currentActive++;
      changed = true;

      // Remove from queue
      db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
    }

    // --- Update scheduler state ---
    db.update(conversationSchedulerState)
      .set({
        active_llm_conversations: fillEntries,
        stats: {
          llmConversationsTotal: llmTotal,
          templateConversationsTotal: templateTotal,
          averageResponseTimeMs: schedulerState.stats.averageResponseTimeMs,
          queueTimeoutsTotal: queueTimeouts,
        },
      })
      .where(eq(conversationSchedulerState.id, schedulerState.id))
      .run();
  });

  // ── Async part: dispatch LLM calls outside transaction ─────────────────────
  for (const d of dispatches) {
    const accepted = taskRunner.startConversation(d.conversationId, d.speakerId);
    if (!accepted) {
      // Task runner slots full — remove the conversation record and reset agents to idle
      db.delete(conversations).where(eq(conversations.id, d.conversationId)).run();
      for (const pid of d.participantIds) {
        db.update(agents)
          .set({ current_action: { type: 'idle' }, action_duration: null })
          .where(eq(agents.id, pid))
          .run();
      }
    }
  }

  // Process timed-out queue entries with template fallback
  for (const { entry, world } of timedOutQueue) {
    await processTimedOutEntry(entry, world);
  }

  // Process completed LLM conversations
  for (const { conversation, world } of completedConversations) {
    await processCompletedConversation(conversation, world);
  }

  if (changed) {
    emitter.markDirty('conversations');
  }
}

// ---------------------------------------------------------------------------
// Process a completed conversation
// ---------------------------------------------------------------------------

async function processCompletedConversation(
  conversation: ConversationRow,
  world: WorldRow,
): Promise<void> {
  // Re-read to check if already processed (avoid double processing from TaskRunner + tick race)
  const fresh = db.select().from(conversations).where(eq(conversations.id, conversation.id)).get();
  if (!fresh || fresh.status === 'ended') return;

  const messages = fresh.messages as ConversationMessage[];
  const now = Date.now();

  // Calculate overall sentiment: average of all message sentiments
  let overallSentiment = 0;
  if (messages.length > 0) {
    const sentimentSum = messages.reduce((sum, m) => sum + m.sentiment, 0);
    overallSentiment = sentimentSum / messages.length;
  }

  // Get participant agents
  const participantIds = fresh.participants as number[];
  const participants: AgentRow[] = [];
  for (const pid of participantIds) {
    const agent = db.select().from(agents).where(eq(agents.id, pid)).get();
    if (agent) participants.push(agent);
  }

  if (participants.length < 2) {
    // Can't process without at least 2 participants
    db.update(conversations)
      .set({
        status: 'ended',
        ended_at: now,
        sentiment: overallSentiment,
      })
      .where(eq(conversations.id, conversation.id))
      .run();
    return;
  }

  // Create relationship events for each pair
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const agentA = participants[i];
      const agentB = participants[j];

      // Enforce A < B ordering for consistency with relationship table
      const [orderedA, orderedB] = agentA.id < agentB.id
        ? [agentA.id, agentB.id]
        : [agentB.id, agentA.id];

      let friendshipDeltaAB =
        overallSentiment > 0
          ? overallSentiment * 5
          : overallSentiment * 8;
      let friendshipDeltaBA = friendshipDeltaAB;
      let trustDeltaAB =
        overallSentiment > 0.3 ? 2 : overallSentiment < -0.3 ? -3 : 0;
      let trustDeltaBA = trustDeltaAB;

      // Get both agents' personalities
      const personalityA = agentA.personality as PersonalityProfile | null;
      const personalityB = agentB.personality as PersonalityProfile | null;

      // Calculate compatibility multiplier
      let compat = 1.0;
      if (personalityA && personalityB) {
        compat = calculateCompatibility(personalityA, personalityB);
      }

      // Apply compatibility to friendship and trust deltas
      friendshipDeltaAB *= compat;
      friendshipDeltaBA *= compat;
      trustDeltaAB *= compat;
      trustDeltaBA *= compat;

      // Generate romance deltas
      let romanceDeltaAB = 0;
      let romanceDeltaBA = 0;
      if (overallSentiment > 0.2 && personalityA && personalityB) {
        if (personalityA.sensuality > 40) {
          romanceDeltaAB = overallSentiment * 3 * (personalityA.sensuality / 100) * compat;
        }
        if (personalityB.sensuality > 40) {
          romanceDeltaBA = overallSentiment * 3 * (personalityB.sensuality / 100) * compat;
        }
      }

      // Look up existing friendship values to apply loyalty bonus check
      const existingRelationship = db
        .select()
        .from(relationships)
        .where(
          and(
            eq(relationships.agent_a, orderedA),
            eq(relationships.agent_b, orderedB),
          ),
        )
        .get();

      const existingFriendshipAB = existingRelationship
        ? existingRelationship.friendship_ab
        : 0;
      const existingFriendshipBA = existingRelationship
        ? existingRelationship.friendship_ba
        : 0;

      // Personality-amplified effects
      if (personalityA && personalityA.aggression > 60 && overallSentiment < -0.2) {
        friendshipDeltaAB *= 1.5; // aggressive agents escalate conflict
      }
      if (personalityB && personalityB.aggression > 60 && overallSentiment < -0.2) {
        friendshipDeltaBA *= 1.5;
      }
      if (personalityA && personalityA.vanity > 60 && overallSentiment < -0.2) {
        friendshipDeltaAB *= 1.5; // vain agents perceive insult
      }
      if (personalityB && personalityB.vanity > 60 && overallSentiment < -0.2) {
        friendshipDeltaBA *= 1.5;
      }
      if (personalityA && personalityA.loyalty > 60 && existingFriendshipAB > 50 && overallSentiment > 0.2) {
        trustDeltaAB *= 1.3; // loyal agents build trust with friends faster
      }
      if (personalityB && personalityB.loyalty > 60 && existingFriendshipBA > 50 && overallSentiment > 0.2) {
        trustDeltaBA *= 1.3;
      }

      // Derive event type from conversation dynamics
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

  // --- Fact Creation ---

  // Drunk incident: drunk participant in a negative conversation
  for (const participantId of participantIds) {
    const states = getAgentStates(participantId);
    if (states.includes('drunk') && overallSentiment < -0.3) {
      const otherId = participantIds.find(p => p !== participantId);
      if (otherId) {
        createFact('drunk_incident', participantId, otherId, 3, [...participantIds], 'witnessed');
      }
    }
  }

  // Secret told: heartbroken/lonely participant confides to a close friend
  for (const participantId of participantIds) {
    const states = getAgentStates(participantId);
    if (states.includes('heartbroken') || states.includes('lonely')) {
      const otherId = participantIds.find(p => p !== participantId);
      if (otherId) {
        const rel = db.select().from(relationships)
          .where(and(
            eq(relationships.agent_a, Math.min(participantId, otherId)),
            eq(relationships.agent_b, Math.max(participantId, otherId))
          )).get();
        const friendship = rel ? (participantId < otherId ? rel.friendship_ab : rel.friendship_ba) : 0;
        if (friendship > 60) {
          createFact('secret_told', participantId, otherId, 3, [participantId, otherId], 'confided');
        }
      }
    }
  }

  // Reputation: negative conversation + agent has 3+ recent negative conversations
  if (overallSentiment < -0.2) {
    for (const pid of participantIds) {
      const recentConvos = db.select().from(conversations)
        .where(eq(conversations.status, 'ended')).all()
        .filter(c => {
          const cParticipants = c.participants as number[];
          return cParticipants.includes(pid) &&
                 (c.sentiment ?? 0) < -0.2 &&
                 c.ended_at != null && c.ended_at > Date.now() - 1440000;
        });
      if (recentConvos.length >= 3) {
        createFact('reputation', pid, null, 1, [], 'observed');
      }
    }
  }

  const time = world.time as {
    day: number;
    hour: number;
    minute: number;
    totalTicks: number;
  };

  // For each participant: create memory, queue embedding, update needs
  for (const participant of participants) {
    const otherParticipants = participants.filter(
      (p) => p.id !== participant.id,
    );
    const otherNames = otherParticipants.map((p) => p.name);
    const otherIds = otherParticipants.map((p) => p.id);

    const memoryData = createConversationMemory(
      participant.id,
      {
        messages: messages as Array<{ text: string }>,
        sentiment: overallSentiment,
      },
      otherNames,
      otherIds,
      time.totalTicks,
      fresh.location,
    );

    // Drunk → fuzzy memories (halve importance)
    const participantStates = getAgentStates(participant.id);
    if (participantStates.includes('drunk')) {
      memoryData.importance = Math.max(1, Math.round(memoryData.importance * 0.5));
    }

    const memoryResult = db
      .insert(memories)
      .values(memoryData)
      .returning({ id: memories.id })
      .get();

    // Queue embedding generation
    taskRunner.generateEmbedding(memoryResult.id, memoryData.content);

    // Update needs: social boost + mood modifier
    const agentNeeds = db
      .select()
      .from(needs)
      .where(eq(needs.agent_id, participant.id))
      .get();

    if (agentNeeds) {
      const personality = participant.personality as PersonalityProfile | null;

      let socialBoost = clamp(8 + overallSentiment * 7, 1, 15);
      if (personality && personality.warmth > 60 && overallSentiment > 0) {
        socialBoost *= 1.3;
      }
      const newSocial = clamp(agentNeeds.social + socialBoost, 0, 100);

      const currentTime =
        time.day * 24 * 60 + time.hour * 60 + time.minute;
      let moodModifierDuration: number = CONFIG.NEEDS.MOOD_MODIFIER_DURATION_TICKS;
      if (personality && personality.neuroticism > 60) {
        moodModifierDuration = Math.round(moodModifierDuration * 1.5);
      }
      const moodModifiers = [
        ...agentNeeds.mood_modifiers,
        {
          source: 'conversation',
          value: overallSentiment * 5,
          expiresAt: currentTime + moodModifierDuration,
        },
      ];

      db.update(needs)
        .set({
          social: newSocial,
          mood_modifiers: moodModifiers,
        })
        .where(eq(needs.id, agentNeeds.id))
        .run();
    }
  }

  // Spread gossip: for each participant, share known facts if the subject was mentioned
  const messageTexts = messages.map((m) => m.text);
  for (const pid of participantIds) {
    const otherId = participantIds.find((p) => p !== pid);
    if (!otherId) continue;
    const agent = db.select().from(agents).where(eq(agents.id, pid)).get();
    if (!agent?.personality) continue;
    const personalityData = agent.personality as any;
    const sharable = getShareableFacts(pid, otherId, personalityData);
    spreadGossip(pid, otherId, messageTexts, sharable);
  }

  // Mark conversation as ended
  db.update(conversations)
    .set({
      status: 'ended',
      ended_at: now,
      sentiment: overallSentiment,
    })
    .where(eq(conversations.id, fresh.id))
    .run();

  // Reset participants back to idle — only if still talking THIS conversation
  for (const participantId of participantIds) {
    const agent = db.select().from(agents).where(eq(agents.id, participantId)).get();
    if (agent) {
      const action = agent.current_action as any;
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

  // Log activity
  db.insert(activityLog)
    .values({
      type: 'conversation_ended',
      message: `${participants.map((p) => p.name).join(' and ')} finished talking${fresh.topic ? ` about ${fresh.topic}` : ''}.`,
      agent_ids: participants.map((p) => p.id),
      timestamp: time.totalTicks,
      real_timestamp: now,
    })
    .run();
}

// ---------------------------------------------------------------------------
// Process a timed-out queue entry with template fallback
// ---------------------------------------------------------------------------

async function processTimedOutEntry(
  entry: QueueRow,
  world: WorldRow,
): Promise<void> {
  const now = Date.now();

  if (entry.participants.length < 2) return;

  const agentList: AgentRow[] = [];
  for (const pid of entry.participants) {
    const agent = db.select().from(agents).where(eq(agents.id, pid)).get();
    if (agent) agentList.push(agent);
  }
  if (agentList.length < 2) return;

  const locationId = agentList[0].current_location;
  if (!locationId) return;

  // Get relationship for template conditions
  const [orderedA, orderedB] =
    entry.participants[0] < entry.participants[1]
      ? [entry.participants[0], entry.participants[1]]
      : [entry.participants[1], entry.participants[0]];

  const relationship = db
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.agent_a, orderedA),
        eq(relationships.agent_b, orderedB),
      ),
    )
    .get();

  const friendship = relationship
    ? (relationship.friendship_ab + relationship.friendship_ba) / 2
    : 0;

  const needs0 = db
    .select()
    .from(needs)
    .where(eq(needs.agent_id, agentList[0].id))
    .get();

  const mood = needs0 ? needs0.mood : 50;
  const dayPhase = world.day_phase;

  // Select category based on friendship
  const category =
    friendship > 30
      ? 'greeting_friendly'
      : friendship < -20
        ? 'greeting_cold'
        : 'greeting_neutral';

  const templateResult = await selectTemplate(
    category,
    entry.participants[0],
    entry.participants[1],
    {
      friendship,
      mood,
      timeOfDay: dayPhase,
      locationType: null,
      weather: world.weather,
    },
  );

  const messageText = templateResult
    ? interpolateTemplate(templateResult.text, {
        speaker: agentList[0].name,
        listener: agentList[1].name,
      })
    : `${agentList[0].name} nodded at ${agentList[1].name}.`;
  const messageSentiment = templateResult ? templateResult.sentiment : 0;

  // Create a completed conversation with the template message
  const conversationDoc = {
    participants: entry.participants,
    messages: [
      {
        speakerId: entry.participants[0],
        text: messageText,
        sentiment: messageSentiment,
        topics: extractTopics([{ text: messageText }]),
        timestamp: now,
      },
    ],
    location: locationId,
    trigger_reason: entry.trigger_reason + ' (template fallback)',
    topic: entry.topic,
    status: 'ended' as const,
    started_at: now,
    ended_at: now,
    sentiment: messageSentiment,
    max_turns: 1,
  };

  db.insert(conversations)
    .values(conversationDoc)
    .returning({ id: conversations.id })
    .get();

  // Lighter relationship event for template conversations
  const agentA = agentList[0];
  const agentB = agentList[1];

  let friendshipDeltaAB =
    messageSentiment > 0 ? messageSentiment * 2 : messageSentiment * 3;
  let friendshipDeltaBA = friendshipDeltaAB;

  // Get both agents' personalities
  const personalityA = agentA.personality as PersonalityProfile | null;
  const personalityB = agentB.personality as PersonalityProfile | null;

  // Calculate compatibility multiplier
  let compat = 1.0;
  if (personalityA && personalityB) {
    compat = calculateCompatibility(personalityA, personalityB);
  }

  // Apply compatibility to friendship deltas
  friendshipDeltaAB *= compat;
  friendshipDeltaBA *= compat;

  // Generate romance deltas (smaller base for template conversations)
  let romanceDeltaAB = 0;
  let romanceDeltaBA = 0;
  if (messageSentiment > 0.2 && personalityA && personalityB) {
    if (personalityA.sensuality > 40) {
      romanceDeltaAB = messageSentiment * 1.5 * (personalityA.sensuality / 100) * compat;
    }
    if (personalityB.sensuality > 40) {
      romanceDeltaBA = messageSentiment * 1.5 * (personalityB.sensuality / 100) * compat;
    }
  }

  // Personality-amplified effects
  if (personalityA && personalityA.aggression > 60 && messageSentiment < -0.2) {
    friendshipDeltaAB *= 1.5;
  }
  if (personalityB && personalityB.aggression > 60 && messageSentiment < -0.2) {
    friendshipDeltaBA *= 1.5;
  }
  if (personalityA && personalityA.vanity > 60 && messageSentiment < -0.2) {
    friendshipDeltaAB *= 1.5;
  }
  if (personalityB && personalityB.vanity > 60 && messageSentiment < -0.2) {
    friendshipDeltaBA *= 1.5;
  }

  // Trust deltas for template are 0 base, loyalty bonus only applies if it would increase something non-zero
  // (kept at 0 for template fallback as per original design)

  db.insert(relationshipEvents)
    .values({
      agent_a: orderedA,
      agent_b: orderedB,
      event_type: 'conversation',
      description: 'Brief exchange (template)',
      friendship_delta_ab: friendshipDeltaAB,
      friendship_delta_ba: friendshipDeltaBA,
      romance_delta_ab: romanceDeltaAB,
      romance_delta_ba: romanceDeltaBA,
      trust_delta_ab: 0,
      trust_delta_ba: 0,
      sentiment: messageSentiment,
      processed: false,
      timestamp: now,
    })
    .run();

  const time = world.time as { totalTicks: number };

  // Lighter memory for each participant
  for (const agent of agentList) {
    const otherAgent = agentList.find((a) => a.id !== agent.id)!;
    const memoryData = createConversationMemory(
      agent.id,
      {
        messages: conversationDoc.messages as Array<{ text: string }>,
        sentiment: messageSentiment,
      },
      [otherAgent.name],
      [otherAgent.id],
      time.totalTicks,
      locationId,
    );
    // Lower importance for template conversations
    memoryData.importance = Math.max(1, memoryData.importance - 2);

    const memoryResult = db
      .insert(memories)
      .values(memoryData)
      .returning({ id: memories.id })
      .get();

    taskRunner.generateEmbedding(memoryResult.id, memoryData.content);
  }

  // Minimal social boost
  for (const agent of agentList) {
    const agentNeeds = db
      .select()
      .from(needs)
      .where(eq(needs.agent_id, agent.id))
      .get();

    if (agentNeeds) {
      db.update(needs)
        .set({
          social: clamp(agentNeeds.social + 3, 0, 100),
        })
        .where(eq(needs.id, agentNeeds.id))
        .run();
    }
  }
}
