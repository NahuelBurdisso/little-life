import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { createConversationMemory } from "../ai/memories";
import { extractTopics } from "../ai/topics";
import { selectTemplate, interpolateTemplate } from "../ai/templates";
import { clamp } from "../lib/utils";
import { CONFIG } from "../engine/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConversationMessage {
  speakerId: string;
  text: string;
  sentiment: number;
  topics: string[];
  timestamp: number;
}

interface ActiveLLMEntry {
  conversationId: string;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

export async function tick(
  ctx: MutationCtx,
  world: Doc<"worldState">,
): Promise<void> {
  // Read scheduler state singleton
  const schedulerState = await ctx.db
    .query("conversationSchedulerState")
    .first();
  if (!schedulerState) return;

  const activeLLM: ActiveLLMEntry[] = [
    ...(schedulerState.activeLLMConversations as ActiveLLMEntry[]),
  ];
  let llmTotal = schedulerState.stats.llmConversationsTotal;
  let templateTotal = schedulerState.stats.templateConversationsTotal;
  let queueTimeouts = schedulerState.stats.queueTimeoutsTotal;

  // --- Step A: Check active LLM conversations ---
  const toRemove: Set<string> = new Set();

  for (const entry of activeLLM) {
    const conversation = await ctx.db.get(
      entry.conversationId as Id<"conversations">,
    );
    if (!conversation) {
      toRemove.add(entry.conversationId);
      continue;
    }

    const messages = conversation.messages as ConversationMessage[];
    if (
      conversation.status === "ended" ||
      messages.length >= conversation.maxTurns
    ) {
      await processCompletedConversation(ctx, conversation, world);
      toRemove.add(entry.conversationId);
      llmTotal++;
    }
  }

  const updatedActiveLLM = activeLLM.filter(
    (e) => !toRemove.has(e.conversationId),
  );

  // --- Step C: Process queue timeouts ---
  const queueEntries = await ctx.db
    .query("conversationQueue")
    .withIndex("by_priority")
    .order("desc")
    .collect();

  const now = Date.now();
  const timedOutEntries: Doc<"conversationQueue">[] = [];
  const validEntries: Doc<"conversationQueue">[] = [];

  for (const entry of queueEntries) {
    if (now > entry.queuedAt + entry.maxWait) {
      timedOutEntries.push(entry);
    } else {
      validEntries.push(entry);
    }
  }

  for (const entry of timedOutEntries) {
    await processTimedOutEntry(ctx, entry, world);
    await ctx.db.delete(entry._id);
    templateTotal++;
    queueTimeouts++;
  }

  // --- Step D: Fill open LLM slots ---
  let currentActive = updatedActiveLLM.length;
  const fillEntries = [...updatedActiveLLM];

  for (const entry of validEntries) {
    if (currentActive >= schedulerState.maxConcurrentLLM) break;

    // Get first participant's position for location
    const firstParticipant = await ctx.db.get(entry.participants[0]);
    if (!firstParticipant) {
      await ctx.db.delete(entry._id);
      continue;
    }

    const locationId = firstParticipant.currentLocation;
    if (!locationId) {
      // Can't start a conversation without a location; skip for now
      continue;
    }

    const maxTurns =
      entry.tier === "llm_deep"
        ? schedulerState.maxTurnsDeep
        : schedulerState.maxTurnsStandard;

    // Create conversation record
    const conversationId = await ctx.db.insert("conversations", {
      participants: entry.participants,
      messages: [],
      location: locationId,
      triggerReason: entry.triggerReason,
      topic: entry.topic,
      status: "active",
      startedAt: now,
      endedAt: null,
      sentiment: 0,
      maxTurns,
    });

    // Schedule first response
    await ctx.scheduler.runAfter(
      0,
      internal.actions.generateResponse.generateResponse,
      {
        conversationId,
        speakerId: entry.participants[0],
      },
    );

    // Update both agents' currentAction to "talking"
    for (const participantId of entry.participants) {
      await ctx.db.patch(participantId, {
        currentAction: {
          type: "talking",
          conversationId: conversationId as string,
        },
        actionStarted: world.time.totalTicks,
        actionDuration: maxTurns * 2, // ticks, not milliseconds
      });
    }

    fillEntries.push({
      conversationId: conversationId as string,
      startedAt: now,
    });
    currentActive++;

    // Remove from queue
    await ctx.db.delete(entry._id);
  }

  // --- Update scheduler state ---
  await ctx.db.patch(schedulerState._id, {
    activeLLMConversations: fillEntries,
    stats: {
      llmConversationsTotal: llmTotal,
      templateConversationsTotal: templateTotal,
      averageResponseTimeMs: schedulerState.stats.averageResponseTimeMs,
      queueTimeoutsTotal: queueTimeouts,
    },
  });
}

// ---------------------------------------------------------------------------
// Process a completed conversation
// ---------------------------------------------------------------------------

async function processCompletedConversation(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  world: Doc<"worldState">,
): Promise<void> {
  const messages = conversation.messages as ConversationMessage[];
  const now = Date.now();

  // Calculate overall sentiment: average of all message sentiments
  let overallSentiment = 0;
  if (messages.length > 0) {
    const sentimentSum = messages.reduce((sum, m) => sum + m.sentiment, 0);
    overallSentiment = sentimentSum / messages.length;
  }

  // Get participant agents
  const participants: Doc<"agents">[] = [];
  for (const pid of conversation.participants) {
    const agent = await ctx.db.get(pid);
    if (agent) participants.push(agent);
  }

  if (participants.length < 2) {
    // Can't process without at least 2 participants
    await ctx.db.patch(conversation._id, {
      status: "ended",
      endedAt: now,
      sentiment: overallSentiment,
    });
    return;
  }

  // Create relationship events for each pair
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const agentA = participants[i];
      const agentB = participants[j];

      const friendshipDelta =
        overallSentiment > 0
          ? overallSentiment * 5
          : overallSentiment * 8;
      const trustDelta =
        overallSentiment > 0.3 ? 2 : overallSentiment < -0.3 ? -3 : 0;

      await ctx.db.insert("relationshipEvents", {
        agentA: agentA._id,
        agentB: agentB._id,
        eventType: "conversation",
        description: `Conversation about ${conversation.topic ?? "various things"}`,
        friendshipDeltaAB: friendshipDelta,
        friendshipDeltaBA: friendshipDelta,
        romanceDeltaAB: 0,
        romanceDeltaBA: 0,
        trustDeltaAB: trustDelta,
        trustDeltaBA: trustDelta,
        sentiment: overallSentiment,
        processed: false,
        timestamp: now,
      });
    }
  }

  // For each participant: create memory, queue embedding, update needs
  for (const participant of participants) {
    const otherParticipants = participants.filter(
      (p) => p._id !== participant._id,
    );
    const otherNames = otherParticipants.map((p) => p.name);
    const otherIds = otherParticipants.map((p) => p._id);

    const memoryData = createConversationMemory(
      participant._id,
      conversation,
      otherNames,
      otherIds,
      world.time.totalTicks,
      conversation.location,
    );

    const memoryId = await ctx.db.insert("memories", memoryData);

    // Queue embedding generation
    await ctx.scheduler.runAfter(
      0,
      internal.actions.generateEmbedding.generateEmbedding,
      { memoryId, text: memoryData.content },
    );

    // Update needs: social boost + mood modifier
    const needs = await ctx.db
      .query("needs")
      .withIndex("by_agentId", (q) => q.eq("agentId", participant._id))
      .first();

    if (needs) {
      const socialBoost = clamp(8 + overallSentiment * 7, 1, 15);
      const newSocial = clamp(needs.social + socialBoost, 0, 100);

      const currentTime =
        world.time.day * 24 * 60 + world.time.hour * 60 + world.time.minute;
      const moodModifiers = [
        ...needs.moodModifiers,
        {
          source: "conversation",
          value: overallSentiment * 5,
          expiresAt: currentTime + CONFIG.NEEDS.MOOD_MODIFIER_DURATION_TICKS,
        },
      ];

      await ctx.db.patch(needs._id, {
        social: newSocial,
        moodModifiers,
      });
    }
  }

  // Mark conversation as ended
  await ctx.db.patch(conversation._id, {
    status: "ended",
    endedAt: now,
    sentiment: overallSentiment,
  });

  // Log activity
  await ctx.db.insert("activityLog", {
    type: "conversation_ended",
    message: `${participants.map((p) => p.name).join(" and ")} finished talking${conversation.topic ? ` about ${conversation.topic}` : ""}.`,
    agentIds: participants.map((p) => p._id),
    timestamp: now,
    realTimestamp: now,
  });
}

