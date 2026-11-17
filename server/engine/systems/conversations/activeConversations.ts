/**
 * Steps A and B of the conversation tick: live LLM conversations the scheduler
 * tracks, and `active` rows it no longer does.
 */

import { db } from '../../../db';
import { conversations } from '../../../db/schema';
import type { ActiveLLMEntry, ConversationMessage } from '../../../db/schema';
import { eq, and, lt } from 'drizzle-orm';
import { CONFIG } from '../../../lib/constants';
import { clearConversationCache } from '../../../helpers/conversationHelpers';
import { taskRunner } from '../../../ai/taskRunner';
import { conversationBudgetGameMinutes, recordTurnLatency } from '../../../lib/conversationPacing';
import type { ConversationRow } from './types';
import {
  closeWrappedTranscript,
  findNeedsInterrupt,
  nextSpeaker,
  releaseTalkingParticipants,
} from './helpers';
import { type ConversationTickState, registerLive } from './tickState';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Age past which an `active` conversation row the scheduler no longer tracks is
 * swept as an orphan, per deep turn.
 *
 * CLOCK: WALL-CLOCK MS against `conversations.started_at` (a `Date.now()`
 * stamp). This used to be the conversation budget itself — which made the
 * budget ten game hours at 4x (G1). Conversations now run on a game-minute
 * budget (Step A); this only has to outlast the moment between a row's insert
 * and its scheduler entry, so the old generous figure is kept as is.
 */
const ORPHAN_MS_PER_DEEP_TURN = 15000;

/**
 * Step A: check every LLM conversation the scheduler tracks — wrap up, close or
 * keep it — and register who is still tied up. Returns the entries that stay.
 */
export function checkActiveConversations(state: ConversationTickState): ActiveLLMEntry[] {
  // --- Step A: Check active LLM conversations ---
  const toRemove = new Set<number>();

  for (const entry of state.activeLLM) {
    checkActiveEntry(state, entry, toRemove);
  }

  const updatedActiveLLM = state.activeLLM.filter(
    (e) => !toRemove.has(e.conversationId),
  );
  return updatedActiveLLM;
}

/** Step A for one scheduler entry; adds its id to `toRemove` when it leaves the scheduler. */
function checkActiveEntry(
  state: ConversationTickState,
  entry: ActiveLLMEntry,
  toRemove: Set<number>,
): void {
  const { world, nowGameMin } = state;
  const conversation = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, entry.conversationId))
    .get();

  if (!conversation) {
    // Row is gone — nothing downstream will ever evict its cached identities.
    clearConversationCache(entry.conversationId);
    toRemove.add(entry.conversationId);
    return;
  }

  // Already ended by someone outside this system — `markConversationEnded`
  // (LLM context lost) or `deactivateAgent` (participant died).
  // `processCompletedConversation` bails immediately on `status === 'ended'`,
  // so routing this arm there dequeued the entry and did nothing at all,
  // stranding both agents in `current_action = 'talking'` forever. Release
  // them and drop the caches here instead.
  if (conversation.status === 'ended') {
    if (releaseTalkingParticipants(conversation)) state.out.agentsReleased = true;
    clearConversationCache(conversation.id);
    toRemove.add(entry.conversationId);
    state.out.changed = true;
    return;
  }

  const messages = conversation.messages as ConversationMessage[];

  // Entries dispatched before game-time budgets existed carry only the
  // wall-clock stamp: start their budget now rather than guess.
  entry.startedGameMin ??= nowGameMin;
  entry.plannedTurns ??= conversation.max_turns;
  entry.budgetGameMin ??= conversationBudgetGameMinutes(entry.plannedTurns);
  const graceGameMin = entry.graceGameMin ?? CONFIG.CONVERSATIONS.WRAP_UP_GRACE_GAME_MINUTES;
  const deadlineGameMin = entry.startedGameMin + entry.budgetGameMin;

  const completion = decideCompletion(state, entry, conversation, messages, deadlineGameMin, graceGameMin);

  registerLive(
    state,
    conversation.participants as number[],
    conversation.topic,
    completion
      ? nowGameMin
      : (entry.wrapUp ? entry.wrapUp.sinceGameMin : deadlineGameMin) + graceGameMin,
  );

  if (completion) {
    // Force-ends go through the SAME completion pipeline as natural ends.
    // The previous inline hand-rolled ending skipped quality scoring,
    // relationship events, memories and cache eviction, and emitted
    // `conversation:ended` exactly once — for participants[0], with an empty
    // otherName — so every listener silently dropped participant #2.
    state.out.completedConversations.push({ conversation, world, truncated: completion.truncated });
    state.out.closedIds.push(conversation.id);
    toRemove.add(entry.conversationId);
    state.llmTotal++;
    state.out.changed = true;
  }
}

/**
 * Whether a live conversation is over this tick: all its turns landed, or it is
 * wrapping up (budget or a participant's needs) and its last turn landed or the
 * grace ran out. Starts the wrap-up when one is due, lowering `max_turns`.
 * Returns null while it keeps going.
 */
