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
import { currentWorldEpoch } from '../worldEpoch';
import {
  WRITE_QUEUE_FLUSH_MS,
  WRITE_QUEUE_MAX_SIZE,
  WRITE_QUEUE_HARD_CAP,
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
  /** The tick the memory happened on (`created_at`), not the tick the batch is flushed on. */
  tick: number;
  /**
   * World epoch at record time (lib/worldEpoch.ts). A flush drops entries of a
   * world that has since been swapped out, whatever the order in which the
   * swap, `clear()` and the flush's own embedding await interleave.
   */
  epoch: number;
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
  private droppedMemories = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInProgress = false;
  /** Bumped by clear(); a flush only acts if the generation it started in is still current. */
  private generation = 0;

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

  /**
   * Set the tick counter. The tick loop calls it every tick (engine/tick.ts) —
   * it used to be called from one conversation helper only, so `created_at` /
   * `last_accessed` stamps and the recency term of retrieval stood still
   * between conversation turns. Stamps are TICKS (`world.time.totalTicks`),
   * which is what the consolidator and retention convert from (TickClock).
   */
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
    // A flush may still be awaiting its embeddings. Bumping the generation
    // disowns it: it will neither insert its (old-world) batch nor touch the
    // flag below, which from here on belongs to the new world's flushes.
    this.generation++;
    this.flushInProgress = false;
    this.loadedAgents.clear();
    this.cache.clear();
    this.queryCache.clear();
    this.batcher.clear();
  }

  /**
   * Write every queued memory now instead of on the flush timer, waiting for
   * the embeddings. Resolves true once the queue is empty and no flush is in
   * flight, false when `timeoutMs` ran out first (the rest stays queued and is
   * written by the normal timer later).
   *
   * For taking a save (lib/saves.ts): up to a full batch of memories sits in
   * the queue for WRITE_QUEUE_FLUSH_MS, longer while the embedder is slow, and
   * a backup taken in that window silently leaves them out of the save. A
   * bounded wait, because the embedder is the LLM server and the tick loop is
   * paused while this runs — a hung Ollama must not freeze the game.
   */
  async flushPending(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const generation = this.generation;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // A clear() mid-wait (world replaced) disowns the queue: stop waiting.
    while ((this.queue.length > 0 || this.flushInProgress) && generation === this.generation) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Someone else's flush is awaiting its embeddings: poll until it ends.
      // Otherwise run one batch ourselves (flush() takes at most one), never
      // waiting past the deadline for it.
      const work = this.flushInProgress ? null : this.flush();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<void>((resolve) => { timer = setTimeout(resolve, work ? remaining : Math.min(remaining, 50)); });
      await (work ? Promise.race([work, wait]) : wait);
      clearTimeout(timer);
    }
    return this.queue.length === 0 && !this.flushInProgress;
  }

  /**
   * Forget cached vectors so they are reloaded from the DB — after the
   * embedding backfill rewrote them. Unlike clear(), pending writes stay.
   */
  invalidateEmbeddings(): void {
    this.loadedAgents.clear();
    this.cache.clear();
    this.queryCache.clear();
    this.batcher.clearReadCache();
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
      tick: this.currentTick,
      epoch: currentWorldEpoch(),
    });

    if (this.queue.length > WRITE_QUEUE_HARD_CAP) this.dropLeastImportant();

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
    // A failed embedding comes back as all zeros (relevance 0 for every
    // memory, so retrieval falls back to recency/importance). Caching it made
    // one timeout — Ollama still loading the model at startup — stick to that
    // query for good; the self-description and reflection queries repeat daily.
    if (vec.some((v) => v !== 0)) this.queryCache.set(query, vec);
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
   * Past WRITE_QUEUE_HARD_CAP, evict the pending memory with the lowest
   * priority × importance. Only reachable when embeddings have been failing
   * to come back for a long time; warns so the loss is never silent.
   */
  private dropLeastImportant(): void {
    let worst = 0;
    const score = (e: QueueEntry) => e.priority * e.importance;
    for (let i = 1; i < this.queue.length; i++) {
      if (score(this.queue[i]) < score(this.queue[worst])) worst = i;
    }
    this.queue.splice(worst, 1);
    this.droppedMemories++;
    if (this.droppedMemories === 1 || this.droppedMemories % 100 === 0) {
      console.warn(
        `[MemoryService] write queue over ${WRITE_QUEUE_HARD_CAP} pending; ` +
        `dropped ${this.droppedMemories} least-important memories so far`,
      );
    }
  }

  /**
   * Flush one batch of the write queue: embed descriptions, batch-insert,
   * update cache — then keep going while a backlog remains.
   *
   * This used to drain the whole queue and, past WRITE_QUEUE_MAX_SIZE, keep
   * the top entries and discard the rest, so a slow embedding (which is what
   * lets the queue grow) silently cost agents their memories. It also never
   * looked at the queue again when it finished: records that arrived while it
   * was awaiting the embedding found `flushInProgress` set, their flush
   * returned early, and they sat there until some unrelated record() came by.
   */
  private async flush(): Promise<void> {
    if (this.flushInProgress) return;
    if (this.queue.length === 0) return;

    this.flushInProgress = true;
    const generation = this.generation;

    try {
      // Oldest first, one batch at a time; the rest waits for the next round.
      const batch = this.queue.splice(0, WRITE_QUEUE_MAX_SIZE);

      // Embed all descriptions
      const descriptions = batch.map((e) => e.description);
      let vectors: Float32Array[];
      try {
        vectors = await this.batcher.embedForWrite(descriptions);
      } catch {
        vectors = descriptions.map(() => new Float32Array(EMBEDDING_DIMENSIONS));
      }

      // The world was replaced while we waited: these memories belong to agents
      // that no longer exist, and SQLite reuses agent ids, so inserting them
      // would hand strangers' memories to the new townsfolk.
      if (generation !== this.generation) return;

      // Late writers: an LLM task that outlived a world reset (a self-description,
      // a conversation summary) records for agents the wipe deleted, after
      // clear() already bumped the generation. The FK then failed the whole
      // batch, and the rejection — nobody awaits a timer flush — crashed the
      // server. Keep only rows whose agent still exists.
      // Entries recorded in a world swapped out since go too: the swap bumps the
      // epoch before `clear()` runs, and a caller can record in between — for
      // an agent id the new world reuses, which the existence check can't see.
      const worldEpoch = currentWorldEpoch();
      const live = this.store.existingAgentIds([...new Set(batch.map((e) => e.agentId))]);
      const keep = batch.map((_, i) => i).filter((i) => batch[i].epoch === worldEpoch && live.has(batch[i].agentId));
      if (keep.length < batch.length) {
        console.warn(`[memory] dropped ${batch.length - keep.length} memories of agents or worlds that no longer exist`);
      }

      // Build insert items
      const insertItems = keep.map((i) => batch[i]).map((entry, n) => ({
        agentId: entry.agentId,
        type: entry.type,
        description: entry.description,
        importance: entry.importance,
        emotional_valence: entry.emotional_valence,
        embedding: vectors[keep[n]] ? float32ArrayToBuffer(vectors[keep[n]]) : null,
        metadata: entry.metadata,
        currentTick: entry.tick,
        depth: entry.depth,
        parentIds: entry.parentIds,
      }));

      // Batch insert. A failure loses this batch but must not escape: every
      // flush but flushPending's runs from a timer as `void this.flush()`.
      let inserted: ReturnType<MemoryStore['insertBatch']>;
      try {
        inserted = this.store.insertBatch(insertItems);
      } catch (err) {
        console.error(`[memory] failed to write ${insertItems.length} memories:`, err);
        return;
      }

      // Update EmbeddingCache for each newly inserted memory
      for (let i = 0; i < inserted.length; i++) {
        const row = inserted[i];
        const vec = vectors[keep[i]];
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
      // A disowned flush leaves the flag and the queue to the new generation:
      // clearing the flag here could let a second flush run alongside one the
      // new world already started.
      if (generation === this.generation) {
        this.flushInProgress = false;
        // Backlog, or records that arrived mid-flush: flush again (immediately
        // when a full batch is waiting, otherwise after the usual short delay).
        if (this.queue.length > 0) this.scheduleFlush();
      }
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

export function float32ArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