// ---------------------------------------------------------------------------
// Process a timed-out queue entry with template fallback
// ---------------------------------------------------------------------------

async function processTimedOutEntry(
  ctx: MutationCtx,
  entry: Doc<"conversationQueue">,
  world: Doc<"worldState">,
): Promise<void> {
  const now = Date.now();

  if (entry.participants.length < 2) return;

  const agents: Doc<"agents">[] = [];
  for (const pid of entry.participants) {
    const agent = await ctx.db.get(pid);
    if (agent) agents.push(agent);
  }
  if (agents.length < 2) return;

  const locationId = agents[0].currentLocation;
  if (!locationId) return;

  // Get relationship for template conditions
  const relationship = await ctx.db
    .query("relationships")
    .withIndex("by_pair", (q) =>
      q
        .eq("agentA", entry.participants[0] < entry.participants[1] ? entry.participants[0] : entry.participants[1])
        .eq("agentB", entry.participants[0] < entry.participants[1] ? entry.participants[1] : entry.participants[0]),
    )
    .first();

  const friendship = relationship
    ? (relationship.friendshipAB + relationship.friendshipBA) / 2
    : 0;

  const needs0 = await ctx.db
    .query("needs")
    .withIndex("by_agentId", (q) => q.eq("agentId", agents[0]._id))
    .first();

  const mood = needs0 ? needs0.mood : 50;
  const dayPhase = world.dayPhase;

  // Select category based on friendship
  const category =
    friendship > 30
      ? "greeting_friendly"
      : friendship < -20
        ? "greeting_cold"
        : "greeting_neutral";

  const templateResult = await selectTemplate(
    ctx,
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
        speaker: agents[0].name,
        listener: agents[1].name,
      })
    : `${agents[0].name} nodded at ${agents[1].name}.`;
  const messageSentiment = templateResult ? templateResult.sentiment : 0;

  // Create a completed conversation with the template message
  const conversationId = await ctx.db.insert("conversations", {
    participants: entry.participants,
    messages: [
      {
        speakerId: entry.participants[0] as string,
        text: messageText,
        sentiment: messageSentiment,
        topics: extractTopics([{ text: messageText }]),
        timestamp: now,
      },
    ],
    location: locationId,
    triggerReason: entry.triggerReason + " (template fallback)",
    topic: entry.topic,
    status: "ended",
    startedAt: now,
    endedAt: now,
    sentiment: messageSentiment,
    maxTurns: 1,
  });

  // Lighter relationship event for template conversations
  const friendshipDelta = messageSentiment > 0 ? messageSentiment * 2 : messageSentiment * 3;
  await ctx.db.insert("relationshipEvents", {
    agentA: entry.participants[0],
    agentB: entry.participants[1],
    eventType: "conversation",
    description: `Brief exchange (template)`,
    friendshipDeltaAB: friendshipDelta,
    friendshipDeltaBA: friendshipDelta,
    romanceDeltaAB: 0,
    romanceDeltaBA: 0,
    trustDeltaAB: 0,
    trustDeltaBA: 0,
    sentiment: messageSentiment,
    processed: false,
    timestamp: now,
  });

  // Lighter memory for each participant
  for (const agent of agents) {
    const otherAgent = agents.find((a) => a._id !== agent._id)!;
    const memoryData = createConversationMemory(
      agent._id,
      (await ctx.db.get(conversationId))!,
      [otherAgent.name],
      [otherAgent._id],
      world.time.totalTicks,
      locationId,
    );
    // Lower importance for template conversations
    memoryData.importance = Math.max(1, memoryData.importance - 2);

    const memoryId = await ctx.db.insert("memories", memoryData);
    await ctx.scheduler.runAfter(
      0,
      internal.actions.generateEmbedding.generateEmbedding,
      { memoryId, text: memoryData.content },
    );
  }

  // Minimal social boost
  for (const agent of agents) {
    const needs = await ctx.db
      .query("needs")
      .withIndex("by_agentId", (q) => q.eq("agentId", agent._id))
      .first();
    if (needs) {
      await ctx.db.patch(needs._id, {
        social: clamp(needs.social + 3, 0, 100),
      });
    }
  }
}
