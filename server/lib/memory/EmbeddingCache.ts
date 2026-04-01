import { CACHE_CAPACITY_PER_AGENT, EMBEDDING_DIMENSIONS } from './constants';
import { partialSort } from './RetrievalEngine';

interface CacheEntry {
  memoryId: number;
  importance: number;
  lastAccessed: number;
  /** Pre-normalized L2 unit vector; zero vector if input norm was 0. */
  vector: Float32Array;
}

/**
 * L2-normalize a Float32Array in-place, returning it.
 * If the norm is 0 (zero vector), returns the vector unchanged.
 */
function normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    sumSq += v[i] * v[i];
  }
  if (sumSq === 0) return v;
  const norm = Math.sqrt(sumSq);
  for (let i = 0; i < v.length; i++) {
    v[i] /= norm;
  }
  return v;
}

/**
 * Dot product of two Float32Arrays of equal length.
 * When both vectors are L2-normalized this equals cosine similarity.
 */
function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Per-agent in-memory vector index with LRU eviction.
 *
 * - Stores one Map<memoryId, CacheEntry> per agent.
 * - Vectors are L2-normalized at insert time so dot product == cosine similarity.
 * - When the per-agent map reaches `capacity`, the entry with the lowest
 *   `lastAccessed` tick is evicted before inserting the new one.
 * - Top-K search uses `partialSort` (O(n·k)) instead of a full sort.
 */
export class EmbeddingCache {
  private readonly capacity: number;
  private readonly dims: number;
  /** agentId → (memoryId → CacheEntry) */
  private readonly store: Map<number, Map<number, CacheEntry>> = new Map();

  constructor(
    capacity: number = CACHE_CAPACITY_PER_AGENT,
    dims: number = EMBEDDING_DIMENSIONS,
  ) {
    this.capacity = capacity;
    this.dims = dims;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private getOrCreateAgent(agentId: number): Map<number, CacheEntry> {
    let map = this.store.get(agentId);
    if (!map) {
      map = new Map();
      this.store.set(agentId, map);
    }
    return map;
  }

  /** Evict the entry with the smallest `lastAccessed` from the agent's map. */
  private evictLRU(agentMap: Map<number, CacheEntry>): void {
    let lruKey: number | undefined;
    let lruTick = Infinity;

    for (const [key, entry] of agentMap) {
      if (entry.lastAccessed < lruTick) {
        lruTick = entry.lastAccessed;
        lruKey = key;
      }
    }

    if (lruKey !== undefined) {
      agentMap.delete(lruKey);
    }
  }

  // ── Public interface ─────────────────────────────────────────────────────

  /**
   * Insert or replace a vector for (agentId, memoryId).
   * The vector is copied and L2-normalized before storage.
   * Triggers LRU eviction if the agent's cache is at capacity.
   */
  add(
    agentId: number,
    memoryId: number,
    importance: number,
    lastAccessed: number,
    vector: Float32Array,
  ): void {
    const agentMap = this.getOrCreateAgent(agentId);

    // Evict before inserting a genuinely new entry (don't evict on update).
    if (!agentMap.has(memoryId) && agentMap.size >= this.capacity) {
      this.evictLRU(agentMap);
    }

    // Copy and normalize so the original caller's array is not mutated.
    const normalized = normalize(new Float32Array(vector));

    agentMap.set(memoryId, { memoryId, importance, lastAccessed, vector: normalized });
  }

  /**
   * Return the top-K entries most similar to `queryVector` for `agentId`.
   * Results are sorted by similarity descending.
   */
  search(
    agentId: number,
    queryVector: Float32Array,
    topK: number,
  ): Array<{ memoryId: number; importance: number; lastAccessed: number; similarity: number }> {
    const agentMap = this.store.get(agentId);
    if (!agentMap || agentMap.size === 0) return [];

    // Normalize the query (copy so caller's array is unchanged).
    const q = normalize(new Float32Array(queryVector));

    type Candidate = { memoryId: number; importance: number; lastAccessed: number; similarity: number };
    const candidates: Candidate[] = [];

    for (const entry of agentMap.values()) {
      const similarity = dotProduct(q, entry.vector);
      candidates.push({
        memoryId: entry.memoryId,
        importance: entry.importance,
        lastAccessed: entry.lastAccessed,
        similarity,
      });
    }

    // partialSort with compareFn returning >0 when a should come before b
    return partialSort(candidates, topK, (a, b) => a.similarity - b.similarity);
  }

  /** Update the `lastAccessed` tick for a stored entry (no-op if not found). */
  updateLastAccessed(agentId: number, memoryId: number, tick: number): void {
    const entry = this.store.get(agentId)?.get(memoryId);
    if (entry) {
      entry.lastAccessed = tick;
    }
  }

  /** Remove all entries for all agents. */
  clear(): void {
    this.store.clear();
  }

  /** Remove all entries for a single agent. */
  clearAgent(agentId: number): void {
    this.store.delete(agentId);
  }

  /** Number of cached entries for `agentId` (0 if the agent is unknown). */
  getAgentSize(agentId: number): number {
    return this.store.get(agentId)?.size ?? 0;
  }
}
