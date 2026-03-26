import { generateResponse } from './generateResponse';
import { generateReflection } from './generateReflection';
import { generateEmbeddingForMemory } from './generateEmbedding';
import { emitter } from '../engine/emitter';

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
      const result = await generateResponse(conversationId, speakerId);
      if (!result) {
        this.conversationSlots--;
        emitter.markDirty('conversations');
        return;
      }
      emitter.markDirty('conversations');
      if (result.messageCount < result.maxTurns && result.otherParticipantId) {
        await new Promise(resolve => setTimeout(resolve, 500));
        await this.runConversationTurn(conversationId, result.otherParticipantId);
      } else {
        // Conversation complete — let conversationsTick handle cleanup
        this.conversationSlots--;
        emitter.markDirty('conversations');
      }
    } catch (err) {
      console.error(`Conversation ${conversationId} error:`, err);
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

  triggerReflection(agentId: number) {
    const task = generateReflection(agentId).catch(err => {
      console.error(`Reflection failed for agent ${agentId}:`, err);
    });
    this.track(task);
  }

  get activeConversations() { return this.conversationSlots; }

  async drain() {
    await Promise.allSettled([...this.pendingTasks]);
  }
}

export const taskRunner = new TaskRunner();
