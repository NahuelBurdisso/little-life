export type MemoryType =
  | 'observation'
  | 'experience'
  | 'opinion'
  | 'reflection'
  | 'plan'
  | 'conversation'
  | 'secret'
  | 'gossip';

export interface Memory {
  id: number;
  agent_id: number;
  type: MemoryType;
  description: string;
  importance: number;
  emotional_valence: number;
  depth: number;
  created_at: number;
  last_accessed: number;
  embedding: Buffer | null;
  metadata: Record<string, unknown>;
  is_active: number;
  parent_ids: number[];
}

export interface NewMemory {
  agentId: number;
  type: MemoryType;
  description: string;
  importance: number;
  emotional_valence: number;
  metadata?: Record<string, unknown>;
}

export interface RetrievalResult {
  memory: Memory;
  score: number;
  recencyScore: number;
  importanceScore: number;
  relevanceScore: number;
}

export interface ScoredCandidate {
  memoryId: number;
  lastAccessed: number;
  importance: number;
  similarity: number;
}

export interface RetrievalStrategy {
  queries: string[];
  topK: number;
  tokenBudget: number;
  deduplicate: boolean;
  boostTypes?: MemoryType[];
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface ContextItem {
  type: 'situation' | 'state' | 'memory';
  text: string;
}
