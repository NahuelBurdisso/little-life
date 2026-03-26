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

import { CONFIG } from "../lib/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The shape of a memory row from the DB. */
export interface MemoryRow {
  id: number;
  agent_id: number;
  content: string;
  type: string;
  importance: number;
  emotional_valence: number;
  embedding: Buffer | null;
  related_agents: number[];
  related_location: number | null;
  tags: string[];
  timestamp: number;
  access_count: number;
  last_accessed: number;
}

/** Data ready to be inserted into the memories table. */
export interface MemoryInsertData {
  agent_id: number;
  content: string;
  type: string;
  importance: number;
  emotional_valence: number;
  embedding: Buffer | null;
  related_agents: number[];
  related_location: number | null;
  tags: string[];
  timestamp: number;
  access_count: number;
  last_accessed: number;
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
    const ticksAgo = Math.max(0, currentTick - memory.timestamp);
    const hoursAgo = ticksAgo / 60;
    const recency = Math.exp(-hoursAgo / (24 * 7));
    const importance = memory.importance / 10;

    let agentBonus = 0;
    for (const aid of memory.related_agents) {
      if (relatedAgentSet.has(aid)) {
        agentBonus += 0.15;
      }
    }

    const locationBonus =
      relatedLocation != null && memory.related_location === relatedLocation
        ? 0.1
        : 0;

    const accessPenalty = Math.min(
      memory.access_count * CONFIG.AI.MEMORY_ACCESS_PENALTY,
      CONFIG.AI.MEMORY_ACCESS_PENALTY_MAX,
    );

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

  // Update access tracking for retrieved memories
  if (result.length > 0) {
    const { db: dbInstance } = await import("../db");
    const { memories: memoriesTable } = await import("../db/schema");
    const { eq: eqOp } = await import("drizzle-orm");
    for (const mem of result) {
      dbInstance.update(memoriesTable).set({
        access_count: mem.access_count + 1,
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
    messages: Array<{ text: string }>;
    sentiment: number;
  },
  otherAgentNames: string[],
  otherAgentIds: number[],
  worldTick: number,
  locationId: number | null,
): MemoryInsertData {
  const names = otherAgentNames.join(" and ");
  const sentiment = conversation.sentiment;

  // Extract topics from messages
  const topicKeywords = extractSimpleTopics(conversation.messages);
  const topicsStr =
    topicKeywords.length > 0 ? topicKeywords.join(", ") : "various things";

  // Build summary based on sentiment
  let content: string;
  if (sentiment > 0.5) {
    content = `Had a great conversation with ${names} about ${topicsStr}.`;
  } else if (sentiment > 0) {
    content = `Chatted with ${names} about ${topicsStr}. It was pleasant.`;
  } else if (sentiment > -0.3) {
    content = `Talked with ${names} about ${topicsStr}. Nothing special.`;
  } else if (sentiment > -0.6) {
    content = `Had an awkward conversation with ${names}. It was tense.`;
  } else {
    content = `Got into an argument with ${names} about ${topicsStr}. It went badly.`;
  }

  // importance = ceil(|sentiment| * 5) + 2, clamped to 2-7
  const importance = Math.min(7, Math.ceil(Math.abs(sentiment) * 5) + 2);

  return {
    agent_id: agentId,
    content,
    type: "conversation",
    importance,
    emotional_valence: sentiment,
    embedding: null, // Caller should compute via Ollama if needed
    related_agents: otherAgentIds,
    related_location: locationId,
    tags: topicKeywords,
    timestamp: worldTick,
    access_count: 0,
    last_accessed: worldTick,
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
    content: description,
    type: "observation",
    importance: Math.min(10, Math.max(1, importance)),
    emotional_valence: Math.min(1, Math.max(-1, valence)),
    embedding: null, // Caller should compute via Ollama if needed
    related_agents: involvedAgents,
    related_location: locationId,
    tags: [],
    timestamp: worldTick,
    access_count: 0,
    last_accessed: worldTick,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight topic extraction from message texts.
 * Mirrors the approach in topics.ts but returns a short list for memory content.
 */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  work: ["work", "job", "farm", "shop", "harvest", "busy", "salary"],
  food: ["eat", "hungry", "cook", "bread", "meal", "dinner", "lunch"],
  weather: ["rain", "sun", "storm", "cold", "warm", "weather"],
  relationships: ["friend", "love", "like", "together"],
  health: ["sick", "tired", "doctor", "medicine", "rest"],
  money: ["coin", "money", "buy", "sell", "price", "expensive"],
  town: ["town", "festival", "event", "mayor"],
  feelings: ["happy", "sad", "angry", "worried", "excited"],
};

function extractSimpleTopics(messages: Array<{ text: string }>): string[] {
  if (messages.length === 0) return [];

  const combined = messages
    .map((m) => m.text)
    .join(" ")
    .toLowerCase();

  const matched: string[] = [];
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const keyword of keywords) {
      if (combined.includes(keyword)) {
        matched.push(topic);
        break;
      }
    }
  }

  // Return at most 3 topics
  return matched.slice(0, 3);
}
