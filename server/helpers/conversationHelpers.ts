import { db } from '../db';
import { agents, needs, economy, conversations, relationships, memories, locations, worldState } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { CONFIG } from '../lib/constants';
import { getEffectivePersonality, getActiveStatePrompts } from '../lib/states';
import { getShareableFacts } from '../lib/gossip';
import { retrieveMemories, MemoryRow } from '../ai/memories';
import { vectorStore } from '../lib/vectors';

export async function getConversationContext(conversationId: number, speakerId: number) {
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conversation) return null;

  const speaker = db.select().from(agents).where(eq(agents.id, speakerId)).get();
  if (!speaker) return null;

  const speakerNeeds = db.select().from(needs).where(eq(needs.agent_id, speakerId)).get();
  const speakerEcon = db.select().from(economy).where(eq(economy.agent_id, speakerId)).get();
  if (!speakerNeeds || !speakerEcon) return null;

  const otherId = (conversation.participants as number[]).find((p) => p !== speakerId);
  if (!otherId) return null;

  const otherAgent = db.select().from(agents).where(eq(agents.id, otherId)).get();
  if (!otherAgent) return null;

  const [a, b] = speakerId < otherId ? [speakerId, otherId] : [otherId, speakerId];

  const relationship = db
    .select()
    .from(relationships)
    .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
    .get();

  const otherAgentName = otherAgent.name ?? '';
  const topic = (conversation.topic as string) ?? '';
  const queryText = `talking with ${otherAgentName}${topic ? ' about ' + topic : ''}`;
  const currentTick = (conversation as any).started_at ?? Date.now();

  const vectorSearchFn = async (
    agentId: number,
    embedding: number[],
    limit: number,
  ): Promise<Array<MemoryRow & { _score?: number }>> => {
    const queryVec = Float32Array.from(embedding);
    const topIds = vectorStore.search(queryVec, agentId, limit);
    if (topIds.length === 0) return [];
    const rows = db.select().from(memories).where(eq(memories.agent_id, agentId)).all();
    const idSet = new Set(topIds);
    return rows
      .filter((r) => idSet.has(r.id))
      .map((r) => ({ ...(r as unknown as MemoryRow) }));
  };

  const fallbackFn = async (agentId: number, limit: number): Promise<MemoryRow[]> => {
    return db
      .select()
      .from(memories)
      .where(eq(memories.agent_id, agentId))
      .orderBy(desc(memories.timestamp))
      .limit(limit)
      .all() as unknown as MemoryRow[];
  };

  const relevantMemories = await retrieveMemories(
    vectorSearchFn,
    fallbackFn,
    speakerId,
    {
      queryText,
      relatedAgents: [otherId],
      limit: CONFIG.AI.MEMORY_RETRIEVAL_LIMIT,
    },
    currentTick,
  );

  const location = conversation.location
    ? db.select().from(locations).where(eq(locations.id, conversation.location)).get()
    : null;
  if (!location) return null;

  const world = db.select().from(worldState).get();
  if (!world) return null;

  const effectivePersonality = getEffectivePersonality(speaker.id) ?? (speaker.personality as any);
  const statePrompts = getActiveStatePrompts(speaker.id, world?.time?.totalTicks);

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
