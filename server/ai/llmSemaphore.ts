/**
 * Global LLM Semaphore
 *
 * Limits concurrent Ollama requests across ALL systems to prevent
 * saturation when Ollama NUM_PARALLEL=1 (or low). Without this,
 * day-change spikes can fire 30+ concurrent requests → timeout cascade.
 *
 * Priority levels ensure conversations and planning aren't starved
 * by bulk operations like goal reviews.
 */

export type LLMPriority = 'critical' | 'normal' | 'low';

interface QueueEntry {
  priority: LLMPriority;
  resolve: () => void;
  enqueued: number;
}

const PRIORITY_ORDER: Record<LLMPriority, number> = {
  critical: 0,  // conversations, snap resolution
  normal: 1,    // planning, reflections
  low: 2,       // goal reviews, pivots, self-descriptions, embeddings
};

// Empirically tuned for an RTX 3090 24GB: deep enough to keep Ollama's internal
// batching fed without pushing per-request latency past the conversation timeout.
//
// This deliberately does NOT assume any particular OLLAMA_NUM_PARALLEL — nothing
// in this repo sets it, so whatever the server was started with applies. If you
// run Ollama with a low NUM_PARALLEL, requests above it simply queue inside
// Ollama instead of here; this limit only bounds how many we hand it at once.
const MAX_CONCURRENT = 8;

let active = 0;
const waiting: QueueEntry[] = [];

// Stats for diagnostics
let totalAcquired = 0;
let totalWaited = 0;
let peakActive = 0;
let peakQueue = 0;

function releaseSlot(): void {
  active--;

  if (waiting.length === 0) return;

  // Pick highest-priority waiter (stable sort by priority then FIFO)
  let bestIdx = 0;
  for (let i = 1; i < waiting.length; i++) {
    if (PRIORITY_ORDER[waiting[i].priority] < PRIORITY_ORDER[waiting[bestIdx].priority]) {
      bestIdx = i;
    }
  }

  const next = waiting.splice(bestIdx, 1)[0];
  active++;
  if (active > peakActive) peakActive = active;
  next.resolve();
}

/**
 * Acquire a slot. Returns a release function.
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
export async function acquireLLMSlot(priority: LLMPriority = 'normal'): Promise<() => void> {
  totalAcquired++;

  // One-shot release: a double call (e.g. a `finally` plus an explicit release
  // on an error path) used to decrement `active` twice and permanently
  // over-subscribe the pool, since nothing ever raises it back.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseSlot();
  };

  if (active < MAX_CONCURRENT) {
    active++;
    if (active > peakActive) peakActive = active;
    return release;
  }

  // Wait for a slot
  totalWaited++;
  await new Promise<void>((resolve) => {
    waiting.push({ priority, resolve, enqueued: Date.now() });
    if (waiting.length > peakQueue) peakQueue = waiting.length;
  });

  return release;
}

/** Non-blocking stats snapshot for diagnostics / activity log */
export function getLLMStats() {
  return {
    active,
    waiting: waiting.length,
    totalAcquired,
    totalWaited,
    peakActive,
    peakQueue,
    waitingByPriority: {
      critical: waiting.filter(w => w.priority === 'critical').length,
      normal: waiting.filter(w => w.priority === 'normal').length,
      low: waiting.filter(w => w.priority === 'low').length,
    },
  };
}
