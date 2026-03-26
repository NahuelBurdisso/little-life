import { generateResponse } from './generateResponse';
import { generateReflection } from './generateReflection';
import { generateEmbeddingForMemory } from './generateEmbedding';
import { markConversationEnded } from '../helpers/conversationHelpers';
import { emitter } from '../engine/emitter';
import { db } from '../db';
import { conversations as conversationsTable, agents } from '../db/schema';
import { eq } from 'drizzle-orm';

class TaskRunner {
  private conversationSlots = 0;
  private readonly maxConcurrentConversations = 2;
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
        markConversationEnded(conversationId);
        // Reset agents to idle
        const convo = db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId)).get();
        if (convo?.participants) {
          for (const pid of convo.participants as number[]) {
            db.update(agents).set({ current_action: { type: 'idle' }, action_duration: null }).where(eq(agents.id, pid)).run();
          }
        }
        emitter.markDirty('conversations');
        emitter.markDirty('agents.all');
        emitter.flush();
        return;
      }
      emitter.markDirty('conversations');
      if (result.messageCount < result.maxTurns && result.otherParticipantId) {
        await new Promise(resolve => setTimeout(resolve, 500));
        await this.runConversationTurn(conversationId, result.otherParticipantId);
      } else {
        this.conversationSlots--;
        // Conversation reached max turns — mark ended + reset agents
        markConversationEnded(conversationId);
        const convo = db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId)).get();
        if (convo?.participants) {
          for (const pid of convo.participants as number[]) {
            db.update(agents).set({ current_action: { type: 'idle' }, action_duration: null }).where(eq(agents.id, pid)).run();
          }
        }
        emitter.markDirty('conversations');
        emitter.markDirty('agents.all');
        emitter.flush();
      }
    } catch (err) {
      console.error(`Conversation ${conversationId} error:`, err);
      this.conversationSlots--;
      markConversationEnded(conversationId);
      // Reset agents back to idle after error
      const convo = db.select().from(conversationsTable).where(eq(conversationsTable.id, conversationId)).get();
      if (convo?.participants) {
        for (const pid of convo.participants as number[]) {
          db.update(agents).set({ current_action: { type: 'idle' }, action_duration: null }).where(eq(agents.id, pid)).run();
        }
      }
      emitter.markDirty('conversations');
      emitter.markDirty('agents.all');
      emitter.flush();
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
