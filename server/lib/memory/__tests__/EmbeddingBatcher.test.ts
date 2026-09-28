import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * B12: the batcher called the embedding endpoint with a bare fetch, outside any
 * semaphore. These pin down that every request now holds a slot of the
 * embedding pool (never a chat slot) for exactly its own duration, at the
 * intended tier, and gives it back on failure.
 */

const release = vi.fn();
const acquireEmbeddingSlot = vi.fn(async (_priority: string) => release);
const acquireLLMSlot = vi.fn(async (_priority: string) => release);

vi.mock('../../../ai/llmSemaphore', () => ({
  acquireEmbeddingSlot: (priority: string) => acquireEmbeddingSlot(priority),
  acquireLLMSlot: (priority: string) => acquireLLMSlot(priority),
}));

import { EmbeddingBatcher } from '../EmbeddingBatcher';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  release.mockClear();
  acquireEmbeddingSlot.mockClear();
  acquireLLMSlot.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  expect(acquireLLMSlot).not.toHaveBeenCalled(); // chat slots are never touched
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EmbeddingBatcher and the embedding pool', () => {
  it('holds a normal slot around a query embedding, not before it is granted', async () => {
    let grant!: () => void;
    acquireEmbeddingSlot.mockImplementationOnce(
      (_p: string) => new Promise((resolve) => { grant = () => resolve(release); }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ embedding: [1, 2, 3] }));

    const batcher = new EmbeddingBatcher('http://embed.test');
    const pending = batcher.embedForRead('who is Rosa?');

    await Promise.resolve();
    expect(acquireEmbeddingSlot).toHaveBeenCalledWith('normal');
    expect(fetchMock).not.toHaveBeenCalled(); // still queued behind the semaphore

    grant();
    const vec = await pending;

    expect(Array.from(vec)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the slot when the query embedding fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));

    const vec = await new EmbeddingBatcher('http://embed.test').embedForRead('anything');

    expect(vec.every((x) => x === 0)).toBe(true); // zero-vector fallback, as before
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('takes one low slot for a whole write batch', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ embeddings: [[1], [2], [3]] }));

    const vecs = await new EmbeddingBatcher('http://embed.test').embedForWrite(['a', 'b', 'c']);

    expect(vecs.map((v) => v[0])).toEqual([1, 2, 3]);
    expect(acquireEmbeddingSlot).toHaveBeenCalledTimes(1);
    expect(acquireEmbeddingSlot).toHaveBeenCalledWith('low');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the slot when a write batch fails', async () => {
    const batcher = new EmbeddingBatcher('http://embed.test');
    // First batch succeeds so the batch endpoint is known to work; the second
    // one's failure then surfaces instead of falling back.
    fetchMock.mockResolvedValueOnce(jsonResponse({ embeddings: [[1]] }));
    await batcher.embedForWrite(['ok']);
    release.mockClear();

    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    const vecs = await batcher.embedForWrite(['a', 'b']);

    expect(vecs).toHaveLength(2);
    expect(vecs.every((v) => v.every((x) => x === 0))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('runs the sequential fallback one request at a time inside that single slot', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/embed')) return jsonResponse({}, 404);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const prompt = JSON.parse(String(init.body)).prompt as string;
      return jsonResponse({ embedding: [prompt.length] });
    });

    const vecs = await new EmbeddingBatcher('http://embed.test').embedForWrite(['a', 'bb', 'ccc']);

    expect(vecs.map((v) => v[0])).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
    expect(acquireEmbeddingSlot).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
