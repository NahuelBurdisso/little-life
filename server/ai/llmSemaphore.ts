/**
 * Global LLM Semaphore
 *
 * Limits concurrent Ollama requests across ALL systems to prevent
 * saturation when Ollama NUM_PARALLEL=1 (or low). Without this,
 * day-change spikes can fire 30+ concurrent requests → timeout cascade.
 *
 * Priority levels ensure conversations and planning aren't starved
 * by bulk operations like goal reviews.
 *
 * There are two independent pools:
 *  - chat (`acquireLLMSlot`, 8 slots) for every chat/completion request;
 *  - embeddings (`acquireEmbeddingSlot`, 3 slots) for every embedding request.
 * Embeddings deliberately do not share the chat slots. A conversation turn
 * embeds its memory query and then chats, and the whole turn's latency counts
 * against the conversation's game-minute budget (lib/conversationPacing.ts);
 * queueing twice on the same pool cuts more conversations short. And EMBED_BASE_URL may point at a different
 * server than chat, where gating on chat slots would protect nothing.
 */

export type LLMPriority = 'critical' | 'normal' | 'low';

interface QueueEntry {
  priority: LLMPriority;
  resolve: () => void;
  enqueued: number;
}

const PRIORITY_ORDER: Record<LLMPriority, number> = {
  critical: 0,  // conversations, snap resolution
  normal: 1,    // planning, reflections; memory-query embeddings (embedding pool)
  low: 2,       // goal reviews, pivots, self-descriptions; memory-write embeddings (embedding pool)
};

/**
 * A counting semaphore with strict priority: a freed slot goes to the
 * highest-priority waiter, FIFO among equals.
 */
export class PrioritySemaphore {
  private active = 0;
  private readonly waiting: QueueEntry[] = [];

  // Stats for diagnostics
  private totalAcquired = 0;
  private totalWaited = 0;
  private peakActive = 0;
  private peakQueue = 0;

  constructor(private readonly maxConcurrent: number) {}

  private releaseSlot(): void {
    this.active--;

    if (this.waiting.length === 0) return;

    // Pick highest-priority waiter (stable sort by priority then FIFO)
    let bestIdx = 0;
    for (let i = 1; i < this.waiting.length; i++) {
      if (PRIORITY_ORDER[this.waiting[i].priority] < PRIORITY_ORDER[this.waiting[bestIdx].priority]) {
        bestIdx = i;
      }
    }

    const next = this.waiting.splice(bestIdx, 1)[0];
    this.active++;
    if (this.active > this.peakActive) this.peakActive = this.active;
    next.resolve();
  }

  /** Acquire a slot. Returns a release function; call it in a `finally`. */
  async acquire(priority: LLMPriority = 'normal'): Promise<() => void> {
    this.totalAcquired++;

    // One-shot release: a double call (e.g. a `finally` plus an explicit release
    // on an error path) used to decrement `active` twice and permanently
    // over-subscribe the pool, since nothing ever raises it back.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };

    if (this.active < this.maxConcurrent) {
      this.active++;
      if (this.active > this.peakActive) this.peakActive = this.active;
      return release;
    }

    // Wait for a slot
    this.totalWaited++;
    await new Promise<void>((resolve) => {
      this.waiting.push({ priority, resolve, enqueued: Date.now() });
      if (this.waiting.length > this.peakQueue) this.peakQueue = this.waiting.length;
    });

    return release;
  }

  /** Non-blocking stats snapshot for diagnostics / activity log */
  stats() {
    return {
      active: this.active,
      waiting: this.waiting.length,
      totalAcquired: this.totalAcquired,
      totalWaited: this.totalWaited,
      peakActive: this.peakActive,
      peakQueue: this.peakQueue,
      waitingByPriority: {
        critical: this.waiting.filter(w => w.priority === 'critical').length,
        normal: this.waiting.filter(w => w.priority === 'normal').length,
        low: this.waiting.filter(w => w.priority === 'low').length,
      },
    };
  }
}

// Empirically tuned for an RTX 3090 24GB: deep enough to keep Ollama's internal
// batching fed without pushing per-request latency past the conversation timeout.
//
// This deliberately does NOT assume any particular OLLAMA_NUM_PARALLEL — nothing
// in this repo sets it, so whatever the server was started with applies. If you
// run Ollama with a low NUM_PARALLEL, requests above it simply queue inside
// Ollama instead of here; this limit only bounds how many we hand it at once.
const MAX_CONCURRENT = 8;

/**
 * Embedding requests are short, and a write batch carries up to 20 texts in
 * one request. Three slots let a query embedding run alongside a write batch
 * or two without handing the embedding server an unbounded burst.
 */
const EMBEDDING_MAX_CONCURRENT = 3;

const chatSemaphore = new PrioritySemaphore(MAX_CONCURRENT);
const embeddingSemaphore = new PrioritySemaphore(EMBEDDING_MAX_CONCURRENT);

/**
 * Acquire a chat slot. Returns a release function.
 * Callers MUST call release() in a finally block.
 *
 * Usage:
 *   const release = await acquireLLMSlot('normal');
 *   try {
 *     const result = await callOllamaChat({...});
 *     return result;
 *   } finally {
 *     release();
 *   }
 */
export function acquireLLMSlot(priority: LLMPriority = 'normal'): Promise<() => void> {
  return chatSemaphore.acquire(priority);
}

/** Acquire an embedding slot (separate pool, see the header). Same contract as acquireLLMSlot. */
export function acquireEmbeddingSlot(priority: LLMPriority = 'normal'): Promise<() => void> {
  return embeddingSemaphore.acquire(priority);
}

/** Non-blocking stats snapshot of the chat pool for diagnostics / activity log */
export function getLLMStats() {
  return chatSemaphore.stats();
}
