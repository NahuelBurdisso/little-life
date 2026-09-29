import { generateResponse } from './generateResponse';
import { generateEmbeddingForMemory } from './generateEmbedding';
import { emitter } from '../engine/emitter';
import { recordTurnLatency } from '../lib/conversationPacing';

class TaskRunner {
  private conversationSlots = 0;
  private readonly maxConcurrentConversations = 4;
  private pendingTasks = new Set<Promise<void>>();

  private track(task: Promise<void>) {
    this.pendingTasks.add(task);
    task.finally(() => this.pendingTasks.delete(task));
  }

  startConversation(conversationId: number, firstSpeakerId: number): boolean {
    if (this.conversationSlots >= this.maxConcurrentConversations) return false;
    this.conversationSlots++;
    const task = this.runConversationTurn(conversationId, firstSpeakerId);
    this.track(task);
    return true;
  }

  private async runConversationTurn(conversationId: number, speakerId: number): Promise<void> {
    try {
      const turnStart = performance.now();
      const result = await generateResponse(conversationId, speakerId);
      // Only turns that produced a line: they are what the scheduler sizes the
      // next conversations by (see conversationPacing.affordableTurns). Queue
      // wait on the LLM semaphore is included on purpose — it is real latency.
      if (result) recordTurnLatency(performance.now() - turnStart);
      if (!result) {
        this.conversationSlots--;
        emitter.markDirty('conversations');
        return;
      }
      emitter.markDirty('conversations');
      if (result.messageCount < result.maxTurns && result.otherParticipantId) {
        await new Promise(resolve => setTimeout(resolve, 200));
        await this.runConversationTurn(conversationId, result.otherParticipantId);
      } else {
        // Conversation complete — let conversationsTick handle cleanup
        this.conversationSlots--;
        emitter.markDirty('conversations');
      }
    } catch (err) {
      // The chain stops here and nothing retries the turn: the conversation
      // sits `active` until conversationsTick's game-minute budget wraps it up.
      // Say so, with who was speaking, instead of a bare error line.
      console.warn(
        `[taskRunner] Conversation ${conversationId}: turn for agent ${speakerId} threw; ` +
          'no further turns — the scheduler will close it at its budget.',
        err,
      );
      this.conversationSlots--;
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

  async drain() {
    await Promise.allSettled([...this.pendingTasks]);
  }

  /** Force-clear slot counters after drain/timeout. */
  resetSlots() {
    this.conversationSlots = 0;
    this.pendingTasks.clear();
  }
}

export const taskRunner = new TaskRunner();
