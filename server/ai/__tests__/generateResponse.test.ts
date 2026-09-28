import { describe, it, expect, vi, beforeEach } from 'vitest';

// generateResponse is pure orchestration over the LLM client, the prompt
// builder and the conversation helpers — mock all three so the test pins the
// control flow (retry → validate → fallback → write) without a DB or a model.
vi.mock('../ollama', () => ({ callOllamaChat: vi.fn() }));
vi.mock('../prompts', () => ({
  buildConversationPrompt: () => ({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] }),
}));
vi.mock('../../helpers/conversationHelpers', () => ({
  getConversationContext: vi.fn(),
  addMessage: vi.fn(),
  markConversationEnded: vi.fn(),
}));

import { generateResponse } from '../generateResponse';
import { callOllamaChat } from '../ollama';
import { getConversationContext, addMessage } from '../../helpers/conversationHelpers';

const FALLBACK_PATTERN = /smiled and nodded|paused thoughtfully|Hmm, interesting|shrugged/;

function context(status = 'active') {
  return {
    conversation: { id: 1, participants: [1, 2], messages: [], status },
    speaker: { id: 1, name: 'Rosa Delgado' },
    otherAgent: { id: 2, name: 'Lucia Romano' },
    townNames: ['Rosa Delgado', 'Lucia Romano', 'Diego Alvarez'],
    memories: [],
  } as never;
}

describe('generateResponse', () => {
  beforeEach(() => {
    vi.mocked(callOllamaChat).mockReset();
    vi.mocked(addMessage).mockReset().mockReturnValue({ messageCount: 1, maxTurns: 4 });
    vi.mocked(getConversationContext).mockReset().mockResolvedValue(context());
  });

  it('falls back instead of saving text the validator rejected when the nudge retry also fails', async () => {
    // First call returns filler the validator rejects ("Ok" is < 10 chars and neutral);
    // the nudge retry then throws.
    vi.mocked(callOllamaChat)
      .mockResolvedValueOnce({ text: 'Ok' } as never)
      .mockRejectedValueOnce(new Error('timeout'));

    await generateResponse(1, 1);

    const savedText = vi.mocked(addMessage).mock.calls[0][2];
    expect(savedText).not.toBe('Ok');
    expect(savedText).toMatch(FALLBACK_PATTERN);
  });

  it('keeps the nudge retry text when it succeeds', async () => {
    vi.mocked(callOllamaChat)
      .mockResolvedValueOnce({ text: 'Ok' } as never)
      .mockResolvedValueOnce({ text: 'The harvest looks better than last year, honestly.' } as never);

    await generateResponse(1, 1);

    expect(vi.mocked(addMessage).mock.calls[0][2]).toBe('The harvest looks better than last year, honestly.');
  });

  it('stores the sanitised reply, not the raw model text', async () => {
    vi.mocked(callOllamaChat).mockResolvedValueOnce({
      text: '(You glance at the door.) "Oh, Diego, you seem deep in thought today." 😉',
    } as never);

    await generateResponse(1, 1);

    expect(callOllamaChat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addMessage).mock.calls[0][2]).toBe('Oh, Lucia, you seem deep in thought today.');
  });

  it('treats a reply that was only a stage direction as empty: nudge, then fallback', async () => {
    vi.mocked(callOllamaChat)
      .mockResolvedValueOnce({ text: '(Rosa smiles and looks away.)' } as never)
      .mockResolvedValueOnce({ text: '*shrugs*' } as never);

    await generateResponse(1, 1);

    expect(callOllamaChat).toHaveBeenCalledTimes(2);
    // The retry shows the model what it actually wrote, not the emptied text.
    const nudgeMessages = vi.mocked(callOllamaChat).mock.calls[1][0].messages;
    expect(nudgeMessages.at(-2)).toEqual({ role: 'assistant', content: '(Rosa smiles and looks away.)' });
    expect(vi.mocked(addMessage).mock.calls[0][2]).toMatch(FALLBACK_PATTERN);
  });

  it('drops the unfinished sentence of a reply the token cap cut off', async () => {
    vi.mocked(callOllamaChat).mockResolvedValueOnce({
      text: 'Every old house has a secret. There is always a story just beneath the surface of',
      truncated: true,
    } as never);

    await generateResponse(1, 1);

    expect(vi.mocked(addMessage).mock.calls[0][2]).toBe('Every old house has a secret.');
  });

  it('does not call the LLM for a conversation that already ended', async () => {
    vi.mocked(getConversationContext).mockResolvedValue(context('ended'));

    const result = await generateResponse(1, 1);

    expect(result).toBeNull();
    expect(callOllamaChat).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });
});
