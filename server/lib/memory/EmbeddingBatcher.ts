import type { EmbeddingProvider } from './types';
import {
  OLLAMA_BASE_URL,
  OLLAMA_EMBED_MODEL,
  READ_TIMEOUT_MS,
  TEXT_CACHE_CAPACITY,
  WRITE_BATCH_FLUSH_MS,
  WRITE_BATCH_MAX_SIZE,
  EMBEDDING_DIMENSIONS,
} from './constants';
import { QueryCache } from './QueryCache';
import { acquireLLMSlot, type LLMPriority } from '../../ai/llmSemaphore';

/*
 * Every request to the embedding endpoint goes through the global LLM
 * semaphore. It used to call fetch directly, so memory writes and retrieval
 * queries piled on top of the 8 chat requests the semaphore was admitting —
 * on the same Ollama — exactly during the spikes the semaphore exists for.
 *
 * Slots are only ever held around the fetch itself (here and in ai/ollama.ts);
 * nothing awaits an embedding while holding a slot, so the non-reentrant
 * semaphore cannot deadlock on these calls. directEmbed/tryBatchEndpoint are
 * raw and acquire nothing; the public paths take exactly one slot each.
 */

/**
 * Query embeddings gate a prompt that is about to be sent: ContextBuilder
 * retrieves memories for conversations, which are themselves `critical`. At a
 * lower tier the lookup would queue behind every planning request and delay
 * the conversation it feeds (priority inversion). They are tiny, so jumping
 * the queue costs the chats behind them next to nothing.
 */
const READ_PRIORITY: LLMPriority = 'critical';

/**
 * Memory writes are background work. The semaphore ages waiters, so a busy
 * spell delays them but cannot starve them (MemoryService holds its flush
 * until they land).
 */
const WRITE_PRIORITY: LLMPriority = 'low';

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
  private batchSupported: boolean | null = null;

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

  /** Try batch endpoint first; fall back to sequential directEmbed calls */
  private async batchEmbed(texts: string[]): Promise<Float32Array[]> {
    if (this.batchSupported !== false) {
      try {
        const result = await this.tryBatchEndpoint(texts);
        this.batchSupported = true;
        return result;
      } catch (err) {
        if (this.batchSupported === null) {
          // First attempt failed — mark as unsupported and fall through
          console.warn('[EmbeddingBatcher] /api/embed not available, falling back to sequential');
          this.batchSupported = false;
        } else {
          // Was previously working, surface the error
          throw err;
        }
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
    const release = await acquireLLMSlot(priority);
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
        body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: texts }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`/api/embed responded ${res.status}`);
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
        body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
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
