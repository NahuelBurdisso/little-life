import { describe, it, expect, vi, afterEach } from 'vitest';
import { callOllamaChat } from '../ollama';
import { LLMEmptyReplyError, LLMAbortedError } from '../llmErrors';
import { getLLMStats } from '../llmSemaphore';
import { CONFIG } from '../../lib/constants';

// Pins how each backend reports a reply the token cap cut off — dialogue trims
// the dangling half-sentence only when this flag says the cap was hit.

const ai = CONFIG.AI as { BACKEND: 'ollama' | 'openai' };
const originalBackend = ai.BACKEND;

function mockFetch(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
}

const request = { model: 'm', system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('callOllamaChat — truncation flag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ai.BACKEND = originalBackend;
  });

  it('flags an Ollama reply that stopped on done_reason "length"', async () => {
    ai.BACKEND = 'ollama';
    mockFetch({ message: { content: 'A story just beneath the surface of' }, done_reason: 'length' });
    await expect(callOllamaChat(request)).resolves.toEqual({ text: 'A story just beneath the surface of', truncated: true });
  });

  it('does not flag an Ollama reply that finished on its own', async () => {
    ai.BACKEND = 'ollama';
    mockFetch({ message: { content: 'All done.' }, done_reason: 'stop' });
    await expect(callOllamaChat(request)).resolves.toEqual({ text: 'All done.', truncated: false });
  });

  it('rejects a thinking-only Ollama reply instead of returning the reasoning as the answer', async () => {
    ai.BACKEND = 'ollama';
    mockFetch({
      message: { content: '', thinking: 'The user wants me to respond as Omar.\nOmar is grumpy.' },
      done_reason: 'length',
    });
    await expect(callOllamaChat(request)).rejects.toThrow(/only thinking/);
    mockFetch({ message: { content: '', thinking: 'hmm' } });
    await expect(callOllamaChat(request)).rejects.toBeInstanceOf(LLMEmptyReplyError);
  });

  it('rejects an empty or reasoning-only OpenAI-compatible reply with the typed error', async () => {
    ai.BACKEND = 'openai';
    mockFetch({ choices: [{ message: { content: '   ', reasoning_content: 'Let me think.' }, finish_reason: 'length' }] });
    await expect(callOllamaChat(request)).rejects.toThrow(/only reasoning_content/);
    mockFetch({ choices: [{ message: { content: '' } }] });
    await expect(callOllamaChat(request)).rejects.toBeInstanceOf(LLMEmptyReplyError);
  });

  it('trims OpenAI-compatible content', async () => {
    ai.BACKEND = 'openai';
    mockFetch({ choices: [{ message: { content: '  Hello there.\n' }, finish_reason: 'stop' }] });
    await expect(callOllamaChat(request)).resolves.toEqual({ text: 'Hello there.', truncated: false });
  });

  it('flags an OpenAI-compatible reply with finish_reason "length"', async () => {
    ai.BACKEND = 'openai';
    mockFetch({ choices: [{ message: { content: 'Cut off mid' }, finish_reason: 'length' }] });
    await expect(callOllamaChat(request)).resolves.toEqual({ text: 'Cut off mid', truncated: true });
  });
});

describe('callOllamaChat — caller cancellation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ai.BACKEND = originalBackend;
  });

  it.each(['ollama', 'openai'] as const)(
    '%s: an already-aborted request never queues for a slot nor reaches the server',
    async (backend) => {
      ai.BACKEND = backend;
      const fetchSpy = mockFetch({ message: { content: 'x' } });
      const acquiredBefore = getLLMStats().totalAcquired;
      const controller = new AbortController();
      controller.abort();

      await expect(callOllamaChat({ ...request, signal: controller.signal })).rejects.toBeInstanceOf(LLMAbortedError);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(getLLMStats().totalAcquired).toBe(acquiredBefore);
    },
  );

  it('reports a mid-request cancel as an abort, not a timeout', async () => {
    ai.BACKEND = 'ollama';
    const controller = new AbortController();
    let fetchStarted!: () => void;
    const started = new Promise<void>((r) => { fetchStarted = r; });
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      fetchStarted();
      (init?.signal as AbortSignal).addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const pending = callOllamaChat({ ...request, signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(LLMAbortedError);
    expect(getLLMStats().active).toBe(0);
  });
});
