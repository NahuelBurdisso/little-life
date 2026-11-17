/**
 * The shared facts of a finished LLM conversation, computed once for every
 * section of the completion (./completion.ts).
 */

import { db } from '../../../db';
import { agents, conversations } from '../../../db/schema';
import type { ConversationMessage } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { clearConversationCache, fallbackDetector } from '../../../helpers/conversationHelpers';
import { emitter } from '../../emitter';
import type { AgentRow, ConversationRow, WorldRow } from './types';
import { releaseTalkingParticipants } from './helpers';

/**
 * What the sections of a finished LLM conversation read, computed once by
 * `loadCompletion` so each section gets the same values the single long
 * function used to share as locals. `conversation` is the row Step A handed
 * over; `fresh` is the row re-read at completion time, whose transcript is final.
 */
export interface CompletionContext {
  conversation: ConversationRow;
  fresh: ConversationRow;
  world: WorldRow;
  messages: ConversationMessage[];
  /** WALL-CLOCK ms, stamped on this completion's events and `ended_at`. */
  now: number;
  /** Step A's verdict that the clock cut this conversation short. */
  cutShort: boolean;
  isFallback: ReturnType<typeof fallbackDetector>;
  overallSentiment: number;
  participantIds: number[];
  participants: AgentRow[];
  time: {
    day: number;
    hour: number;
    minute: number;
    totalTicks: number;
  };
}

/** Relationship deltas summed over every pair, for the quality evaluation. */
export interface RelationshipDeltaTotals {
  friendship: number;
  romance: number;
  trust: number;
}

/**
 * The shared facts of a completion, or null when there is nothing to complete:
 * already ended elsewhere, nothing said, or fewer than two participants left.
 * Each of those exits does its own cleanup here, exactly as the early returns
 * of the old single function did, so null means "stop, it's handled".
 */
export function loadCompletion(
  conversation: ConversationRow,
  world: WorldRow,
  truncated: boolean,
): CompletionContext | null {
  // Evict first, so every exit path below is covered. This is the terminal step
  // for the conversation — no further turns will be generated for it — and it
  // was the only completion path that never dropped its cached identities, so
  // two entries per LLM conversation (full agent rows, relationship, location,
  // personality and enrichment) accumulated for the life of the process.
  clearConversationCache(conversation.id);

  // Re-read to check if already processed (avoid double processing from TaskRunner + tick race)
  const fresh = db.select().from(conversations).where(eq(conversations.id, conversation.id)).get();
  if (!fresh || fresh.status === 'ended') {
    // The conversation was ended underneath us (LLM context lost, participant died,
    // player nudge). The scheduler entry is already gone, so nothing else will ever
    // rescue these agents — release them here or they stay `talking` forever.
    if (releaseTalkingParticipants(conversation)) emitter.markDirty('agents.all');
    return null;
  }

  const messages = fresh.messages as ConversationMessage[];
  const now = Date.now();

  // Step A's verdict is final. It used to be re-derived here against the fresh
  // transcript because the task runner could still append the final turn after
  // Step A's read; now Step A closes a wrapped-up transcript by pinning
  // `max_turns` to its length (addMessage refuses anything later), and it only
  // flags a clock cut when fewer than the planned turns were spoken.
  const cutShort = truncated;

  // Nothing was said: the LLM hung for the whole turn budget before the first
  // reply landed. Running the full completion path here invented a conversation
  // that never happened — a social boost of ~8, relationship events computed off
  // zero turns, "we talked about X" memories, cascade triggers. End it quietly
  // and just hand the participants back. (Only a force-end can reach here with
  // an empty transcript: a natural end needs `max_turns` messages.)
  if (messages.length === 0) {
    db.update(conversations)
      .set({ status: 'ended', ended_at: now, sentiment: 0 })
      .where(eq(conversations.id, fresh.id))
      .run();
    if (releaseTalkingParticipants(fresh)) emitter.markDirty('agents.all');
    return null;
  }

  // Calculate overall sentiment: average of all message sentiments
  // (canned fallback actions are not speech and don't count — sanitizeDialogue.ts)
  let overallSentiment = 0;
  const isFallback = fallbackDetector(fresh.participants as number[]);
  const spoken = messages.filter((m) => !isFallback(m));
  if (spoken.length > 0) {
    const sentimentSum = spoken.reduce((sum, m) => sum + (m.sentiment ?? 0), 0);
    overallSentiment = sentimentSum / spoken.length;
  }

  // Get participant agents
  const participantIds = fresh.participants as number[];
  const participants: AgentRow[] = [];
  for (const pid of participantIds) {
    const agent = db.select().from(agents).where(eq(agents.id, pid)).get();
    if (agent) participants.push(agent);
  }

  if (participants.length < 2) {
    // Can't process without at least 2 participants
    db.update(conversations)
      .set({
        status: 'ended',
        ended_at: now,
        sentiment: overallSentiment,
      })
      .where(eq(conversations.id, conversation.id))
      .run();
    if (releaseTalkingParticipants(fresh)) emitter.markDirty('agents.all');
    return null;
  }

  const time = world.time as {
    day: number;
    hour: number;
    minute: number;
    totalTicks: number;
  };

  return {
    conversation, fresh, world, messages, now, cutShort, isFallback,
    overallSentiment, participantIds, participants, time,
  };
}
