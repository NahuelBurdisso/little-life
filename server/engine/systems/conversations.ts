/**
 * Conversations System — Tick Handler
 *
 * Manages the conversation lifecycle:
 *   A) Check active LLM conversations for completion
 *   C) Process queue timeouts with template fallback
 *   D) Fill open LLM slots from the queue
 *
 * Also handles post-conversation effects: relationship events, memories,
 * embedding generation, and needs updates.
 *
 * This file keeps the phase entry point (the sync pass in one transaction, then
 * the async pass) and the boot/day-change helpers. The steps live in
 * ./conversations/: activeConversations (A, B), queue (C–E), tickState (the
 * per-tick state they share), completion with completionContext, facts and
 * darkDynamics (after an LLM conversation), template (template chats).
 */

import { db } from '../../db';
import {
  agents,
  conversations,
  conversationQueue,
  conversationSchedulerState,
  worldState,
} from '../../db/schema';
import type { ActiveLLMEntry } from '../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { gameMinutes } from '../../lib/gameClock';
import { clearConversationCache } from '../../helpers/conversationHelpers';
import { emitter } from '../emitter';
import { taskRunner } from '../../ai/taskRunner';
import { markLatencyProbe, turnLatencyEstimateMs } from '../../lib/conversationPacing';
import { simEvents } from '../../lib/simEvents';
import type { ConversationRow, WorldRow } from './conversations/types';
import { releaseTalkingParticipants } from './conversations/helpers';
import type { ConversationTickOutcome, ConversationTickState } from './conversations/tickState';
import { checkActiveConversations, sweepOrphanedConversations } from './conversations/activeConversations';
import { workQueue } from './conversations/queue';
import { finishCompletedConversation } from './conversations/completion';
import { processTimedOutEntry } from './conversations/template';

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

/**
 * Keep only the newest MAX_ENDED_RETAINED ended conversations. The table was
 * append-only, and each row carries its full message transcript. Run on day
 * change. Returns the number of rows deleted.
 */
export function pruneEndedConversations(keep: number = CONFIG.CONVERSATIONS.MAX_ENDED_RETAINED): number {
  return db.run(sql`
    DELETE FROM conversations
    WHERE status = 'ended'
      AND id NOT IN (
        SELECT id FROM conversations WHERE status = 'ended'
        ORDER BY ended_at DESC, id DESC LIMIT ${keep}
      )
  `).changes;
}

/**
 * At boot: end every LLM conversation the scheduler still tracks but no turn
 * chain in this process is running. The task runner is in-memory, so after a
 * restart those entries have nobody generating their turns; they used to sit
 * `active`, holding both agents `talking`, until their budget ran out — and
 * Step A then booked their whole age as a turn latency. Ended quietly (no
 * memories or relationship effects for a conversation cut by a restart) and
 * the participants handed back. Returns the number of conversations ended.
 */
export function endOrphanedLLMConversations(): number {
  return db.transaction(() => {
    const schedulerState = db.select().from(conversationSchedulerState).get();
    if (!schedulerState) return 0;
    const entries = schedulerState.active_llm_conversations as ActiveLLMEntry[];
    const keep: ActiveLLMEntry[] = [];
    let ended = 0;
    for (const entry of entries) {
      if (taskRunner.isRunning(entry.conversationId)) {
        keep.push(entry);
        continue;
      }
      const row = db.select().from(conversations).where(eq(conversations.id, entry.conversationId)).get();
      if (row) {
        if (row.status !== 'ended') {
          db.update(conversations)
            .set({ status: 'ended', ended_at: Date.now() })
            .where(eq(conversations.id, row.id))
            .run();
          ended++;
        }
        releaseTalkingParticipants(row);
      }
      clearConversationCache(entry.conversationId);
    }
    if (keep.length !== entries.length) {
      db.update(conversationSchedulerState)
        .set({ active_llm_conversations: keep })
        .where(eq(conversationSchedulerState.id, schedulerState.id))
        .run();
    }
    return ended;
  });
}

export async function conversationsTick(): Promise<void> {
  const out: ConversationTickOutcome = {
    dispatches: [],
    completedConversations: [],
    timedOutQueue: [],
    closedIds: [],
    changed: false,
    agentsReleased: false,
  };

  // ── Sync part: all DB reads and writes inside a single transaction ──────────
  db.transaction(() => runSyncPass(out));

  // ── Async part: dispatch LLM calls outside transaction ─────────────────────
  await runAsyncPass(out);
}

/**
 * The body of the tick's single transaction: every step runs synchronously, in
 * order, and must stay free of `await` (better-sqlite3 transactions are sync).
 */
