import { describe, it, expect, vi, afterEach } from 'vitest';
import { callOllamaChat } from '../ollama';
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

  it('flags an OpenAI-compatible reply with finish_reason "length"', async () => {
    ai.BACKEND = 'openai';
    mockFetch({ choices: [{ message: { content: 'Cut off mid' }, finish_reason: 'length' }] });
    await expect(callOllamaChat(request)).resolves.toEqual({ text: 'Cut off mid', truncated: true });
  });
});
