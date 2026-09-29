import { describe, it, expect, vi, beforeEach } from 'vitest';

// generateResponse is pure orchestration over the LLM client, the prompt
// builder and the conversation helpers — mock all three so the test pins the
// control flow (retry → validate → fallback → write) without a DB or a model.
vi.mock('../ollama', () => ({ callOllamaChat: vi.fn() }));
vi.mock('../prompts', () => ({
  buildConversationPrompt: () => ({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] }),
  hasConcreteTopic: (t: string | null) => !!t && !/greeting/.test(t),
  topicIntent: () => 'Share the news about the mill.',
}));
vi.mock('../../helpers/conversationHelpers', () => ({
  getConversationContext: vi.fn(),
  addMessage: vi.fn(),
  markConversationEnded: vi.fn(),
}));

import { generateResponse } from '../generateResponse';
import { callOllamaChat } from '../ollama';
import { getConversationContext, addMessage } from '../../helpers/conversationHelpers';
import { CONFIG } from '../../lib/constants';

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

    const [, , savedText, sentiment, topics, , fallback] = vi.mocked(addMessage).mock.calls[0];
    expect(savedText).not.toBe('Ok');
    expect(savedText).toMatch(FALLBACK_PATTERN);
    // Narration, not speech: flagged, and neither scored nor mined for topics.
    expect(fallback).toBe(true);
    expect(sentiment).toBe(0);
    expect(topics).toEqual([]);
  });

  it('keeps the nudge retry text when it succeeds', async () => {
    vi.mocked(callOllamaChat)
      .mockResolvedValueOnce({ text: 'Ok' } as never)
      .mockResolvedValueOnce({ text: 'The harvest looks better than last year, honestly.' } as never);

    await generateResponse(1, 1);

    expect(vi.mocked(addMessage).mock.calls[0][2]).toBe('The harvest looks better than last year, honestly.');
    expect(vi.mocked(addMessage).mock.calls[0][6]).toBe(false);
  });

  it('holds the nudge retry to the same validator: filler falls back', async () => {
    vi.mocked(callOllamaChat)
      .mockResolvedValueOnce({ text: 'Ok' } as never)
      .mockResolvedValueOnce({ text: 'Mm' } as never);

    await generateResponse(1, 1);

    expect(vi.mocked(addMessage).mock.calls[0][2]).toMatch(FALLBACK_PATTERN);
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

  it('gives the nudge retry the same token cap as the situational first call', async () => {
    vi.mocked(getConversationContext).mockResolvedValue({
      ...(context() as object),
      situationalPrompt: 'You owe them money and need more.',
    } as never);
    vi.mocked(callOllamaChat)
      .mockResolvedValueOnce({ text: 'Ok' } as never)
      .mockResolvedValueOnce({ text: 'Please, I just need a little more time to pay you back.' } as never);

    await generateResponse(1, 1);

    const caps = vi.mocked(callOllamaChat).mock.calls.map((c) => c[0].options?.num_predict);
    expect(caps).toEqual([CONFIG.AI.CHAT_MAX_TOKENS_SITUATIONAL, CONFIG.AI.CHAT_MAX_TOKENS_SITUATIONAL]);
  });

  describe('generic openers (G6)', () => {
    // Acquainted (familiarity >= 5), talking about something concrete.
    function opener(topic: string | null, messages: unknown[] = []) {
      return {
        ...(context() as object),
        conversation: { id: 1, participants: [1, 2], messages, status: 'active', topic, max_turns: 6 },
        relationship: { familiarity: 40 },
      } as never;
    }

    it('trims a leading pleasantry for free when something concrete follows', async () => {
      vi.mocked(getConversationContext).mockResolvedValue(opener('town news'));
      vi.mocked(callOllamaChat).mockResolvedValueOnce({
        text: 'Hey Lucia, how are you doing today? Did you hear the mill wheel cracked last night?',
      } as never);

      await generateResponse(1, 1);

      expect(callOllamaChat).toHaveBeenCalledTimes(1);
      expect(vi.mocked(addMessage).mock.calls[0][2]).toBe('Did you hear the mill wheel cracked last night?');
    });

    it('regenerates a pure pleasantry once when there is a real topic', async () => {
      vi.mocked(getConversationContext).mockResolvedValue(opener('town news'));
      vi.mocked(callOllamaChat)
        .mockResolvedValueOnce({ text: 'Good morning, Lucia! How are you doing today?' } as never)
        .mockResolvedValueOnce({ text: 'The mill wheel cracked last night, Lucia. Half the flour is ruined.' } as never);

      await generateResponse(1, 1);

      expect(callOllamaChat).toHaveBeenCalledTimes(2);
      expect(vi.mocked(callOllamaChat).mock.calls[1][0].purpose).toBe('conversation.retry');
      expect(vi.mocked(addMessage).mock.calls[0][2]).toBe('The mill wheel cracked last night, Lucia. Half the flour is ruined.');
      expect(vi.mocked(addMessage).mock.calls[0][6]).toBe(false);
    });

    it('keeps the first pleasantry, not a canned fallback, when the regeneration is no better', async () => {
      vi.mocked(getConversationContext).mockResolvedValue(opener('town news'));
      vi.mocked(callOllamaChat)
        .mockResolvedValueOnce({ text: 'Good morning, Lucia! How are you doing today?' } as never)
        .mockResolvedValueOnce({ text: "How's your day going?" } as never);

      await generateResponse(1, 1);

      expect(vi.mocked(addMessage).mock.calls[0][2]).toBe('Good morning, Lucia! How are you doing today?');
      expect(vi.mocked(addMessage).mock.calls[0][6]).toBe(false);
    });

    it('leaves greetings, first meetings and later turns alone', async () => {
      // A greeting topic: the hello is the conversation.
      vi.mocked(getConversationContext).mockResolvedValue(opener('friendly greeting'));
      vi.mocked(callOllamaChat).mockResolvedValue({ text: 'Good to see you, Lucia!' } as never);
      await generateResponse(1, 1);
      expect(callOllamaChat).toHaveBeenCalledTimes(1);
      expect(vi.mocked(addMessage).mock.calls[0][2]).toBe('Good to see you, Lucia!');

      // A later turn is never checked.
      vi.mocked(getConversationContext).mockResolvedValue(opener('town news', [{ speakerId: 2, text: 'The mill!' }]));
      vi.mocked(callOllamaChat).mockResolvedValue({ text: 'How are you doing today? The mill, yes.' } as never);
      await generateResponse(1, 1);
      expect(callOllamaChat).toHaveBeenCalledTimes(2);
      expect(vi.mocked(addMessage).mock.calls[1][2]).toBe('How are you doing today? The mill, yes.');

      // A first meeting (no relationship row) keeps its greeting.
      vi.mocked(getConversationContext).mockResolvedValue({
        ...(opener('town news') as object), relationship: null,
      } as never);
      vi.mocked(callOllamaChat).mockResolvedValue({ text: "Hello there! I'm Rosa, from the bakery." } as never);
      await generateResponse(1, 1);
      expect(vi.mocked(addMessage).mock.calls[2][2]).toBe("Hello there! I'm Rosa, from the bakery.");
    });
  });

  it('does not call the LLM for a conversation that already ended', async () => {
    vi.mocked(getConversationContext).mockResolvedValue(context('ended'));

    const result = await generateResponse(1, 1);

    expect(result).toBeNull();
    expect(callOllamaChat).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });
});
