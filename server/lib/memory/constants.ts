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
