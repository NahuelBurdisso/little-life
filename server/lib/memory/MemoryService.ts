import type {
  Memory,
  RetrievalResult,
  RetrievalStrategy,
  ScoredCandidate,
} from './types';
import { simEvents } from '../simEvents';
import { MemoryStore } from './MemoryStore';
import { EmbeddingCache } from './EmbeddingCache';
import { EmbeddingBatcher } from './EmbeddingBatcher';
import { QueryCache } from './QueryCache';
import { getImportance, getTypePriority } from './ImportanceScorer';
import { rankCandidates } from './RetrievalEngine';
import {
  WRITE_QUEUE_FLUSH_MS,
  WRITE_QUEUE_MAX_SIZE,
  CACHE_CAPACITY_PER_AGENT,
  EMBEDDING_DIMENSIONS,
  CHARS_PER_TOKEN,
} from './constants';

// ---------------------------------------------------------------------------
// Internal queue entry
// ---------------------------------------------------------------------------

interface QueueEntry {
  agentId: number;
  type: string;
  description: string;
  importance: number;
  emotional_valence: number;
  metadata: Record<string, unknown>;
  priority: number; // getTypePriority result, cached here for overflow sort
  depth: number;
  parentIds: number[];
}

// ---------------------------------------------------------------------------
// MemoryService
// ---------------------------------------------------------------------------

export class MemoryService {
  private store: MemoryStore;
  private cache: EmbeddingCache;
  private batcher: EmbeddingBatcher;
  private queryCache: QueryCache;

  private currentTick = 0;
  private queue: QueueEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInProgress = false;

  /** Tracks which agents have had their embeddings loaded into EmbeddingCache. */
  private loadedAgents: Set<number> = new Set();

