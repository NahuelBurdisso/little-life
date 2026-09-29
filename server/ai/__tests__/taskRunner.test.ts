import { describe, it, expect, vi } from 'vitest';

vi.mock('../generateResponse', () => ({
  generateResponse: vi.fn(async () => {
    throw new Error('model exploded');
  }),
}));
vi.mock('../generateEmbedding', () => ({ generateEmbeddingForMemory: vi.fn() }));

import { taskRunner } from '../taskRunner';

/**
 * A turn whose generateResponse throws ends the conversation's turn chain for
 * good (nothing retries it; the scheduler's game-minute budget closes the
 * conversation later). That must be visible in the log, and the runner slot
 * must be handed back.
 */
describe('taskRunner — a turn that throws', () => {
  it('warns with the conversation and speaker, and frees the slot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(taskRunner.startConversation(4242, 7)).toBe(true);
      await taskRunner.drain();

      expect(taskRunner.activeConversations).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, err] = warn.mock.calls[0];
      expect(message).toMatch(/Conversation 4242/);
      expect(message).toMatch(/agent 7/);
      expect((err as Error).message).toBe('model exploded');
    } finally {
      warn.mockRestore();
    }
  });
});
