import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * B12: the batcher called the embedding endpoint with a bare fetch, outside the
 * global LLM semaphore. These pin down that every request now holds a slot for
 * exactly its own duration, at the intended tier, and gives it back on failure.
 */

const release = vi.fn();
const acquireLLMSlot = vi.fn(async (_priority: string) => release);

vi.mock('../../../ai/llmSemaphore', () => ({
  acquireLLMSlot: (priority: string) => acquireLLMSlot(priority),
}));

import { EmbeddingBatcher } from '../EmbeddingBatcher';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  release.mockClear();
  acquireLLMSlot.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EmbeddingBatcher and the LLM semaphore', () => {
  it('holds a critical slot around a query embedding, not before it is granted', async () => {
    let grant!: () => void;
    acquireLLMSlot.mockImplementationOnce(
      (_p: string) => new Promise((resolve) => { grant = () => resolve(release); }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ embedding: [1, 2, 3] }));

    const batcher = new EmbeddingBatcher('http://embed.test');
    const pending = batcher.embedForRead('who is Rosa?');

    await Promise.resolve();
    expect(acquireLLMSlot).toHaveBeenCalledWith('critical');
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
    expect(acquireLLMSlot).toHaveBeenCalledTimes(1);
    expect(acquireLLMSlot).toHaveBeenCalledWith('low');
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
    expect(acquireLLMSlot).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