function runSyncPass(out: ConversationTickOutcome): void {
  const world = db.select().from(worldState).get();
  if (!world) return;

  // Read scheduler state singleton
  const schedulerState = db.select().from(conversationSchedulerState).get();
  if (!schedulerState) return;

  const state: ConversationTickState = {
    out,
    world,
    schedulerState,
    activeLLM: [
      ...(schedulerState.active_llm_conversations as ActiveLLMEntry[]),
    ],
    llmTotal: schedulerState.stats.llmConversationsTotal,
    templateTotal: schedulerState.stats.templateConversationsTotal,
    queueTimeouts: schedulerState.stats.queueTimeoutsTotal,
    now: Date.now(),
    nowGameMin: gameMinutes(world.time),
    busyAgents: new Set<number>(),
    livePairs: new Map<string, string | null>(),
    agentFreeAt: new Map<number, number>(),
    claimedAgents: new Set<number>(),
    reservedPairs: new Set<string>(),
    currentActive: 0,
    runnerFreeSlots: 0,
    fillEntries: [],
  };

  const updatedActiveLLM = checkActiveConversations(state);
  sweepOrphanedConversations(state);
  workQueue(state, updatedActiveLLM);
  saveSchedulerState(state);
}

/** Write the scheduler's entries and running totals back: the last write of the pass. */
function saveSchedulerState(state: ConversationTickState): void {
  const { schedulerState, nowGameMin } = state;
  // --- Update scheduler state ---
  db.update(conversationSchedulerState)
    .set({
      active_llm_conversations: state.fillEntries,
      stats: {
        llmConversationsTotal: state.llmTotal,
        templateConversationsTotal: state.templateTotal,
        // Was never written (always 0); now the median turn latency the
        // scheduler sizes conversations by, so diagnostics can see it.
        averageResponseTimeMs: Math.round(turnLatencyEstimateMs(nowGameMin) ?? schedulerState.stats.averageResponseTimeMs),
        queueTimeoutsTotal: state.queueTimeouts,
      },
    })
    .where(eq(conversationSchedulerState.id, schedulerState.id))
    .run();
}

/**
 * Everything after the transaction has committed, in the original order: abort
 * closed conversations' turns and hand new ones to the task runner (both
 * synchronous, before the first await), then the template chats and
 * completions one at a time, then the dirty-channel emits.
 */
async function runAsyncPass(out: ConversationTickOutcome): Promise<void> {
  startDispatchedConversations(out);

  // Process timed-out queue entries with template fallback
  for (const { entry, world } of out.timedOutQueue) {
    try {
      await processTimedOutEntry(entry, world);
    } catch (err) {
      console.error('[conversations] Error processing timed-out entry:', err);
    }
  }

  // Process completed LLM conversations
  for (const { conversation, world, truncated } of out.completedConversations) {
    try {
      await processCompletedConversation(conversation, world, truncated);
    } catch (err) {
      console.error('[conversations] Error processing completed conversation:', err);
    }
  }

  if (out.changed) {
    emitter.markDirty('conversations');
  }
  if (out.agentsReleased) {
    // Releasing an agent changes no conversation row, so the agent snapshot has to
    // be pushed explicitly or the client keeps rendering them as talking.
    emitter.markDirty('agents.all');
  }
}

/**
 * Cancel the turns of conversations Step A closed, then start the ones the pass
 * opened; a dispatch the runner refuses is undone and its queue entry restored.
 */
function startDispatchedConversations(out: ConversationTickOutcome): void {
  for (const id of out.closedIds) taskRunner.abortConversation(id);
  for (const d of out.dispatches) {
    const accepted = taskRunner.startConversation(d.conversationId, d.speakerId);
    if (accepted) {
      if (d.probeAt != null) markLatencyProbe(d.probeAt);
      simEvents.emit('conversation:started', { agentId: d.participantIds[0], otherName: d.participantNames[1] });
      simEvents.emit('conversation:started', { agentId: d.participantIds[1], otherName: d.participantNames[0] });
    }
    if (!accepted) {
      // Task runner slots full — remove the conversation record, reset agents to
      // idle and put the entry back: it used to be dropped here, silently losing
      // player nudges whenever a closed conversation's turn still held a slot.
      // Step A drops the scheduler entry once it finds the row gone.
      db.delete(conversations).where(eq(conversations.id, d.conversationId)).run();
      const { id: _id, ...requeued } = d.entry;
      db.insert(conversationQueue).values(requeued).run();
      for (const pid of d.participantIds) {
        db.update(agents)
          .set({ current_action: { type: 'idle' }, action_duration: null })
          .where(eq(agents.id, pid))
          .run();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Process a completed conversation
// ---------------------------------------------------------------------------

async function processCompletedConversation(
  conversation: ConversationRow,
  world: WorldRow,
  truncated: boolean = false,
): Promise<void> {
  try {
    await finishCompletedConversation(conversation, world, truncated);
  } finally {
    // Step A has already dropped this conversation from the scheduler, so if the
    // completion threw anywhere before its own `ended` write, nothing would ever
    // end the row: it stayed `active` with both agents `talking`. End it and hand
    // the participants back regardless (a no-op when the normal path finished).
    const res = db.update(conversations)
      .set({ status: 'ended', ended_at: Date.now() })
      .where(and(eq(conversations.id, conversation.id), eq(conversations.status, 'active')))
      .run();
    if (res.changes > 0) emitter.markDirty('conversations');
    if (releaseTalkingParticipants(conversation)) emitter.markDirty('agents.all');
  }
}
