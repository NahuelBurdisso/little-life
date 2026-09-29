import { generateResponse } from './generateResponse';
import { generateEmbeddingForMemory } from './generateEmbedding';
import { emitter } from '../engine/emitter';

class TaskRunner {
  private conversationSlots = 0;
  private readonly maxConcurrentConversations = 4;
  private pendingTasks = new Set<Promise<void>>();
  /** One per live turn chain, so closing a conversation can cancel its turn. */
  private readonly aborts = new Map<number, AbortController>();
  /** Wall-clock start of the turn each live chain is generating right now. */
  private readonly turnStartedAt = new Map<number, number>();
  /**
   * Bumped by resetSlots(). A chain started before a reset must not touch the
   * counters when it finally unwinds — its slot was already written off, and
   * decrementing again drove `conversationSlots` negative (more chains than the
   * limit could then start).
   */
  private epoch = 0;

  private track(task: Promise<void>) {
    this.pendingTasks.add(task);
    task.finally(() => this.pendingTasks.delete(task));
  }

  startConversation(conversationId: number, firstSpeakerId: number): boolean {
    if (this.conversationSlots >= this.maxConcurrentConversations) return false;
    this.conversationSlots++;
    const controller = new AbortController();
    this.aborts.set(conversationId, controller);
    const task = this.runConversation(conversationId, firstSpeakerId, controller, this.epoch);
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

  /** Is a turn chain alive for this conversation in THIS process? */
  isRunning(conversationId: number): boolean {
    return this.aborts.has(conversationId);
  }

  /**
   * How long the turn this conversation's live chain is generating has been
   * running, or null when no chain is alive (finished, died on a throw, or
   * never started in this process — e.g. a scheduler entry left by a restart).
   */
  inFlightTurnMs(conversationId: number, now: number = Date.now()): number | null {
    const startedAt = this.turnStartedAt.get(conversationId);
    return startedAt == null ? null : Math.max(0, now - startedAt);
  }

  /** Chains turns until the conversation is full, closed, or a turn fails. */
  private async runConversation(
    conversationId: number,
    firstSpeakerId: number,
    controller: AbortController,
    epoch: number,
  ): Promise<void> {
    const { signal } = controller;
    let speakerId: number | undefined = firstSpeakerId;
    try {
      while (speakerId != null && !signal.aborted) {
        let result;
        this.turnStartedAt.set(conversationId, Date.now());
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
        } finally {
          if (this.aborts.get(conversationId) === controller) this.turnStartedAt.delete(conversationId);
        }
        emitter.markDirty('conversations');
        // null: context gone, conversation closed or the turn was aborted.
        // Otherwise the scheduler handles cleanup once the transcript is full.
        if (!result || result.messageCount >= result.maxTurns) return;
        speakerId = result.otherParticipantId;
        if (speakerId != null) await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } finally {
      if (epoch === this.epoch) {
        this.conversationSlots = Math.max(0, this.conversationSlots - 1);
        if (this.aborts.get(conversationId) === controller) {
          this.aborts.delete(conversationId);
          this.turnStartedAt.delete(conversationId);
        }
      }
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
  get freeConversationSlots() {
    return Math.min(this.maxConcurrentConversations, Math.max(0, this.maxConcurrentConversations - this.conversationSlots));
  }

  async drain() {
    await Promise.allSettled([...this.pendingTasks]);
  }

  /**
   * Force-clear slot counters after drain/timeout (world replace). Chains that
   * outlived the drain are cancelled first — otherwise their model calls kept
   * running against the replaced world — and, via the epoch, no longer count.
   */
  resetSlots() {
    for (const controller of this.aborts.values()) controller.abort();
    this.epoch++;
    this.conversationSlots = 0;
    this.pendingTasks.clear();
    this.aborts.clear();
    this.turnStartedAt.clear();
  }
}

export const taskRunner = new TaskRunner();
