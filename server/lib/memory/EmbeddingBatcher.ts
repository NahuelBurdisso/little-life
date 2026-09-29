import type { EmbeddingProvider } from './types';
import {
  OLLAMA_BASE_URL,
  OLLAMA_EMBED_MODEL,
  READ_TIMEOUT_MS,
  TEXT_CACHE_CAPACITY,
  WRITE_BATCH_FLUSH_MS,
  WRITE_BATCH_MAX_SIZE,
  EMBEDDING_DIMENSIONS,
  EMBED_KEEP_ALIVE,
} from './constants';
import { QueryCache } from './QueryCache';
import { acquireEmbeddingSlot, type LLMPriority } from '../../ai/llmSemaphore';

/*
 * Every request to the embedding endpoint goes through the embedding pool of
 * ai/llmSemaphore.ts. It used to call fetch directly, so any number of memory
 * writes and retrieval queries could hit the embedding server at once during
 * the same spikes the chat semaphore exists to smooth. The pool is separate
 * from the chat slots on purpose (see the header there).
 *
 * Slots are only ever held around the fetch itself; nothing awaits an
 * embedding while holding a slot, so the non-reentrant semaphore cannot
 * deadlock on these calls. directEmbed/tryBatchEndpoint are raw and acquire
 * nothing; the public paths take exactly one slot each.
 */

/**
 * Query embeddings gate a prompt that is about to be sent (ContextBuilder
 * feeds conversation turns), so inside the embedding pool they go ahead of
 * write batches, which are background work.
 */
const READ_PRIORITY: LLMPriority = 'normal';
const WRITE_PRIORITY: LLMPriority = 'low';

/**
 * How long to stop trying `/api/embed` after it answered "no such endpoint".
 * Not forever: Ollama also answers 404 for an unknown or not-yet-pulled model,
 * and the server may be upgraded under a running game.
 */
export const BATCH_ENDPOINT_RETRY_MS = 10 * 60_000;

/** Statuses meaning the batch endpoint itself is missing, not a passing failure. */
const ENDPOINT_MISSING_STATUSES = new Set([404, 405, 501]);

class EndpointMissingError extends Error {}

interface WriteQueueEntry {
  text: string;
  resolve: (vec: Float32Array) => void;
  reject: (err: unknown) => void;
}

export class EmbeddingBatcher implements EmbeddingProvider {
  private baseUrl: string;
  private textCache: QueryCache;
  private inFlight: Map<string, Promise<Float32Array>> = new Map();
  private writeQueue: WriteQueueEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** `/api/embed` is skipped until this time (ms); 0 = try it. */
  private batchEndpointSkipUntil = 0;

  constructor(baseUrl: string = OLLAMA_BASE_URL) {
    this.baseUrl = baseUrl;
    this.textCache = new QueryCache(TEXT_CACHE_CAPACITY);
  }

  /** EmbeddingProvider interface — delegates to write path */
  embed(texts: string[]): Promise<Float32Array[]> {
    return this.embedForWrite(texts);
  }

  /** Write path: queued and flushed in batches */
  embedForWrite(texts: string[]): Promise<Float32Array[]> {
    const promises = texts.map(
      (text) =>
        new Promise<Float32Array>((resolve, reject) => {
          this.writeQueue.push({ text, resolve, reject });
        }),
    );

    this.scheduleFlush();
    return Promise.all(promises);
  }

  /** Read path: immediate, with cache and in-flight dedup */
  async embedForRead(text: string): Promise<Float32Array> {
    // 1. Text cache hit
    const cached = this.textCache.get(text);
    if (cached) return cached;

    // 2. In-flight dedup
    const existing = this.inFlight.get(text);
    if (existing) return existing;

    // 3. Direct call
    const promise = this.withSlot(READ_PRIORITY, () => this.directEmbed(text)).then(
      (vec) => {
        this.textCache.set(text, vec);
        this.inFlight.delete(text);
        return vec;
      },
      (err) => {
        this.inFlight.delete(text);
        console.warn('[EmbeddingBatcher] embedForRead failed:', err);
        return new Float32Array(EMBEDDING_DIMENSIONS);
      },
    );

    this.inFlight.set(text, promise);
    return promise;
  }

