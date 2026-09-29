import { CONFIG } from '../constants';

export const DECAY_RATE = 0.995;
export const SCORE_WEIGHTS = { recency: 1, importance: 1, relevance: 1 };
export const CACHE_CAPACITY_PER_AGENT = 1000;
export const EMBEDDING_DIMENSIONS = 1024;
export const WRITE_BATCH_FLUSH_MS = 50;
export const WRITE_BATCH_MAX_SIZE = 20;
export const READ_TIMEOUT_MS = 5000;
export const TEXT_CACHE_CAPACITY = 500;
export const QUERY_CACHE_CAPACITY = 200;
export const WRITE_QUEUE_FLUSH_MS = 50;
export const WRITE_QUEUE_MAX_SIZE = 30;
/**
 * Memory-bound safety net for MemoryService's write queue, not a batch size:
 * the backlog is flushed WRITE_QUEUE_MAX_SIZE at a time, and only past this
 * many pending memories (an embedding server down for a long while) does it
 * start dropping the least important ones, with a warning.
 */
export const WRITE_QUEUE_HARD_CAP = 5000;
export const CONVERSATION_TOKEN_BUDGET = 300;
export const CHARS_PER_TOKEN = 3.5;
export const CONVERSATION_TOP_K = 5;
export const TYPE_PRIORITY: Record<string, number> = {
  conversation: 3,
  secret: 3,
  reflection: 3,
  observation: 2,
  gossip: 2,
  plan: 2,
  experience: 1,
  opinion: 1,
};
export const OLLAMA_BASE_URL = CONFIG.AI.EMBED_BASE_URL;
export const OLLAMA_EMBED_MODEL = CONFIG.AI.EMBEDDING_MODEL;
/**
 * Sent with every embedding request. Without it the embedding model unloads
 * after Ollama's default 5 idle minutes; reloading it takes ~14 s on Windows,
 * longer than READ_TIMEOUT_MS, and a request aborted mid-load cancels the
 * load — so every retrieval failed (zero vectors) until a slower write batch
 * happened to finish loading it.
 */
export const EMBED_KEEP_ALIVE = CONFIG.AI.KEEP_ALIVE;
