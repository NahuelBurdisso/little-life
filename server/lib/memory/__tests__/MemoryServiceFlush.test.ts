import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryService } from '../MemoryService';
import type { MemoryStore } from '../MemoryStore';
import type { EmbeddingBatcher } from '../EmbeddingBatcher';
import { WRITE_QUEUE_MAX_SIZE, WRITE_QUEUE_HARD_CAP, WRITE_QUEUE_FLUSH_MS } from '../constants';

/**
 * The write queue must survive slow embeddings: nothing stranded when a flush
 * finishes with a backlog, and nothing dropped until the hard memory cap.
 */

type Inserted = { description: string; importance: number };

function setup() {
  const batches: Inserted[][] = [];
  let nextId = 1;
  const store = {
    insertBatch: vi.fn((items: Array<{ agentId: number; type: string; description: string; importance: number }>) => {
      batches.push(items.map((i) => ({ description: i.description, importance: i.importance })));
      return items.map((i) => ({
        id: nextId++, agent_id: i.agentId, importance: i.importance, last_accessed: 0, type: i.type,
      }));
    }),
  } as unknown as MemoryStore;

  // The first embedding call hangs until released; later ones answer at once.
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => { releaseFirst = r; });
  let calls = 0;
  const batcher = {
    embedForWrite: vi.fn(async (texts: string[]) => {
      if (calls++ === 0) await firstGate;
      return texts.map(() => new Float32Array(4));
    }),
    clear: vi.fn(),
  } as unknown as EmbeddingBatcher;

  const service = new MemoryService(store, undefined, batcher);
  const inserted = () => batches.flat();
  return { service, batches, inserted, releaseFirst, batcher };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MemoryService write flush', () => {
  it('flushes records that arrived while a flush was waiting on embeddings', async () => {
    const { service, inserted, releaseFirst } = setup();

    service.record(1, 'observation', 'first');
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS); // flush #1 starts, hangs

    service.record(1, 'observation', 'second');
    service.record(1, 'observation', 'third');
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS); // their flush bails: #1 in progress

    releaseFirst();
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS * 2);

    // Before the fix 'second' and 'third' stayed queued until an unrelated record().
    expect(inserted().map((m) => m.description)).toEqual(['first', 'second', 'third']);
  });

  it('works through a backlog in batches instead of discarding the overflow', async () => {
    const { service, batches, inserted, releaseFirst } = setup();

    service.record(1, 'observation', 'm0');
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS);
    const backlog = WRITE_QUEUE_MAX_SIZE * 2 + 5;
    for (let i = 1; i <= backlog; i++) service.record(1, 'experience', `m${i}`);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS * 10);

    // Used to keep the top WRITE_QUEUE_MAX_SIZE and silently drop the rest.
    expect(inserted()).toHaveLength(backlog + 1);
    expect(inserted().map((m) => m.description)).toEqual(
      Array.from({ length: backlog + 1 }, (_, i) => `m${i}`),
    );
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(WRITE_QUEUE_MAX_SIZE);
  });

  it('a flush from before clear() neither inserts nor frees the new world\'s flush flag', async () => {
    const inserted: string[] = [];
    let nextId = 1;
    const store = {
      insertBatch: vi.fn((items: Array<{ agentId: number; type: string; description: string; importance: number }>) => {
        inserted.push(...items.map((i) => i.description));
        return items.map((i) => ({
          id: nextId++, agent_id: i.agentId, importance: i.importance, last_accessed: 0, type: i.type,
        }));
      }),
    } as unknown as MemoryStore;
    // Every embedding call hangs until the test lets it through.
    const gates: Array<() => void> = [];
    const batcher = {
      embedForWrite: vi.fn(async (texts: string[]) => {
        await new Promise<void>((r) => gates.push(r));
        return texts.map(() => new Float32Array(4));
      }),
      clear: vi.fn(),
    } as unknown as EmbeddingBatcher;
    const service = new MemoryService(store, undefined, batcher);

    service.record(1, 'observation', 'old world');
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS); // flush A awaits gate 0

    service.clear(); // world replaced

    service.record(1, 'observation', 'new 1');
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS); // flush B awaits gate 1
    service.record(1, 'observation', 'new 2'); // arrives while B runs
    expect(batcher.embedForWrite).toHaveBeenCalledTimes(2);

    gates[0](); // A finishes late
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS * 3);

    expect(inserted).toEqual([]); // A's old-world batch is discarded
    // A left B's flag alone, so 'new 2' is still waiting for B instead of
    // starting a third, concurrent flush.
    expect(batcher.embedForWrite).toHaveBeenCalledTimes(2);

    gates[1]();
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS * 2);
    gates[2]?.();
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS * 2);

    expect(inserted).toEqual(['new 1', 'new 2']);
  });

  it('only drops past the hard cap, least important first, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service, inserted, releaseFirst } = setup();

    service.record(1, 'observation', 'in flight');
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS);

    for (let i = 0; i < WRITE_QUEUE_HARD_CAP; i++) service.record(1, 'observation', `keep ${i}`, {}, 0, 5);
    expect(warn).not.toHaveBeenCalled();
    service.record(1, 'observation', 'trivial', {}, 0, 1); // lowest importance: the one evicted

    expect(warn).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(WRITE_QUEUE_FLUSH_MS * (WRITE_QUEUE_HARD_CAP / WRITE_QUEUE_MAX_SIZE + 10));

    const descriptions = inserted().map((m) => m.description);
    expect(descriptions).toHaveLength(WRITE_QUEUE_HARD_CAP + 1);
    expect(descriptions).not.toContain('trivial');
  });
});