  clear(): void {
    this.textCache.clear();
    this.inFlight.clear();
    this.writeQueue.length = 0;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushWrites();
    }, WRITE_BATCH_FLUSH_MS);

    // If the queue is already at max size, flush immediately (cancel timer first)
    if (this.writeQueue.length >= WRITE_BATCH_MAX_SIZE) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      void this.flushWrites();
    }
  }

  private async flushWrites(): Promise<void> {
    if (this.writeQueue.length === 0) return;

    // Drain the queue
    const batch = this.writeQueue.splice(0, this.writeQueue.length);
    const texts = batch.map((e) => e.text);

    let vectors: Float32Array[];
    try {
      // One slot for the whole batch, fallback included (see batchEmbed).
      vectors = await this.withSlot(WRITE_PRIORITY, () => this.batchEmbed(texts));
    } catch (err) {
      console.warn('[EmbeddingBatcher] flushWrites batchEmbed failed:', err);
      vectors = texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS));
    }

    for (let i = 0; i < batch.length; i++) {
      batch[i].resolve(vectors[i] ?? new Float32Array(EMBEDDING_DIMENSIONS));
    }
  }

  /**
   * Try the batch endpoint first; fall back to sequential directEmbed calls
   * only when the server says it has no such endpoint.
   *
   * The first failure of any kind used to disable `/api/embed` for the life of
   * the process, so one timeout at startup (Ollama still loading the model)
   * put every later batch on the one-request-per-text path. A timeout or
   * network error now just fails this batch — the fallback would hit the same
   * sick server N times over, each with its own timeout, inside one slot.
   */
  private async batchEmbed(texts: string[]): Promise<Float32Array[]> {
    if (Date.now() >= this.batchEndpointSkipUntil) {
      try {
        return await this.tryBatchEndpoint(texts);
      } catch (err) {
        if (!(err instanceof EndpointMissingError)) throw err;
        console.warn(
          `[EmbeddingBatcher] ${err.message}; falling back to sequential for ${BATCH_ENDPOINT_RETRY_MS / 60_000} min`,
        );
        this.batchEndpointSkipUntil = Date.now() + BATCH_ENDPOINT_RETRY_MS;
      }
    }

    // Sequential fallback. Genuinely one at a time: the caller holds a single
    // semaphore slot for this batch, and firing all of them in parallel (as
    // this used to) would put up to WRITE_BATCH_MAX_SIZE requests on Ollama
    // behind one slot's worth of accounting.
    const vectors: Float32Array[] = [];
    for (const t of texts) {
      vectors.push(await this.directEmbed(t));
    }
    return vectors;
  }

  private async withSlot<T>(priority: LLMPriority, fn: () => Promise<T>): Promise<T> {
    const release = await acquireEmbeddingSlot(priority);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** POST /api/embed with array input (newer Ollama) */
  private async tryBatchEndpoint(texts: string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: texts, keep_alive: EMBED_KEEP_ALIVE }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const message = `/api/embed responded ${res.status}`;
      throw ENDPOINT_MISSING_STATUSES.has(res.status) ? new EndpointMissingError(message) : new Error(message);
    }

    const data = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings)) {
      throw new Error('/api/embed response missing embeddings array');
    }

    return data.embeddings.map((e) => new Float32Array(e));
  }

  /** POST /api/embeddings with single prompt (original Ollama API) */
  private async directEmbed(text: string): Promise<Float32Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text, keep_alive: EMBED_KEEP_ALIVE }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`/api/embeddings responded ${res.status}`);
    }

    const data = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) {
      throw new Error('/api/embeddings response missing embedding array');
    }

    return new Float32Array(data.embedding);
  }
}
