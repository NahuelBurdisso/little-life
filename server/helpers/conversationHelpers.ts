import { db } from '../db';
import { agents, needs, economy, conversations, relationships, locations, worldState, agentStates, shared_knowledge, goals } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';

import { getEffectivePersonality, getActiveStatePrompts, getAgentStates } from '../lib/states';
import { getShareableFacts, getAgentName } from '../lib/gossip';
import type { MemoryRow } from '../ai/prompts';
import { contextBuilder, memoryService } from '../lib/memory/instance';
import { generateSituationalPrompt } from '../lib/personality';

export async function getConversationContext(conversationId: number, speakerId: number) {
  // Load conversation and world state first (needed to derive otherId and currentTick)
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conversation) return null;

  const otherId = (conversation.participants as number[]).find((p) => p !== speakerId);
  if (!otherId) return null;

  const world = db.select().from(worldState).get();
  if (!world) return null;

  const location = conversation.location
    ? db.select().from(locations).where(eq(locations.id, conversation.location)).get()
    : null;
  if (!location) return null;

  // Batch-load both agents in a single query
  const agentRows = db.select().from(agents).where(inArray(agents.id, [speakerId, otherId])).all();
  const speaker = agentRows.find((a) => a.id === speakerId);
  const otherAgent = agentRows.find((a) => a.id === otherId);
  if (!speaker || !otherAgent) return null;

  // Batch-load needs and economy for the speaker
  const speakerNeeds = db.select().from(needs).where(eq(needs.agent_id, speakerId)).get();
  const speakerEcon = db.select().from(economy).where(eq(economy.agent_id, speakerId)).get();
  if (!speakerNeeds || !speakerEcon) return null;

  // Load speaker's active goals for conversation context
  const speakerGoals = db.select().from(goals)
    .where(and(eq(goals.agent_id, speakerId), eq(goals.status, 'active')))
    .all()
    .filter(g => (g as any).description)
    .map(g => (g as any).description as string)
    .slice(0, 3);

  const [a, b] = speakerId < otherId ? [speakerId, otherId] : [otherId, speakerId];

  const relationship = db
    .select()
    .from(relationships)
    .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
    .get();

  const otherAgentName = otherAgent.name ?? '';
  const topic = (conversation.topic as string) ?? '';
  const currentTick = world?.time?.totalTicks ?? 0;

  const effectivePersonality = getEffectivePersonality(speaker.id) ?? (speaker.personality as any);
  const statePrompts = getActiveStatePrompts(speaker.id, world?.time?.totalTicks);

  // Build situational prompt from the speaker's active dramatic states
  const speakerStates = getAgentStates(speakerId);
  let situationalPrompt: string | null = null;
  const otherName = otherAgent.name;

  if (speakerStates.includes('in_debt')) {
    situationalPrompt = generateSituationalPrompt({ type: 'begging', targetName: otherName });
  } else if (speakerStates.includes('jealous')) {
    const jealousState = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, speakerId), eq(agentStates.type, 'jealous'))).get();
    if (jealousState) {
      const meta = (jealousState.metadata as Record<string, any> | null) ?? {};
      const rivalId = meta.rivalId as number | undefined;
      const loveInterestId = meta.loveInterestId as number | undefined;
      if (rivalId && loveInterestId && otherId === rivalId) {
        situationalPrompt = generateSituationalPrompt({
          type: 'jealousy_confrontation',
          loveInterestName: getAgentName(loveInterestId),
          rivalName: otherName,
        });
      }
    }
  } else if (speakerStates.includes('heartbroken')) {
    // Check if otherAgent is the partner who caused heartbreak and speaker knows of an affair
    const affairFact = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.type, 'affair'), eq(shared_knowledge.subject_id, otherId), eq(shared_knowledge.is_active, true))).all()
      .find(f => (f.known_by as number[]).includes(speakerId));
    if (affairFact) {
      const rivalId = affairFact.target_id;
      situationalPrompt = generateSituationalPrompt({
        type: 'affair_discovery',
        targetName: otherName,
        rivalName: rivalId ? getAgentName(rivalId) : 'someone else',
      });
    }
  }

  // Sync tick so retrieval scoring is accurate
  memoryService.setTick(currentTick);

  // Retrieve memories using the new memory stream ContextBuilder
  const contextItems = await contextBuilder.forConversation({
    agentId: speakerId,
    otherAgentName,
    topic,
    statePrompts,
    situationalPrompt,
  });

  // Extract memory descriptions to pass as MemoryRow-compatible objects for the prompt builder
  const relevantMemories: MemoryRow[] = contextItems
    .filter(item => item.type === 'memory')
    .map((item, idx) => ({
      id: -(idx + 1), // placeholder ID since these come from retrieval, not direct DB query
      agent_id: speakerId,
      description: item.text,
      type: 'retrieved',
      importance: 5,
      emotional_valence: 0,
      embedding: null,
      depth: 0,
      created_at: currentTick,
      last_accessed: currentTick,
      metadata: {} as Record<string, unknown>,
      is_active: 1,
      parent_ids: [],
    }));

  const gossipFacts = effectivePersonality
    ? getShareableFacts(speakerId, otherAgent!.id, effectivePersonality as any)
    : [];

  return {
    conversation,
    speaker,
    speakerNeeds,
    speakerEcon,
    otherAgent,
    relationship,
    memories: relevantMemories,
    location,
    world,
    effectivePersonality,
    statePrompts,
    gossipFacts,
    situationalPrompt,
    speakerGoals,
  };
}

export function addMessage(
  conversationId: number,
  speakerId: number,
  text: string,
  sentiment: number,
  topics: string[],
  timestamp: number,
) {
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conversation) return null;

  const messages = [
    ...(conversation.messages as Array<Record<string, unknown>>),
    {
      speakerId,
      text,
      sentiment,
      topics,
      timestamp,
    },
  ];

  db.update(conversations).set({ messages }).where(eq(conversations.id, conversationId)).run();
  return { messageCount: messages.length, maxTurns: conversation.max_turns };
}

export function markConversationEnded(conversationId: number) {
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conversation || conversation.status === 'ended') return;

  const msgs = conversation.messages as Array<{ sentiment?: number }>;
  const avgSentiment =
    msgs.length > 0
      ? msgs.reduce((sum, m) => sum + (m.sentiment ?? 0), 0) / msgs.length
      : 0;

  db.update(conversations)
    .set({ status: 'ended', ended_at: Date.now(), sentiment: avgSentiment })
    .where(eq(conversations.id, conversationId))
    .run();
}
