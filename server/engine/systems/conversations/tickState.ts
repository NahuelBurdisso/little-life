/**
 * The per-tick state of the conversation phase: what the sync pass reads and
 * mutates inside its transaction, and what it hands to the async pass after it.
 * Built fresh by every tick; nothing here outlives it.
 */

import { db } from '../../../db';
import { conversationQueue, conversationSchedulerState } from '../../../db/schema';
import type { ActiveLLMEntry } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../../../lib/constants';
import type { ConversationRow, QueueRow, WorldRow } from './types';
import { conversationPairKey, isProtectedEntry } from './helpers';

type SchedulerStateRow = typeof conversationSchedulerState.$inferSelect;

/** An LLM conversation opened in the transaction, handed to the task runner after it. */
interface ConversationDispatch {
  conversationId: number;
  speakerId: number;
  participantIds: number[];
  participantNames: string[];
  /** The queue row it came from, restored if the task runner refuses it. */
  entry: QueueRow;
  /** Game minute to stamp as the latency probe, if this dispatch is one. */
  probeAt: number | null;
}

/**
 * What the sync pass leaves for the async pass. Filled inside the transaction
 * and read only after it has committed: everything here is work that must not
 * run inside it (the task runner, awaited template and completion processing,
 * the dirty-channel emits).
 */
export interface ConversationTickOutcome {
  // Collected LLM dispatch tasks — executed OUTSIDE the transaction (fire-and-forget async)
  dispatches: ConversationDispatch[];
  // Completed LLM conversations to process asynchronously — OUTSIDE the transaction.
  // `truncated` marks conversations the game-minute budget cut before their
  // planned turns, so downstream consumers can tell a cut-short exchange from a
  // natural one (or from someone leaving to sleep or eat).
  completedConversations: Array<{ conversation: ConversationRow; world: WorldRow; truncated: boolean }>;
  // Timed-out queue entries needing template fallback — OUTSIDE the transaction
  timedOutQueue: Array<{ entry: QueueRow; world: WorldRow }>;
  // Conversations Step A closed this tick: any LLM turn still running for them
  // is cancelled after the transaction, freeing its runner and LLM slots.
  closedIds: number[];
  changed: boolean;
  // Set when Step A puts an agent back to idle; the agent snapshot has to be
  // re-pushed to the client even though no conversation row changed.
  agentsReleased: boolean;
}

/**
 * Everything the steps of the sync pass read and mutate, built once per tick
 * inside the transaction. `out` is what crosses over to the async pass.
 */
export interface ConversationTickState {
  out: ConversationTickOutcome;
  world: WorldRow;
  schedulerState: SchedulerStateRow;
  /** The scheduler's entries as read at the start of the tick (Step A mutates them in place). */
  activeLLM: ActiveLLMEntry[];
  llmTotal: number;
  templateTotal: number;
  queueTimeouts: number;
  /** WALL-CLOCK ms. */
  now: number;
  // Conversation budgets and queue waits are GAME minutes (see
  // conversationPacing.ts), so the conversation rate follows the game clock.
  nowGameMin: number;
  // Who is tied up in a conversation this tick — see "Participant claims" below.
  // Built from the scheduler's OWN entries, not from every `active` row: a row
  // whose completion crashed stayed `active` forever, and reading busy-ness off
  // the table locked its participants out of every future conversation.
  // Entries Step A completes this tick still count (they're processed after the
  // transaction, and their participants are still `talking` until then).
  busyAgents: Set<number>;
  /** Pair key → topic of the live conversation between them. */
  livePairs: Map<string, string | null>;
  /** Agent → game minute by which the conversation holding them must be over. */
  agentFreeAt: Map<number, number>;
  /** Agents claimed by a conversation started (or being staged) this pass. */
  claimedAgents: Set<number>;
  /** Pairs a higher-priority LLM entry is waiting on this pass (slots full). */
  reservedPairs: Set<string>;
  /** LLM conversations running after Step A plus those opened this pass. */
  currentActive: number;
  /** Chains the task runner can still take, read when the queue pass starts. */
  runnerFreeSlots: number;
  /** The scheduler entries written back at the end of the pass. */
  fillEntries: ActiveLLMEntry[];
}

/** Mark a live conversation's participants busy until `freeAt` (game minutes). */
export function registerLive(
  state: ConversationTickState,
  participants: number[],
  topic: string | null,
  freeAt: number,
): void {
  for (const id of participants) {
    state.busyAgents.add(id);
    state.agentFreeAt.set(id, Math.max(state.agentFreeAt.get(id) ?? 0, freeAt));
  }
  state.livePairs.set(conversationPairKey(participants), topic);
}

// --- Participant claims ---
// Nothing downstream stopped one agent from being in two conversations at
// once: the queue can hold [A,B] and [B,A] (both decided to socialize with
// each other in the same decisions pass), or [A,B] and [A,C], and Steps C–E
// turned every entry into a conversation independently — four started in the
// same millisecond in one playtest. Every path that starts a conversation now
// claims its participants first; an agent can be claimed once per pass, and
// never while a live conversation (`busyAgents`, from Step A) still holds them.
/**
 * 'duplicate': this exact pair already has a live conversation or one started
 *   this pass — the entry is redundant and should be dropped. Not for a
 *   protected entry with a different topic: a player's "tell her the secret"
 *   while the two are already chatting is a new conversation, to be had once
 *   the current one ends.
 * 'busy': someone is tied up with a different partner — the entry can wait.
 */
export function claimParticipants(
  state: ConversationTickState,
  entry: QueueRow,
  { peek = false, freeAt = state.nowGameMin }: { peek?: boolean; freeAt?: number } = {},
): 'ok' | 'duplicate' | 'busy' {
  const { livePairs, reservedPairs, busyAgents, claimedAgents, agentFreeAt } = state;
  const p = entry.participants as number[];
  const key = conversationPairKey(p);
  if (livePairs.has(key)) {
    return isProtectedEntry(entry) && livePairs.get(key) !== entry.topic ? 'busy' : 'duplicate';
  }
  if (reservedPairs.has(key)) return 'busy';
  if (p.some((id) => busyAgents.has(id) || claimedAgents.has(id))) return 'busy';
  if (peek) return 'ok';
  for (const id of p) {
    claimedAgents.add(id);
    agentFreeAt.set(id, Math.max(agentFreeAt.get(id) ?? 0, freeAt));
  }
  livePairs.set(key, entry.topic);
  return 'ok';
}

/**
 * A protected entry (player nudge, comfort visit) that timed out only because
 * a participant is mid-conversation waits for that conversation instead of
 * being dropped. Bounded: the new deadline is when the blocking conversation
 * must be over at the latest, plus a margin — never open-ended. Returns true
 * when the wait was extended and the entry stays queued.
 */
export function extendProtectedWait(state: ConversationTickState, entry: QueueRow): boolean {
  const { agentFreeAt, nowGameMin } = state;
  if (!isProtectedEntry(entry)) return false;
  const blockers = (entry.participants as number[])
    .map((id) => agentFreeAt.get(id))
    .filter((t): t is number => t != null);
  if (blockers.length === 0) return false; // not held by a conversation
  const deadline = Math.max(...blockers) + CONFIG.CONVERSATIONS.PROTECTED_WAIT_MARGIN_GAME_MINUTES;
  if (deadline <= nowGameMin) return false;
  db.update(conversationQueue)
    .set({ deadline_game_min: deadline })
    .where(eq(conversationQueue.id, entry.id))
    .run();
  return true;
}
