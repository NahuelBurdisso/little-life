/**
 * Memory Retrieval and Creation
 *
 * Functions for scoring/retrieving relevant memories and creating new ones
 * from conversations and observations.
 *
 * retrieveMemories uses Ollama embeddings + vectorStore for similarity search,
 * falling back to recency if embeddings are unavailable.
 * Creation functions are pure — they return insert data for the caller.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The shape of a memory row from the DB. */
export interface MemoryRow {
  id: number;
  agent_id: number;
  description: string;
  type: string;
  importance: number;
  emotional_valence: number;
  embedding: Buffer | null;
  depth: number;
  created_at: number;
  last_accessed: number;
  metadata: Record<string, unknown>;
  is_active: number;
  parent_ids: number[];
}

/** Data ready to be inserted into the memories table. */
export interface MemoryInsertData {
  agent_id: number;
  description: string;
  type: string;
  importance: number;
  emotional_valence: number;
  embedding: Buffer | null;
  depth: number;
  created_at: number;
  last_accessed: number;
  metadata: Record<string, unknown>;
  is_active: number;
  parent_ids: number[];
}

export interface MemoryQuery {
  queryText: string;
  relatedAgents?: number[];
  relatedLocation?: number;
  limit: number;
  recencyBias?: number;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Full retrieval with vector search.
 *
 * Calls Ollama for embeddings, then scores results.
 * Falls back to timestamp-based retrieval if embedding fails.
 *
 * @param vectorSearchFn - Function that performs vector similarity search.
 * @param fallbackFn - Function that returns most-recent memories.
 * @param agentId - The agent whose memories to retrieve.
 * @param query - Query parameters.
 * @param currentTick - Current world tick.
 */
export async function retrieveMemories(
  vectorSearchFn: (
    agentId: number,
    embedding: number[],
    limit: number,
  ) => Promise<Array<MemoryRow & { _score?: number }>>,
  fallbackFn: (agentId: number, limit: number) => Promise<MemoryRow[]>,
  agentId: number,
  query: MemoryQuery,
  currentTick: number,
): Promise<MemoryRow[]> {
  const candidateLimit = query.limit * 3;

  let candidates: Array<MemoryRow & { _score?: number }>;

  try {
    // Import dynamically so pure callers don't need ollama
    const { callOllamaEmbedding } = await import("./ollama");
    const embedding = await callOllamaEmbedding(query.queryText);
    candidates = await vectorSearchFn(agentId, embedding, candidateLimit);
  } catch {
    // Fallback: get most recent memories without vector similarity
    candidates = await fallbackFn(agentId, candidateLimit);
  }

  if (candidates.length === 0) return [];

  // Score with vector relevance if available
  const relatedAgentSet = new Set(query.relatedAgents ?? []);
  const relatedLocation = query.relatedLocation ?? null;

  const scored = candidates.map((memory) => {
    const ticksAgo = Math.max(0, currentTick - memory.created_at);
    const hoursAgo = ticksAgo / 60;
    const recency = Math.exp(-hoursAgo / (24 * 7));
    const importance = memory.importance / 10;

    let agentBonus = 0;
    const relatedAgents = (memory.metadata?.related_agents as number[] | undefined) ?? [];
    for (const aid of relatedAgents) {
      if (relatedAgentSet.has(aid)) {
        agentBonus += 0.15;
      }
    }

    const locationBonus =
      relatedLocation != null && (memory.metadata?.location_id as number | null) === relatedLocation
        ? 0.1
        : 0;

    const accessPenalty = 0; // access_count removed; no penalty applied

    // Use vector score if available, otherwise 0.5 as neutral
    const relevance = (memory as { _score?: number })._score ?? 0.5;

    const score =
      relevance * 0.35 +
      recency * 0.3 +
      importance * 0.2 +
      agentBonus +
      locationBonus -
      accessPenalty;

    return { memory, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const result = scored.slice(0, query.limit).map((s) => s.memory);

  // Update last_accessed for retrieved memories
  if (result.length > 0) {
    const { db: dbInstance } = await import("../db");
    const { memories: memoriesTable } = await import("../db/schema");
    const { eq: eqOp } = await import("drizzle-orm");
    for (const mem of result) {
      dbInstance.update(memoriesTable).set({
        last_accessed: currentTick,
      }).where(eqOp(memoriesTable.id, mem.id)).run();
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Creation: Conversation Memory
// ---------------------------------------------------------------------------

/**
 * Create memory insert data from a completed conversation.
 *
 * Uses rule-based summary generation (no LLM call needed).
 * Returns the data object — caller is responsible for inserting.
 */
export function createConversationMemory(
  agentId: number,
  conversation: {
    messages: Array<{ text: string; speakerId?: number }>;
    sentiment: number;
    topic?: string | null;
  },
  otherAgentNames: string[],
  otherAgentIds: number[],
  worldTick: number,
  locationId: number | null,
): MemoryInsertData {
  const names = otherAgentNames.join(" and ");
  const sentiment = conversation.sentiment;
  const topic = conversation.topic;
  const messages = conversation.messages;

  // Extract the most memorable quote from the other person (first non-self message)
  let quote = '';
  for (const msg of messages) {
    if (msg.speakerId && msg.speakerId !== agentId && msg.text) {
      // Take first ~80 chars of their most significant message
      const candidates = messages
        .filter(m => m.speakerId && m.speakerId !== agentId)
        .sort((a, b) => b.text.length - a.text.length);
      if (candidates.length > 0) {
        const text = candidates[0].text;
        quote = text.length > 80 ? text.substring(0, 77) + '...' : text;
      }
      break;
    }
  }

  // Build memory content that captures what actually happened
  let content: string;
  const topicStr = topic ? ` about ${topic}` : '';

  if (messages.length <= 1) {
    // Template conversation — brief exchange
    if (messages.length === 1 && messages[0].text) {
      content = `Ran into ${names}. They said: "${messages[0].text.substring(0, 100)}"`;
    } else {
      content = `Brief exchange with ${names}${topicStr}.`;
    }
  } else if (sentiment > 0.5) {
    content = quote
      ? `Had a wonderful conversation with ${names}${topicStr}. ${names} said: "${quote}"`
      : `Had a really good talk with ${names}${topicStr}. Left feeling warm.`;
  } else if (sentiment > 0.1) {
    content = quote
      ? `Talked with ${names}${topicStr}. They mentioned: "${quote}"`
      : `Nice chat with ${names}${topicStr}.`;
  } else if (sentiment > -0.2) {
    content = quote
      ? `Had a conversation with ${names}${topicStr}. "${quote}"`
      : `Spoke with ${names}${topicStr}. Nothing remarkable.`;
  } else if (sentiment > -0.5) {
    content = quote
      ? `Tense exchange with ${names}${topicStr}. They said: "${quote}"`
      : `Things were awkward with ${names}${topicStr}. There's tension between us.`;
  } else {
    content = quote
      ? `Got into it with ${names}${topicStr}. "${quote}" — that really got to me.`
      : `Argued with ${names}${topicStr}. It went badly. I'm still upset.`;
  }

  // importance = ceil(|sentiment| * 5) + 2, clamped to 2-7
  // Boost importance for conversations with quotes (they're more memorable)
  let importance = Math.min(7, Math.ceil(Math.abs(sentiment) * 5) + 2);
  if (quote) importance = Math.min(8, importance + 1);

  return {
    agent_id: agentId,
    description: content,
    type: "conversation",
    importance,
    emotional_valence: sentiment,
    embedding: null, // Caller should compute via Ollama if needed
    depth: 0,
    created_at: worldTick,
    last_accessed: worldTick,
    metadata: {
      related_agents: otherAgentIds,
      location_id: locationId,
      tags: topic ? [topic] : [],
    },
    is_active: 1,
    parent_ids: [],
  };
}

// ---------------------------------------------------------------------------
// Creation: Observation Memory
// ---------------------------------------------------------------------------

/**
 * Create memory insert data for an observation.
 * Returns the data object — caller is responsible for inserting.
 */
export function createObservationMemory(
  agentId: number,
  description: string,
  involvedAgents: number[],
  locationId: number | null,
  importance: number,
  valence: number,
  worldTick: number,
): MemoryInsertData {
  return {
    agent_id: agentId,
    description,
    type: "observation",
    importance: Math.min(10, Math.max(1, importance)),
    emotional_valence: Math.min(1, Math.max(-1, valence)),
    embedding: null, // Caller should compute via Ollama if needed
    depth: 0,
    created_at: worldTick,
    last_accessed: worldTick,
    metadata: {
      related_agents: involvedAgents,
      location_id: locationId,
      tags: [],
    },
    is_active: 1,
    parent_ids: [],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight topic extraction from message texts.
 * Mirrors the approach in topics.ts but returns a short list for memory content.
 */
// Topic keywords kept for reference but no longer used for memory summaries
