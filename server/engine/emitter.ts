type Callback = (data: { channel: string; timestamp: number }) => void;

export class TickEmitter {
  private dirty = new Set<string>();
  private subscribers = new Map<string, Set<Callback>>();

  markDirty(channel: string) {
    this.dirty.add(channel);
  }

  /** Mark all subscribed channels as dirty — used after reset to push full refresh. */
  markAllDirty() {
    for (const channel of this.subscribers.keys()) {
      this.dirty.add(channel);
    }
  }

  subscribe(channel: string, cb: Callback): () => void {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    this.subscribers.get(channel)!.add(cb);
    return () => { this.subscribers.get(channel)?.delete(cb); };
  }

  /**
   * Creates an async generator that yields whenever the given channel is dirtied.
   * Used by tRPC v11 subscription procedures which require async generators.
   */
  async *iterate(channel: string, signal?: AbortSignal): AsyncGenerator<{ channel: string; timestamp: number }> {
    const queue: { channel: string; timestamp: number }[] = [];
    let resolve: (() => void) | null = null;

    const unsub = this.subscribe(channel, (data) => {
      queue.push(data);
      if (resolve) { resolve(); resolve = null; }
    });

    const onAbort = () => { if (resolve) { resolve(); resolve = null; } };
    signal?.addEventListener('abort', onAbort);

    try {
      while (!signal?.aborted) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((r) => { resolve = r; });
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      unsub();
    }
  }

  flush() {
    const now = Date.now();
    for (const channel of this.dirty) {
      const subs = this.subscribers.get(channel);
      if (subs) {
        for (const cb of subs) {
          cb({ channel, timestamp: now });
        }
      }
    }
    this.dirty.clear();
  }
}

export const emitter = new TickEmitter();