  constructor(
    store?: MemoryStore,
    cache?: EmbeddingCache,
    batcher?: EmbeddingBatcher,
    queryCache?: QueryCache,
  ) {
    this.store = store ?? new MemoryStore();
    this.cache = cache ?? new EmbeddingCache(CACHE_CAPACITY_PER_AGENT, EMBEDDING_DIMENSIONS);
    this.batcher = batcher ?? new EmbeddingBatcher();
    this.queryCache = queryCache ?? new QueryCache();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Called each game tick to update the current tick counter. */
  setTick(tick: number): void {
    this.currentTick = tick;
  }

  /**
   * Reset all caches and drain the write queue without persisting.
   */
  clear(): void {
    // Cancel any pending flush timer
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue.length = 0;
    this.flushInProgress = false;
    this.loadedAgents.clear();
    this.cache.clear();
    this.queryCache.clear();
    this.batcher.clear();
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Fire-and-forget memory recording.
   * Computes importance from type unless an override is provided,
   * then enqueues for async batch insert.
   */
  record(
    agentId: number,
    type: string,
    description: string,
    metadata: Record<string, unknown> = {},
    emotionalValence = 0,
    importanceOverride?: number,
    depth = 0,
    parentIds: number[] = [],
  ): void {
    const importance = importanceOverride ?? getImportance(type);
    const priority = getTypePriority(type);

    this.queue.push({
      agentId,
      type,
      description,
      importance,
      emotional_valence: emotionalValence,
      metadata,
      priority,
      depth,
      parentIds,
    });

    this.scheduleFlush();
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Retrieve top-K memories most relevant to `query` for the given agent.
   */
  async retrieve(agentId: number, query: string, topK = 5): Promise<RetrievalResult[]> {
    await this.ensureAgentLoaded(agentId);

    const queryVec = await this.getQueryEmbedding(query);
    const candidates = this.cache.search(agentId, queryVec, topK * 3);

    const scoredCandidates: ScoredCandidate[] = candidates.map((c) => ({
      memoryId: c.memoryId,
      lastAccessed: c.lastAccessed,
      importance: c.importance,
      similarity: c.similarity,
    }));

    const ranked = rankCandidates(scoredCandidates, this.currentTick, topK);
    if (ranked.length === 0) return [];

    const ids = ranked.map((r) => r.memoryId);
    const hydrated = this.store.hydrateByIds(ids);
    this.store.touchMemories(ids, this.currentTick);

    // Update cache last_accessed to match what we just wrote to DB
    for (const id of ids) {
      this.cache.updateLastAccessed(agentId, id, this.currentTick);
    }

    // Build a lookup map for hydrated memories
    const memMap = new Map<number, Memory>(hydrated.map((m) => [m.id, m]));

    return ranked
      .filter((r) => memMap.has(r.memoryId))
      .map((r) => {
        const memory = memMap.get(r.memoryId)!;
        // Decompose the combined score back into components for the result
        return {
          memory,
          score: r.score,
          recencyScore: r.score / 3,      // approximate; full breakdown not stored in rankCandidates
          importanceScore: r.score / 3,
          relevanceScore: r.similarity,
        } satisfies RetrievalResult;
      });
  }

  /**
   * Retrieve using a multi-query strategy with token budget and optional type boost.
   */
  async retrieveWithStrategy(
    agentId: number,
    strategy: RetrievalStrategy,
  ): Promise<RetrievalResult[]> {
    await this.ensureAgentLoaded(agentId);

    // Embed all queries in parallel
    const queryVecs = await Promise.all(
      strategy.queries.map((q) => this.getQueryEmbedding(q)),
    );

    // Collect candidates from all queries
    const allCandidates: ScoredCandidate[] = [];
    for (const qVec of queryVecs) {
      const hits = this.cache.search(agentId, qVec, strategy.topK * 2);
      for (const h of hits) {
        allCandidates.push({
          memoryId: h.memoryId,
          lastAccessed: h.lastAccessed,
          importance: h.importance,
          similarity: h.similarity,
        });
      }
    }

    // Deduplicate by memoryId — keep the highest similarity per memory
    let dedupedMap: Map<number, ScoredCandidate>;
    if (strategy.deduplicate) {
      dedupedMap = new Map();
      for (const c of allCandidates) {
        const existing = dedupedMap.get(c.memoryId);
        if (!existing || c.similarity > existing.similarity) {
          dedupedMap.set(c.memoryId, c);
        }
      }
    } else {
      dedupedMap = new Map(allCandidates.map((c) => [c.memoryId, c]));
    }

    let candidates = Array.from(dedupedMap.values());

    // Optional type boost: boost similarity score for preferred types
    // Hydrate all candidates once; reuse for both type boosting and final results
    const candidateIds = candidates.map((c) => c.memoryId);
    const hydratedAll = this.store.hydrateByIds(candidateIds);
    const hydratedMap = new Map<number, Memory>(hydratedAll.map((m) => [m.id, m]));

    if (strategy.boostTypes && strategy.boostTypes.length > 0) {
      const boostSet = new Set<string>(strategy.boostTypes);
      candidates = candidates.map((c) => {
        const mem = hydratedMap.get(c.memoryId);
        if (mem && boostSet.has(mem.type)) {
          return { ...c, similarity: Math.min(1, c.similarity + 0.15) };
        }
        return c;
      });
    }

    const ranked = rankCandidates(candidates, this.currentTick, strategy.topK);
    if (ranked.length === 0) return [];

    const ids = ranked.map((r) => r.memoryId);
    this.store.touchMemories(ids, this.currentTick);

    for (const id of ids) {
      this.cache.updateLastAccessed(agentId, id, this.currentTick);
    }

    // Reuse already-hydrated memories instead of querying DB again
    const memMap = hydratedMap;

    // Apply token budget truncation
    let tokensBudgeted = 0;
    const results: RetrievalResult[] = [];

    for (const r of ranked) {
      const memory = memMap.get(r.memoryId);
      if (!memory) continue;

      const tokens = memory.description.length / CHARS_PER_TOKEN;
      if (tokensBudgeted + tokens > strategy.tokenBudget) break;

      tokensBudgeted += tokens;
      results.push({
        memory,
        score: r.score,
        recencyScore: r.score / 3,
        importanceScore: r.score / 3,
        relevanceScore: r.similarity,
      });
    }

    return results;
  }

  /**
   * Retrieve all active memories of a given type for an agent.
   */
  async retrieveByType(agentId: number, type: string, limit = 20): Promise<Memory[]> {
    return this.store.getByAgentAndType(agentId, type, limit);
  }

  /**
   * Get most recent active memories for an agent, regardless of type.
   */
  getRecent(agentId: number, limit: number): Memory[] {
    return this.store.getRecentByAgent(agentId, limit);
  }

  /**
   * Expose the underlying store so consolidators can perform batch operations.
   */
  getStore(): MemoryStore {
    return this.store;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Lazy-load embeddings for an agent into EmbeddingCache on first access.
   */
  private async ensureAgentLoaded(agentId: number): Promise<void> {
    if (this.loadedAgents.has(agentId)) return;

    const rows = this.store.loadEmbeddingsForAgent(agentId, CACHE_CAPACITY_PER_AGENT);
    for (const row of rows) {
      const vec = bufferToFloat32Array(row.embedding);
      this.cache.add(agentId, row.id, row.importance, row.lastAccessed, vec);
    }

    this.loadedAgents.add(agentId);
  }

  /**
   * Get embedding for a query string, using QueryCache then EmbeddingBatcher.
   */
  private async getQueryEmbedding(query: string): Promise<Float32Array> {
    const cached = this.queryCache.get(query);
    if (cached) return cached;

    const vec = await this.batcher.embedForRead(query);
    this.queryCache.set(query, vec);
    return vec;
  }

  /**
   * Schedule a flush after WRITE_QUEUE_FLUSH_MS, or immediately if queue is full.
   */
  private scheduleFlush(): void {
    if (this.queue.length >= WRITE_QUEUE_MAX_SIZE) {
      // Flush immediately
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      void this.flush();
      return;
    }

    if (this.flushTimer !== null) return; // already scheduled

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, WRITE_QUEUE_FLUSH_MS);
  }

  /**
   * Flush the write queue: embed descriptions, batch-insert, update cache.
   */
  private async flush(): Promise<void> {
    if (this.flushInProgress) return;
    if (this.queue.length === 0) return;

    this.flushInProgress = true;

    try {
      // Drain queue
      let batch = this.queue.splice(0, this.queue.length);

      // Overflow protection: if we have more than max, keep top priority entries
      if (batch.length > WRITE_QUEUE_MAX_SIZE) {
        batch.sort((a, b) => b.priority * b.importance - a.priority * a.importance);
        batch = batch.slice(0, WRITE_QUEUE_MAX_SIZE);
      }

      // Embed all descriptions
      const descriptions = batch.map((e) => e.description);
      let vectors: Float32Array[];
      try {
        vectors = await this.batcher.embedForWrite(descriptions);
      } catch {
        vectors = descriptions.map(() => new Float32Array(EMBEDDING_DIMENSIONS));
      }

      // Build insert items
      const tick = this.currentTick;
      const insertItems = batch.map((entry, i) => ({
        agentId: entry.agentId,
        type: entry.type,
        description: entry.description,
        importance: entry.importance,
        emotional_valence: entry.emotional_valence,
        embedding: vectors[i] ? float32ArrayToBuffer(vectors[i]) : null,
        metadata: entry.metadata,
        currentTick: tick,
        depth: entry.depth,
        parentIds: entry.parentIds,
      }));

      // Batch insert
      const inserted = this.store.insertBatch(insertItems);

      // Update EmbeddingCache for each newly inserted memory
      for (let i = 0; i < inserted.length; i++) {
        const row = inserted[i];
        const vec = vectors[i];
        if (vec) {
          this.cache.add(row.agent_id, row.id, row.importance, row.last_accessed, vec);
        }
        // Mark agent as loaded so future retrieval doesn't reload from DB unnecessarily
        // (only if we know they were already initialized)
        // Note: we do NOT mark agents as loaded here — they could have older memories in DB
        // that aren't yet in cache. ensureAgentLoaded handles the initial hydration.
      }

      // Emit memory:created events for ReflectionTrigger and other listeners
      for (const row of inserted) {
        simEvents.emit('memory:created', {
          agentId: row.agent_id,
          importance: row.importance,
          type: row.type,
        });
      }
    } finally {
      this.flushInProgress = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Buffer ↔ Float32Array helpers
// ---------------------------------------------------------------------------

function bufferToFloat32Array(buffer: Buffer): Float32Array {
  const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return new Float32Array(uint8.buffer, uint8.byteOffset, uint8.byteLength / 4);
}

function float32ArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
