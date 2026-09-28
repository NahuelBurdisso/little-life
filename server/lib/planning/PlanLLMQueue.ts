interface QueuedJob {
  run: () => Promise<void>;
  /** Optional dedupe key; see `enqueue`. */
  key?: string;
}

export class PlanLLMQueue {
  private queues = new Map<number, QueuedJob[]>();
  private running = new Map<number, boolean>();
  /**
   * Dedupe keys of jobs that are queued OR in flight, per agent.
   *
   * The decisions phase asks for a daily plan on every pass in which a planless
   * agent finishes an action. Without this set each ask became another queued
   * LLM job, so while Ollama was down or slow a single agent could stack dozens
   * of doomed plan requests that then drained one by one through the shared
   * LLM semaphore, starving conversations (B6). A key stays reserved until its
   * job settles, so "already asked, still waiting" is a cheap no-op.
   */
  private pending = new Map<number, Set<string>>();

  /**
   * Queue `job` for `agentId`. Jobs for one agent run strictly one after
   * another; different agents run concurrently.
   *
   * When `key` is given and a job with the same key is already queued or
   * running for this agent, the new job is dropped. Returns whether the job
   * was accepted.
   */
  enqueue(agentId: number, job: () => Promise<void>, key?: string): boolean {
    if (key !== undefined) {
      let keys = this.pending.get(agentId);
      if (keys?.has(key)) return false;
      if (!keys) {
        keys = new Set();
        this.pending.set(agentId, keys);
      }
      keys.add(key);
    }

    let queue = this.queues.get(agentId);
    if (!queue) {
      queue = [];
      this.queues.set(agentId, queue);
    }
    queue.push({ run: job, key });

    if (!this.running.get(agentId)) {
      void this.process(agentId);
    }
    return true;
  }

  /** Whether a job with `key` is queued or running for `agentId`. */
  isPending(agentId: number, key: string): boolean {
    return this.pending.get(agentId)?.has(key) ?? false;
  }

  private async process(agentId: number): Promise<void> {
    this.running.set(agentId, true);
    const queue = this.queues.get(agentId);

    while (queue && queue.length > 0) {
      const entry = queue.shift()!;
      // Capture the set now: `clear()` swaps in a fresh map on world replace,
      // and a job of the old world finishing late must not release a key that
      // a new-world agent with the same (reused) rowid has since reserved.
      const keys = entry.key !== undefined ? this.pending.get(agentId) : undefined;
      try {
        await entry.run();
      } catch (err) {
        console.warn(`[PlanLLMQueue] agent ${agentId} job failed:`, err);
      } finally {
        if (entry.key !== undefined) keys?.delete(entry.key);
      }
      if (queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    this.running.set(agentId, false);
  }

  clear(): void {
    // Empty the arrays in place rather than dropping them: a `process` loop
    // that is mid-await still holds a reference and must see them empty.
    for (const queue of this.queues.values()) {
      queue.length = 0;
    }
    this.pending = new Map();
  }
}

export const planLLMQueue = new PlanLLMQueue();