function decideCompletion(
  state: ConversationTickState,
  entry: ActiveLLMEntry,
  conversation: ConversationRow,
  messages: ConversationMessage[],
  deadlineGameMin: number,
  graceGameMin: number,
): { truncated: boolean } | null {
  const { world, now, nowGameMin } = state;
  // `entry.plannedTurns` is always set here: checkActiveEntry defaults it first.
  // `truncated` = the CLOCK stopped it before its planned turns. Not set for
  // a needs wrap-up (someone chose to leave) nor when the last planned turn
  // landed in time (nothing was actually cut).
  let completion: { truncated: boolean } | null = null;

  if (!entry.wrapUp && messages.length >= conversation.max_turns) {
    completion = { truncated: false };
  } else {
    if (!entry.wrapUp) {
      // The turn the task runner is working on now (or would start next).
      const inFlightSpeaker = nextSpeaker(conversation);
      let target: number | null = null;
      // Budget first: it is measured from the deadline itself, so the grace
      // below runs from when the budget ran out, not from whichever tick
      // noticed — the hard stop is always start + budget + grace.
      if (nowGameMin >= deadlineGameMin) {
        entry.wrapUp = { reason: 'budget', sinceGameMin: deadlineGameMin };
        // Let the turn in flight land and, if nobody has spoken yet, the
        // reply to it too (so an exchange that is merely slow still happens);
        // the runner starts nothing beyond that. Grace bounds both.
        target = Math.max(messages.length + 1, CONFIG.CONVERSATIONS.MIN_LLM_TURNS);
      } else if (!entry.protected || messages.length >= CONFIG.CONVERSATIONS.MIN_LLM_TURNS) {
        // Needs can end a conversation — but one the player asked for gets
        // its first exchange before anyone's stomach or bedtime cuts in.
        const needy = findNeedsInterrupt(conversation.participants as number[], world);
        if (needy) {
          entry.wrapUp = { reason: needy.reason, sinceGameMin: nowGameMin, leaverId: needy.agentId };
          // The leaver's farewell must follow the OTHER person's line: when the
          // turn in flight is the leaver's own, the farewell replaces it
          // (closes now); otherwise the partner's reply may land first.
          target = inFlightSpeaker === needy.agentId ? messages.length : messages.length + 1;
        }
      }
      if (target != null) {
        target = Math.min(conversation.max_turns, target);
        if (target !== conversation.max_turns) {
          db.update(conversations).set({ max_turns: target }).where(eq(conversations.id, conversation.id)).run();
          conversation.max_turns = target;
        }
        state.out.changed = true;
      }
    }
    if (entry.wrapUp) {
      const landed = messages.length >= conversation.max_turns;
      if (landed || nowGameMin >= entry.wrapUp.sinceGameMin + graceGameMin) {
        if (!landed) {
          // The turn in flight never landed. Book how long it had been running
          // as a (censored) latency sample: a model too slow to finish any
          // turn would otherwise never be measured at all. Only for a turn
          // that really is running in this process — a chain that died on a
          // throw, or a scheduler entry a restart left behind, has no turn in
          // flight, and booking its whole age sent the median through the roof
          // (the town then ran on templates, even at 1x). Capped at what one
          // turn can legitimately take: every attempt timing out.
          const inFlightMs = taskRunner.inFlightTurnMs(conversation.id, now);
          if (inFlightMs != null) {
            recordTurnLatency(Math.min(inFlightMs, CONFIG.AI.TIMEOUT_MS * CONFIG.AI.RETRY_ATTEMPTS), nowGameMin);
          }
        }
        closeWrappedTranscript(
          conversation,
          entry.wrapUp.leaverId ?? nextSpeaker(conversation),
          entry.wrapUp.reason,
          entry.plannedTurns!,
        );
        completion = {
          truncated: entry.wrapUp.reason === 'budget' && messages.length < entry.plannedTurns!,
        };
      }
    }
  }
  return completion;
}

/**
 * Step B: end `active` rows the scheduler no longer tracks and release their
 * participants. Reads `activeLLM` as the tick found it, before Step A's removals.
 */
export function sweepOrphanedConversations(state: ConversationTickState): void {
  const { activeLLM, now } = state;
  const orphanAgeMs = state.schedulerState.max_turns_deep * ORPHAN_MS_PER_DEEP_TURN;
  // --- Step B: Sweep orphaned `active` rows ---
  // A conversation row is `active` only while the scheduler tracks it. One the
  // scheduler has dropped without it ever reaching `ended` (a completion that
  // threw, a crash between dispatch and bookkeeping) was never cleaned up and
  // left its participants `talking` for good. Anything untracked and older than
  // the longest a conversation may run is ended here and its agents released.
  // Rows in `activeLLM` (including those Step A is completing) are skipped: their
  // completion runs after this transaction.
  const trackedIds = new Set(activeLLM.map((e) => e.conversationId));
  for (const orphan of db
    .select()
    .from(conversations)
    .where(and(eq(conversations.status, 'active'), lt(conversations.started_at, now - orphanAgeMs)))
    .all()) {
    if (trackedIds.has(orphan.id)) continue;
    db.update(conversations)
      .set({ status: 'ended', ended_at: now })
      .where(eq(conversations.id, orphan.id))
      .run();
    if (releaseTalkingParticipants(orphan)) state.out.agentsReleased = true;
    clearConversationCache(orphan.id);
    state.out.changed = true;
  }
}
