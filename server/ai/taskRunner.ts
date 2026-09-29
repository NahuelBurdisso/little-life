import { generateResponse } from './generateResponse';
import { generateEmbeddingForMemory } from './generateEmbedding';
import { emitter } from '../engine/emitter';

class TaskRunner {
  private conversationSlots = 0;
  private readonly maxConcurrentConversations = 4;
  private pendingTasks = new Set<Promise<void>>();
  /** One per running turn chain, so closing a conversation can cancel its turn. */
  private readonly aborts = new Map<number, AbortController>();

  private track(task: Promise<void>) {
    this.pendingTasks.add(task);
    task.finally(() => this.pendingTasks.delete(task));
  }

  startConversation(conversationId: number, firstSpeakerId: number): boolean {
    if (this.conversationSlots >= this.maxConcurrentConversations) return false;
    this.conversationSlots++;
    const controller = new AbortController();
    this.aborts.set(conversationId, controller);
    const task = this.runConversation(conversationId, firstSpeakerId, controller.signal);
    this.track(task);
    return true;
  }

  /**
   * Cancel the turn in flight for a conversation the scheduler has closed. Its
   * slot used to stay taken until the (now pointless) reply arrived — 20–60 s
   * on a slow model — so the scheduler's next dispatch was rejected. No-op when
   * the chain has already finished.
   */
  abortConversation(conversationId: number): void {
    this.aborts.get(conversationId)?.abort();
  }

  /** Chains turns until the conversation is full, closed, or a turn fails. */
  private async runConversation(conversationId: number, firstSpeakerId: number, signal: AbortSignal): Promise<void> {
    let speakerId: number | undefined = firstSpeakerId;
    try {
      while (speakerId != null && !signal.aborted) {
        let result;
        try {
          result = await generateResponse(conversationId, speakerId, signal);
        } catch (err) {
          // Nothing retries the turn: the conversation sits `active` until
          // conversationsTick's game-minute budget wraps it up. Say so, with who
          // was speaking, instead of a bare error line.
          console.warn(
            `[taskRunner] Conversation ${conversationId}: turn for agent ${speakerId} threw; ` +
              'no further turns — the scheduler will close it at its budget.',
            err,
          );
          return;
        }
        emitter.markDirty('conversations');
        // null: context gone, conversation closed or the turn was aborted.
        // Otherwise the scheduler handles cleanup once the transcript is full.
        if (!result || result.messageCount >= result.maxTurns) return;
        speakerId = result.otherParticipantId;
        if (speakerId != null) await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      this.conversationSlots--;
      if (this.aborts.get(conversationId)?.signal === signal) this.aborts.delete(conversationId);
      emitter.markDirty('conversations');
    }
  }

  generateEmbedding(memoryId: number, text: string) {
    const task = generateEmbeddingForMemory(memoryId, text).catch(err => {
      console.error(`Embedding failed for memory ${memoryId}:`, err);
    });
    this.track(task);
  }

  get activeConversations() { return this.conversationSlots; }

  /** Turn chains that can still be started right now (see startConversation). */
  get freeConversationSlots() { return Math.max(0, this.maxConcurrentConversations - this.conversationSlots); }

  async drain() {
    await Promise.allSettled([...this.pendingTasks]);
  }

  /** Force-clear slot counters after drain/timeout. */
  resetSlots() {
    this.conversationSlots = 0;
    this.pendingTasks.clear();
    this.aborts.clear();
  }
}

export const taskRunner = new TaskRunner();
