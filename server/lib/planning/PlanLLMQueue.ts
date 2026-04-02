class PlanLLMQueue {
  private queues = new Map<number, Array<() => Promise<void>>>();
  private running = new Map<number, boolean>();

  enqueue(agentId: number, job: () => Promise<void>): void {
    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, []);
    }
    this.queues.get(agentId)!.push(job);

    if (!this.running.get(agentId)) {
      this.process(agentId);
    }
  }

  private async process(agentId: number): Promise<void> {
    this.running.set(agentId, true);
    const queue = this.queues.get(agentId);

    while (queue && queue.length > 0) {
      const job = queue.shift()!;
      try {
        await job();
      } catch (err) {
        console.warn(`[PlanLLMQueue] agent ${agentId} job failed:`, err);
      }
      if (queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    this.running.set(agentId, false);
  }

  clearAgent(agentId: number): void {
    const queue = this.queues.get(agentId);
    if (queue) queue.length = 0;
  }

  clear(): void {
    for (const queue of this.queues.values()) {
      queue.length = 0;
    }
  }
}

export const planLLMQueue = new PlanLLMQueue();
