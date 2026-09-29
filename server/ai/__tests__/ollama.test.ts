import { describe, it, expect, vi, afterEach } from 'vitest';
import { callOllamaChat } from '../ollama';
import { LLMEmptyReplyError, LLMAbortedError } from '../llmErrors';
import { getLLMStats } from '../llmSemaphore';
import { getLLMMetrics, resetLLMMetrics } from '../llmMetrics';
import { CONFIG } from '../../lib/constants';
import { bumpWorldEpoch } from '../../lib/worldEpoch';

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

describe('callOllamaChat — world swap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ai.BACKEND = originalBackend;
    resetLLMMetrics();
  });

  it('aborts a request in flight when the world is swapped, without booking it', async () => {
    ai.BACKEND = 'ollama';
    resetLLMMetrics();
    let fetchStarted!: () => void;
    const started = new Promise<void>((r) => { fetchStarted = r; });
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      fetchStarted();
      (init?.signal as AbortSignal).addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    // No caller signal at all: the world signal alone must cancel it.
    const pending = callOllamaChat({ ...request, purpose: 'reflection.insights' });
    await started;
    bumpWorldEpoch();
    await expect(pending).rejects.toBeInstanceOf(LLMAbortedError);
    expect(getLLMStats().active).toBe(0);
    expect(getLLMMetrics()).toEqual([]);
  });

  it('a request made after the swap belongs to the new world and runs', async () => {
    ai.BACKEND = 'ollama';
    bumpWorldEpoch();
    mockFetch({ message: { content: 'Fresh.' }, done_reason: 'stop' });
    await expect(callOllamaChat(request)).resolves.toEqual({ text: 'Fresh.', truncated: false });
  });
});

describe('callOllamaChat — request shape and metrics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ai.BACKEND = originalBackend;
    resetLLMMetrics();
  });

  it('pins num_ctx and keep_alive, and passes format through to Ollama', async () => {
    ai.BACKEND = 'ollama';
    const fetchSpy = mockFetch({ message: { content: '{"a":1}' }, done_reason: 'stop' });
    await callOllamaChat({ ...request, format: 'json', options: { temperature: 0.2 } });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.options).toEqual({ num_ctx: CONFIG.AI.NUM_CTX, temperature: 0.2 });
    expect(body.keep_alive).toBe(CONFIG.AI.KEEP_ALIVE);
    expect(body.format).toBe('json');
    expect(body.think).toBe(false);
  });

  it('maps a JSON schema to response_format on the OpenAI path', async () => {
    ai.BACKEND = 'openai';
    const fetchSpy = mockFetch({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    await callOllamaChat({ ...request, format: schema });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'reply', schema } });
  });

  it('books tokens and durations per purpose, errors included', async () => {
    ai.BACKEND = 'ollama';
    mockFetch({
      message: { content: 'Hi.' }, done_reason: 'stop',
      prompt_eval_count: 300, eval_count: 20, eval_duration: 400e6, prompt_eval_duration: 50e6, load_duration: 1e6,
    });
    await callOllamaChat({ ...request, purpose: 'conversation' });
    mockFetch({ message: { content: '' } });
    await expect(callOllamaChat({ ...request, purpose: 'conversation' })).rejects.toBeInstanceOf(LLMEmptyReplyError);

    const [conv] = getLLMMetrics();
    expect(conv).toMatchObject({ purpose: 'conversation', calls: 2, errors: 1, reloads: 0, tokPerSec: 50 });
  });

  it('does not book a call its owner cancelled', async () => {
    ai.BACKEND = 'ollama';
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
      controller.abort();
    }));
    await expect(callOllamaChat({ ...request, purpose: 'snap', signal: controller.signal })).rejects.toBeInstanceOf(LLMAbortedError);
    expect(getLLMMetrics()).toEqual([]);
  });
});
