import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../generateResponse', () => ({ generateResponse: vi.fn() }));
vi.mock('../generateEmbedding', () => ({ generateEmbeddingForMemory: vi.fn() }));

import { taskRunner } from '../taskRunner';
import { generateResponse } from '../generateResponse';

/** A turn that never answers until its signal aborts (then yields null, like generateResponse). */
function hangUntilAborted(): void {
  vi.mocked(generateResponse).mockImplementation((_id, _speaker, signal) => new Promise((resolve) => {
    signal?.addEventListener('abort', () => resolve(null), { once: true });
  }));
}

describe('taskRunner', () => {
  beforeEach(() => {
    taskRunner.resetSlots();
    vi.mocked(generateResponse).mockReset();
  });

  it('warns with the conversation and speaker when a turn throws, and frees the slot', async () => {
    // A turn whose generateResponse throws ends the chain for good (nothing
    // retries it; the scheduler's game-minute budget closes the conversation).
    vi.mocked(generateResponse).mockRejectedValueOnce(new Error('model exploded'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(taskRunner.startConversation(4242, 7)).toBe(true);
      await taskRunner.drain();

      expect(taskRunner.activeConversations).toBe(0);
      expect(taskRunner.isRunning(4242)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, err] = warn.mock.calls[0];
      expect(message).toMatch(/Conversation 4242/);
      expect(message).toMatch(/agent 7/);
      expect((err as Error).message).toBe('model exploded');
    } finally {
      warn.mockRestore();
    }
  });

  it('reports the running turn for a live chain only', async () => {
    hangUntilAborted();
    const t0 = Date.now();
    taskRunner.startConversation(1, 10);

    expect(taskRunner.isRunning(1)).toBe(true);
    expect(taskRunner.inFlightTurnMs(1, t0 + 5000)).toBeGreaterThanOrEqual(4900);
    // Never started here (e.g. left over from before a restart).
    expect(taskRunner.isRunning(2)).toBe(false);
    expect(taskRunner.inFlightTurnMs(2)).toBeNull();

    taskRunner.abortConversation(1);
    await taskRunner.drain();
    expect(taskRunner.isRunning(1)).toBe(false);
    expect(taskRunner.inFlightTurnMs(1)).toBeNull();
    expect(taskRunner.activeConversations).toBe(0);
  });

  it('resetSlots cancels live chains and never drives the slot count negative', async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(generateResponse).mockImplementation((_id, _speaker, signal) => {
      signals.push(signal!);
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve(null), { once: true }));
    });
    taskRunner.startConversation(1, 10);
    taskRunner.startConversation(2, 20);
    expect(taskRunner.activeConversations).toBe(2);
    const stale = taskRunner.drain();

    taskRunner.resetSlots();
    expect(signals.every((s) => s.aborted)).toBe(true);
    await stale; // the old chains unwind after the reset...

    // ...without decrementing the fresh counters.
    expect(taskRunner.activeConversations).toBe(0);
    expect(taskRunner.freeConversationSlots).toBe(4);
    expect(taskRunner.isRunning(1)).toBe(false);
  });
});
