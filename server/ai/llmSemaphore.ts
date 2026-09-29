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
 *  - chat (`acquireLLMSlot`, LLM_PARALLEL slots, default 4) for every chat/completion request;
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
  critical: 0,  // conversation turns
  normal: 1,    // planning, reflections; memory-query embeddings (embedding pool)
  low: 2,       // goal reviews, pivots, self-descriptions; memory-write embeddings (embedding pool)
};

/**
 * A counting semaphore with strict priority: a freed slot goes to the
 * highest-priority waiter, FIFO among equals.
 *
 * `reserve` slots are kept for each side: `critical` callers can never hold
 * more than `max - reserve`, and neither can everyone else together.
 * Priority alone cannot protect a conversation turn once every slot is busy:
 * with the default (no reservation) a daily-plan burst at dawn fills the pool
 * with 20–30 s generations and the next dialogue line waits for one of them to
 * finish — playtest turns sat ~15 s in the queue for a 0.3 s reply.
 */
export class PrioritySemaphore {
  private active = 0;
  /** Slots held by critical / by all other callers, each capped at max - reserve. */
  private activeCritical = 0;
  private activeNonCritical = 0;
  private readonly waiting: QueueEntry[] = [];

  // Stats for diagnostics
  private totalAcquired = 0;
  private totalWaited = 0;
  private peakActive = 0;
  private peakQueue = 0;

  constructor(
    private readonly maxConcurrent: number,
    /**
     * Slots held back from each side. Dialogue must not wait behind a dawn
     * burst of daily plans — and with up to four LLM conversations running,
     * turn after turn would otherwise take every freed slot by strict priority
     * and starve planning (agents idle while their decomposition waits).
     */
    private readonly reserve = 0,
  ) {}

  private canTake(priority: LLMPriority): boolean {
    if (this.active >= this.maxConcurrent) return false;
    const held = priority === 'critical' ? this.activeCritical : this.activeNonCritical;
    return held < this.maxConcurrent - this.reserve;
  }

  private take(priority: LLMPriority): void {
    this.active++;
    if (priority === 'critical') this.activeCritical++;
    else this.activeNonCritical++;
    if (this.active > this.peakActive) this.peakActive = this.active;
  }

  private releaseSlot(priority: LLMPriority): void {
    this.active--;
    if (priority === 'critical') this.activeCritical--;
    else this.activeNonCritical--;

    // Highest-priority waiter that may take a slot now (FIFO among equals). A
    // non-critical waiter can be skipped while only reserved slots are free.
    let bestIdx = -1;
    for (let i = 0; i < this.waiting.length; i++) {
      const w = this.waiting[i];
      if (!this.canTake(w.priority)) continue;
      if (bestIdx < 0 || PRIORITY_ORDER[w.priority] < PRIORITY_ORDER[this.waiting[bestIdx].priority]) {
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return;

    const next = this.waiting.splice(bestIdx, 1)[0];
    this.take(next.priority);
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
      this.releaseSlot(priority);
    };

    if (this.canTake(priority)) {
      this.take(priority);
      return release;
    }

    // Wait for a slot (take() is done by releaseSlot before resolving)
    this.totalWaited++;
    await new Promise<void>((resolve) => {
      this.waiting.push({ priority, resolve, enqueued: Date.now() });
      if (this.waiting.length > this.peakQueue) this.peakQueue = this.waiting.length;
    });

    return release;
  }

  /**
   * Requests waiting for a slot right now. O(1), unlike `stats()` (which
   * filters the waiting list three times): the decisions phase reads it for
   * every conversation it queues (lib/conversationTier.ts).
   */
  backlog(): number {
    return this.waiting.length;
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

// Must match the server's parallelism (OLLAMA_NUM_PARALLEL, llama-server
// --parallel). Handing the server more requests than it runs at once does not
// make anything faster — the extra ones wait in the SERVER's FIFO queue, where
// this module's priorities no longer apply, so a conversation turn queued
// there behind four daily plans. Keeping the excess queued here means the next
// free slot always goes to the most important caller.
const parsedParallel = parseInt(process.env.LLM_PARALLEL ?? '', 10);
const MAX_CONCURRENT = Number.isFinite(parsedParallel) && parsedParallel >= 1 ? parsedParallel : 4;

/**
 * One slot held back for each side (see PrioritySemaphore): dialogue always has
 * a slot planning can't take, and planning one dialogue can't. None with a
 * single slot — a reserve there would lock one side out entirely.
 */
const RESERVE_PER_SIDE = MAX_CONCURRENT > 1 ? 1 : 0;

/**
 * Embedding requests are short, and a write batch carries up to 20 texts in
 * one request. Three slots let a query embedding run alongside a write batch
 * or two without handing the embedding server an unbounded burst.
 */
const EMBEDDING_MAX_CONCURRENT = 3;

const chatSemaphore = new PrioritySemaphore(MAX_CONCURRENT, RESERVE_PER_SIDE);
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

/**
 * Chat requests queued behind a full pool. 0 means the next request would get a
 * slot (or its side's reserve) at once; anything above means the model is the
 * bottleneck and every extra request only lengthens the wait.
 */
export function getLLMBacklog(): number {
  return chatSemaphore.backlog();
}
