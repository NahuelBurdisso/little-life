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
 */

import { db } from '../../db';
import {
  agents,
  needs,
  conversations,
  conversationQueue,
  conversationSchedulerState,
  relationships,
  relationshipEvents,
  worldState,
  agentStates,
  economy,
  shared_knowledge,
  locations,
} from '../../db/schema';
import { logActivity } from '../../lib/activityLogger';
import { eq, and, desc, gt, lt, sql } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { gameMinutes } from '../../lib/gameClock';
import { clearConversationCache, fallbackDetector } from '../../helpers/conversationHelpers';
import { emitter } from '../emitter';
import { taskRunner } from '../../ai/taskRunner';
import { selectTemplate, interpolateTemplate, greetingCategory } from '../../ai/templates';
import { TEMPLATE_REPLY_FALLBACKS, ROLE_PLACEHOLDERS, WRAP_UP_FAREWELLS } from '../../data/templates';
import { gameMinutesToMs } from '../../lib/worldClock';
import {
  affordableTurns,
  averageTurnLatencyMs,
  conversationBudgetGameMinutes,
  isPastBedtime,
  needsWrapUpReason,
  type NeedsWrapUpReason,
} from '../../lib/conversationPacing';
import { OUTDOOR_TYPES } from '../../lib/worldgen/buildingTemplates';
import { simEvents } from '../../lib/simEvents';
import { extractTopics } from '../../ai/topics';
import { clamp } from '../../lib/utils';
import { calculateCompatibility, PersonalityProfile } from '../../lib/personality';
import { computeRelationshipDeltas, ConversationImpactContext } from '../../lib/relationshipImpact';
import { getAgentStates, getEffectivePersonality } from '../../lib/states';
import { createFact, spreadGossip, getShareableFacts, getHiddenSinCount, getNegativeFactCount } from '../../lib/gossip';
import { extractConfidedQuote } from '../../lib/factText';
import { evaluateConversation } from '../../lib/conversationEvaluator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConversationMessage {
  speakerId: number;
  text: string;
  sentiment: number;
  topics: string[];
  timestamp: number;
  fallback?: boolean;
}

type WrapUpReason = 'budget' | NeedsWrapUpReason;

/**
 * A live LLM conversation as the scheduler tracks it (persisted as JSON in
 * `conversation_scheduler_state.active_llm_conversations`, so new fields are
 * optional: entries written before them are stamped on first sight).
 */
interface ActiveLLMEntry {
  conversationId: number;
  /** WALL-CLOCK ms at dispatch. Only the orphan sweep and wait estimates use it. */
  startedAt: number;
  /** GAME MINUTES at dispatch — what the budget is measured from. */
  startedGameMin?: number;
  /** GAME MINUTES this conversation may run (tier max turns × allowance). */
  budgetGameMin?: number;
  /** Turns it was dispatched with, before any wrap-up lowered `max_turns`. */
  plannedTurns?: number;
  /**
   * Set once the conversation has to end early. `max_turns` is lowered so the
   * task runner stops after the in-flight turn; it is closed with a farewell
   * when that turn lands or `sinceGameMin` + grace passes. `leaverId` is the
   * participant whose needs called time; a budget wrap-up has none — whoever's
   * turn it is when it closes says goodbye.
   */
  wrapUp?: { reason: WrapUpReason; sinceGameMin: number; leaverId?: number };
}

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;
type QueueRow = typeof conversationQueue.$inferSelect;
type WorldRow = typeof worldState.$inferSelect;

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
 * How close two agents must be before an LLM conversation opens. Beyond this the
 * initiator walks over first (see the staging block in Step E). Kept well under
 * the 64px co-location cutoff so staging never fights that check.
 */
const TALK_DISTANCE_PX = 40;
/** Where the approacher stops: just inside talking range, not on top of them. */
const TALK_STAGE_OFFSET_PX = 24;
/** Destination drift tolerated before the walk order is re-issued. */
const TALK_STAGE_REISSUE_PX = 12;

/** Extra time a protected queue entry may wait past its blocker's latest end. */
const PROTECTED_WAIT_MARGIN_MS = 30_000;

/**
 * Entries the player (or the autoplay stand-in, just below the player) asked
 * for, and comfort visits someone walked across town for. These must not be
 * silently lost just because a participant happened to be mid-conversation.
 */
function isProtectedEntry(entry: QueueRow): boolean {
  return entry.priority >= CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY - 10
    || entry.trigger_reason === 'comfort_visit';
}

/** Order-independent key, so [A,B] and [B,A] are recognised as the same pair. */
function conversationPairKey(participants: number[]): string {
  return [...participants].sort((a, b) => a - b).join('-');
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

/**
 * Put every participant still marked as talking in THIS conversation back to idle.
 * Used whenever a conversation leaves the pipeline without going through
 * `processCompletedConversation` (ended externally, aborted, too few participants).
 * Returns true when at least one agent was released.
 */
function releaseTalkingParticipants(conversation: ConversationRow): boolean {
  const participantIds = conversation.participants as number[];
  let released = false;
  for (const participantId of participantIds) {
    const agent = db.select().from(agents).where(eq(agents.id, participantId)).get();
    if (!agent) continue;
    const action = agent.current_action as any;
    if (action?.type === 'talking' && String(action?.conversationId) === String(conversation.id)) {
      db.update(agents)
        .set({ current_action: { type: 'idle' }, action_duration: null })
        .where(eq(agents.id, participantId))
        .run();
      released = true;
    }
  }
  return released;
}

/**
 * The first participant whose body overrules the conversation — critical
 * energy, bedtime, critical hunger (see `needsWrapUpReason`). While an agent is
 * `talking`, decisions.ts skips them entirely, so without this a conversation
 * could hold someone awake and starving for as long as the LLM kept replying.
 */
function findNeedsInterrupt(
  participantIds: number[],
  world: WorldRow,
): { agentId: number; reason: NeedsWrapUpReason } | null {
  for (const agentId of participantIds) {
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    const n = db.select().from(needs).where(eq(needs.agent_id, agentId)).get();
    if (!agent || !n) continue;
    const critical = n.thresholds?.critical ?? CONFIG.NEEDS.THRESHOLDS.critical;
    // Same personality source as decisions.ts' checkSchedule.
    const personality = getEffectivePersonality(agentId) ?? (agent.personality as PersonalityProfile | null);
    const pastBedtime = agent.schedule
      ? isPastBedtime(agent.schedule, personality, world.time.hour)
      : false;
    const reason = needsWrapUpReason({ hunger: n.hunger, energy: n.energy, critical }, pastBedtime);
    if (reason) return { agentId, reason };
  }
  return null;
}

/** Whoever didn't say the last line — the one whose turn it is. */
function nextSpeaker(conversation: ConversationRow): number {
  const participantIds = conversation.participants as number[];
  const messages = conversation.messages as ConversationMessage[];
  const last = messages[messages.length - 1]?.speakerId;
  return participantIds.find((p) => p !== last) ?? participantIds[0];
}

/**
 * Close a wrapped-up conversation's transcript: a canned farewell from the
 * leaver when it stopped short of its planned turns (a conversation that got
 * every turn already ended on the model's own closing line), then `max_turns`
 * pinned to the final length so an LLM reply still in flight is refused by
 * addMessage instead of landing after the goodbye. Nothing said → no farewell:
 * a goodbye out of nowhere is not a conversation (finishCompletedConversation
 * ends those quietly).
 */
function closeWrappedTranscript(
  conversation: ConversationRow,
  leaverId: number,
  reason: WrapUpReason,
  plannedTurns: number,
): void {
  const messages = [...(conversation.messages as ConversationMessage[])];
  if (messages.length > 0 && messages.length < plannedTurns) {
    const otherId = (conversation.participants as number[]).find((p) => p !== leaverId);
    const otherName = otherId != null
      ? db.select({ name: agents.name }).from(agents).where(eq(agents.id, otherId)).get()?.name
      : undefined;
    const lines = WRAP_UP_FAREWELLS[reason];
    const line = lines[Math.floor(Math.random() * lines.length)];
    messages.push({
      speakerId: leaverId,
      text: interpolateTemplate(line.text, { 'other.name': otherName ?? 'friend' }),
      sentiment: line.sentiment,
      topics: [],
      timestamp: Date.now(),
      // Real speech, not a canned narration action (see sanitizeDialogue.ts).
      fallback: false,
    });
  }
  db.update(conversations)
    .set({ messages, max_turns: messages.length })
    .where(eq(conversations.id, conversation.id))
    .run();
}

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

export async function conversationsTick(): Promise<void> {
  // Collected LLM dispatch tasks — executed OUTSIDE the transaction (fire-and-forget async)
  const dispatches: Array<{
    conversationId: number;
    speakerId: number;
    participantIds: number[];
    participantNames: string[];
  }> = [];
  // Completed LLM conversations to process asynchronously — OUTSIDE the transaction.
  // `truncated` marks conversations the game-minute budget cut before their
  // planned turns, so downstream consumers can tell a cut-short exchange from a
  // natural one (or from someone leaving to sleep or eat).
  const completedConversations: Array<{ conversation: ConversationRow; world: WorldRow; truncated: boolean }> = [];
  // Timed-out queue entries needing template fallback — OUTSIDE the transaction
  const timedOutQueue: Array<{ entry: QueueRow; world: WorldRow }> = [];

  let changed = false;
  // Set when Step A puts an agent back to idle; the agent snapshot has to be
  // re-pushed to the client even though no conversation row changed.
  let agentsReleased = false;

  // ── Sync part: all DB reads and writes inside a single transaction ──────────
  db.transaction(() => {
    const world = db.select().from(worldState).get();
    if (!world) return;

    // Read scheduler state singleton
    const schedulerState = db.select().from(conversationSchedulerState).get();
    if (!schedulerState) return;

    const activeLLM: ActiveLLMEntry[] = [
      ...(schedulerState.active_llm_conversations as ActiveLLMEntry[]),
    ];
    let llmTotal = schedulerState.stats.llmConversationsTotal;
    let templateTotal = schedulerState.stats.templateConversationsTotal;
    let queueTimeouts = schedulerState.stats.queueTimeoutsTotal;

    // --- Step A: Check active LLM conversations ---
    const toRemove = new Set<number>();
    const orphanAgeMs = schedulerState.max_turns_deep * ORPHAN_MS_PER_DEEP_TURN;
    const now = Date.now();
    // Conversation budgets are GAME minutes (see conversationPacing.ts); only
    // the wait estimates handed to other systems are converted back to wall ms.
    const nowGameMin = gameMinutes(world.time);
    const graceGameMin = CONFIG.CONVERSATIONS.WRAP_UP_GRACE_GAME_MINUTES;
    /** Wall-clock ms by which something `gameMin` game minutes away happens. */
    const wallAt = (gameMin: number): number =>
      now + gameMinutesToMs(Math.max(0, gameMin - nowGameMin), world.tick_speed);

    // Who is tied up in a conversation this tick — see "Participant claims" below.
    // Built from the scheduler's OWN entries, not from every `active` row: a row
    // whose completion crashed stayed `active` forever, and reading busy-ness off
    // the table locked its participants out of every future conversation.
    // Entries Step A completes this tick still count (they're processed after the
    // transaction, and their participants are still `talking` until then).
    const busyAgents = new Set<number>();
    /** Pair key → topic of the live conversation between them. */
    const livePairs = new Map<string, string | null>();
    /** Agent → wall-clock ms by which the conversation holding them must be over. */
    const agentFreeAt = new Map<number, number>();
    const registerLive = (participants: number[], topic: string | null, freeAt: number): void => {
      for (const id of participants) {
        busyAgents.add(id);
        agentFreeAt.set(id, Math.max(agentFreeAt.get(id) ?? 0, freeAt));
      }
      livePairs.set(conversationPairKey(participants), topic);
    };

    for (const entry of activeLLM) {
      const conversation = db
        .select()
        .from(conversations)
        .where(eq(conversations.id, entry.conversationId))
        .get();

      if (!conversation) {
        // Row is gone — nothing downstream will ever evict its cached identities.
        clearConversationCache(entry.conversationId);
        toRemove.add(entry.conversationId);
        continue;
      }

      // Already ended by someone outside this system — `markConversationEnded`
      // (LLM context lost) or `deactivateAgent` (participant died).
      // `processCompletedConversation` bails immediately on `status === 'ended'`,
      // so routing this arm there dequeued the entry and did nothing at all,
      // stranding both agents in `current_action = 'talking'` forever. Release
      // them and drop the caches here instead.
      if (conversation.status === 'ended') {
        if (releaseTalkingParticipants(conversation)) agentsReleased = true;
        clearConversationCache(conversation.id);
        toRemove.add(entry.conversationId);
        changed = true;
        continue;
      }

      const messages = conversation.messages as ConversationMessage[];

      // Entries dispatched before game-time budgets existed carry only the
      // wall-clock stamp: start their budget now rather than guess.
      entry.startedGameMin ??= nowGameMin;
      entry.plannedTurns ??= conversation.max_turns;
      entry.budgetGameMin ??= conversationBudgetGameMinutes(entry.plannedTurns);
      const deadlineGameMin = entry.startedGameMin + entry.budgetGameMin;

      // `truncated` = the CLOCK stopped it before its planned turns. Not set for
      // a needs wrap-up (someone chose to leave) nor when the last planned turn
      // landed in time (nothing was actually cut).
      let completion: { truncated: boolean } | null = null;

      if (!entry.wrapUp && messages.length >= conversation.max_turns) {
        completion = { truncated: false };
      } else {
        if (!entry.wrapUp) {
          // Budget first: it is measured from the deadline itself, so the grace
          // below runs from when the budget ran out, not from whichever tick
          // noticed — the hard stop is always start + budget + grace.
          if (nowGameMin >= deadlineGameMin) {
            entry.wrapUp = { reason: 'budget', sinceGameMin: deadlineGameMin };
          } else {
            const needy = findNeedsInterrupt(conversation.participants as number[], world);
            if (needy) entry.wrapUp = { reason: needy.reason, sinceGameMin: nowGameMin, leaverId: needy.agentId };
          }
          if (entry.wrapUp) {
            // Stop the task runner at the next turn boundary: the turn in flight
            // may still land (at least one line from each side), none after it.
            const target = Math.min(
              conversation.max_turns,
              Math.max(messages.length + 1, CONFIG.CONVERSATIONS.MIN_LLM_TURNS),
            );
            if (target !== conversation.max_turns) {
              db.update(conversations).set({ max_turns: target }).where(eq(conversations.id, conversation.id)).run();
              conversation.max_turns = target;
            }
            changed = true;
          }
        }
        if (entry.wrapUp) {
          const landed = messages.length >= conversation.max_turns;
          if (landed || nowGameMin >= entry.wrapUp.sinceGameMin + graceGameMin) {
            closeWrappedTranscript(
              conversation,
              entry.wrapUp.leaverId ?? nextSpeaker(conversation),
              entry.wrapUp.reason,
              entry.plannedTurns,
            );
            completion = {
              truncated: entry.wrapUp.reason === 'budget' && messages.length < entry.plannedTurns,
            };
          }
        }
      }

      registerLive(
        conversation.participants as number[],
        conversation.topic,
        completion
          ? now
          : wallAt(entry.wrapUp ? entry.wrapUp.sinceGameMin + graceGameMin : deadlineGameMin + graceGameMin),
      );

      if (completion) {
        // Force-ends go through the SAME completion pipeline as natural ends.
        // The previous inline hand-rolled ending skipped quality scoring,
        // relationship events, memories and cache eviction, and emitted
        // `conversation:ended` exactly once — for participants[0], with an empty
        // otherName — so every listener silently dropped participant #2.
        completedConversations.push({ conversation, world, truncated: completion.truncated });
        toRemove.add(entry.conversationId);
        llmTotal++;
        changed = true;
      }
    }

    const updatedActiveLLM = activeLLM.filter(
      (e) => !toRemove.has(e.conversationId),
    );

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
      if (releaseTalkingParticipants(orphan)) agentsReleased = true;
      clearConversationCache(orphan.id);
      changed = true;
    }

    // --- Participant claims ---
    // Nothing downstream stopped one agent from being in two conversations at
    // once: the queue can hold [A,B] and [B,A] (both decided to socialize with
    // each other in the same decisions pass), or [A,B] and [A,C], and Steps C–E
    // turned every entry into a conversation independently — four started in the
    // same millisecond in one playtest. Every path that starts a conversation now
    // claims its participants first; an agent can be claimed once per pass, and
    // never while a live conversation (`busyAgents`, from Step A) still holds them.
    const claimedAgents = new Set<number>();
    /** Pairs a higher-priority LLM entry is waiting on this pass (slots full). */
    const reservedPairs = new Set<string>();
    /**
     * 'duplicate': this exact pair already has a live conversation or one started
     *   this pass — the entry is redundant and should be dropped. Not for a
     *   protected entry with a different topic: a player's "tell her the secret"
     *   while the two are already chatting is a new conversation, to be had once
     *   the current one ends.
     * 'busy': someone is tied up with a different partner — the entry can wait.
     */
    const claimParticipants = (
      entry: QueueRow,
      { peek = false, freeAt = now }: { peek?: boolean; freeAt?: number } = {},
    ): 'ok' | 'duplicate' | 'busy' => {
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
    };
    /**
     * A protected entry (player nudge, comfort visit) that timed out only because
     * a participant is mid-conversation waits for that conversation instead of
     * being dropped. Bounded: the new deadline is when the blocking conversation
     * must be over at the latest, plus a margin — never open-ended. Returns true
     * when the wait was extended and the entry stays queued.
     */
    const extendProtectedWait = (entry: QueueRow): boolean => {
      if (!isProtectedEntry(entry)) return false;
      const blockers = (entry.participants as number[])
        .map((id) => agentFreeAt.get(id))
        .filter((t): t is number => t != null);
      if (blockers.length === 0) return false; // not held by a conversation
      const deadline = Math.max(...blockers) + PROTECTED_WAIT_MARGIN_MS;
      if (deadline <= now) return false;
      db.update(conversationQueue)
        .set({ max_wait: deadline - entry.queued_at })
        .where(eq(conversationQueue.id, entry.id))
        .run();
      return true;
    };

    // --- Steps C–E: work the queue, highest priority first ---
    // One pass over the whole queue (sorted by priority, descending) for every
    // path that can start a conversation: timed-out fallbacks (C), the template
    // tier (D) and LLM slots (E). They used to run as separate passes in that
    // order, so a low-priority timed-out or template chat could claim an agent a
    // higher-priority LLM conversation needed in the same tick.
    const queueEntries = db
      .select()
      .from(conversationQueue)
      .orderBy(desc(conversationQueue.priority))
      .all();

    let currentActive = updatedActiveLLM.length;
    const fillEntries = [...updatedActiveLLM];

    for (const entry of queueEntries) {
      if (now > entry.queued_at + entry.max_wait) {
        // Step C: timed out — delete; async template processing happens outside.
        // A timed-out entry has nowhere left to wait, so if its participants are
        // taken it is simply dropped rather than becoming a parallel template chat
        // — unless it's a protected entry held up by a live conversation (checked
        // first: a nudged pair is often still walking toward each other).
        const peek = claimParticipants(entry, { peek: true });
        if (peek === 'busy' && extendProtectedWait(entry)) continue;
        db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
        queueTimeouts++;
        changed = true;
        if (peek !== 'ok') continue;
        // Liveness/proximity before claiming: a pair that walked apart (or died)
        // can't have the template chat, and must not claim agents on the way out.
        if (!loadTemplatePair(entry.participants as number[])) continue;
        claimParticipants(entry);
        timedOutQueue.push({ entry, world });
        templateTotal++;
        continue;
      }

      if (entry.tier === 'template') {
        // Step D: template tier — processed immediately, no LLM.
        // Busy participants keep the entry queued; it runs once they're free or
        // ages out through Step C. A pair that can't talk is dropped unclaimed.
        if (!loadTemplatePair(entry.participants as number[])) {
          db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
          changed = true;
          continue;
        }
        const claim = claimParticipants(entry);
        if (claim === 'busy') continue;
        // Process as template — no LLM needed for trivial conversations
        db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
        if (claim === 'duplicate') {
          changed = true;
          continue;
        }
        timedOutQueue.push({ entry, world });
        templateTotal++;
        changed = true;
        continue;
      }

      // Step E: fill open LLM slots. `continue`, not `break`, once they're full:
      // lower-priority template entries further down still get their turn — but
      // not for this pair: a same-pair template must not jump the queue just
      // because the slot this entry is waiting for isn't free yet.
      if (currentActive >= schedulerState.max_concurrent_llm) {
        if (claimParticipants(entry, { peek: true }) === 'ok') {
          reservedPairs.add(conversationPairKey(entry.participants as number[]));
        }
        continue;
      }

      // Peek only: the pair claim is taken once the conversation actually opens
      // below. A staging entry reserves just the agents (see there).
      const claim = claimParticipants(entry, { peek: true });
      if (claim === 'duplicate') {
        db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
        changed = true;
        continue;
      }
      if (claim === 'busy') continue;

      // Depressed agents skip conversations — remove from queue.
      // Checked for every participant, not just the initiator: a depressed agent
      // queued as the *target* was still dragged into a full LLM conversation.
      const anyDepressed = entry.participants.some((pid) =>
        getAgentStates(pid).includes('depressed'),
      );
      if (anyDepressed) {
        db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
        continue;
      }

      // Size the conversation to the game time it may take. A turn costs the
      // model's real latency × tick_speed game minutes, so at 4x a 20 s turn is
      // 80 game minutes: the tier's full length would eat the evening. Capped by
      // what the recent turn latency says fits in the budget; unchanged while
      // turns are fast enough (or before any turn has been timed).
      const tierMaxTurns =
        entry.tier === 'llm_deep'
          ? schedulerState.max_turns_deep
          : schedulerState.max_turns_standard;
      const budgetGameMin = conversationBudgetGameMinutes(tierMaxTurns);
      const affordable = affordableTurns(budgetGameMin, averageTurnLatencyMs(), world.tick_speed);
      if (affordable < CONFIG.CONVERSATIONS.MIN_LLM_TURNS && !isProtectedEntry(entry)) {
        // Not even one exchange fits: have it as a template chat now instead of
        // an LLM one the budget would cut before anyone finished a sentence.
        // Player nudges and comfort visits still get the model — the player asked
        // for that conversation; the budget and wrap-up bound them all the same.
        db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
        changed = true;
        if (!loadTemplatePair(entry.participants as number[])) continue;
        claimParticipants(entry);
        timedOutQueue.push({ entry, world });
        templateTotal++;
        continue;
      }
      const maxTurns = Math.min(
        tierMaxTurns,
        Math.max(CONFIG.CONVERSATIONS.MIN_LLM_TURNS, affordable),
      );

      // Verify both participants exist and are co-located
      const firstParticipant = db
        .select()
        .from(agents)
        .where(eq(agents.id, entry.participants[0]))
        .get();
      const secondParticipant = entry.participants[1]
        ? db.select().from(agents).where(eq(agents.id, entry.participants[1])).get()
        : null;

      if (!firstParticipant || !secondParticipant) {
        db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
        continue;
      }

      // Remove queue entry if either participant has died since it was queued
      if (!firstParticipant.is_active || !secondParticipant.is_active) {
        db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
        continue;
      }

      // Skip if agents are not at the same location or too far apart
      const sameLocation = firstParticipant.current_location != null &&
        firstParticipant.current_location === secondParticipant.current_location;
      if (!sameLocation) {
        const dx = firstParticipant.position.x - secondParticipant.position.x;
        const dy = firstParticipant.position.y - secondParticipant.position.y;
        if (dx * dx + dy * dy > 64 * 64) {
          // Too far apart — remove from queue, they'll re-queue when close
          db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
          continue;
        }
      }

      // Physical staging: two agents 60px apart shouldn't teleport into a
      // conversation. Walk the initiator over first and open the conversation on
      // a later tick, once they're adjacent. The queue entry is deliberately NOT
      // deleted — if they never converge it ages out via `max_wait` into the
      // template path, which reads as "they gave up".
      const stageDx = secondParticipant.position.x - firstParticipant.position.x;
      const stageDy = secondParticipant.position.y - firstParticipant.position.y;
      const stageDist = Math.hypot(stageDx, stageDy);
      if (stageDist > TALK_DISTANCE_PX) {
        const moverAction = (firstParticipant.current_action?.type ?? 'idle') as string;
        // Don't yank someone out of sleep, death, or another conversation.
        if (moverAction === 'sleeping' || moverAction === 'dead' || moverAction === 'talking') {
          continue;
        }
        const targetX = secondParticipant.position.x - (stageDx / stageDist) * TALK_STAGE_OFFSET_PX;
        const targetY = secondParticipant.position.y - (stageDy / stageDist) * TALK_STAGE_OFFSET_PX;
        // Re-issuing the order every tick would null `current_path` every tick and
        // freeze them in place, so only write it when the destination has actually
        // drifted (the partner moved) or they aren't walking yet.
        const dest = firstParticipant.current_destination;
        const alreadyHeaded =
          moverAction === 'walking' &&
          dest != null &&
          Math.hypot(dest.x - targetX, dest.y - targetY) <= TALK_STAGE_REISSUE_PX;
        if (!alreadyHeaded) {
          db.update(agents)
            .set({
              current_action: { type: 'walking', reason: 'approaching_conversation' },
              current_destination: { x: targetX, y: targetY },
              current_path: null,
              action_started: gameMinutes(world.time),
              action_duration: null,
            })
            .where(eq(agents.id, firstParticipant.id))
            .run();
          changed = true;
        }
        // Reserve both agents for the rest of this pass: the initiator is walking
        // over to talk, so a lower-priority entry must not grab either of them.
        // The pair key is not claimed, so this entry opens normally next tick.
        for (const id of entry.participants as number[]) claimedAgents.add(id);
        continue;
      }

      const locationId = firstParticipant.current_location;
      if (!locationId) {
        // Can't start a conversation without a location; skip for now
        continue;
      }

      // Over by its budget plus the wrap-up grace at the latest.
      claimParticipants(entry, { freeAt: wallAt(nowGameMin + budgetGameMin + graceGameMin) });

      // Create conversation record
      const result = db
        .insert(conversations)
        .values({
          participants: entry.participants,
          messages: [],
          location: locationId,
          trigger_reason: entry.trigger_reason,
          topic: entry.topic,
          status: 'active',
          started_at: now,
          ended_at: null,
          sentiment: 0,
          max_turns: maxTurns,
        })
        .returning({ id: conversations.id })
        .get();

      const conversationId = result.id;

      // Update both agents' currentAction to "talking"
      for (const participantId of entry.participants) {
        db.update(agents)
          .set({
            current_action: {
              type: 'talking',
              conversationId,
            },
            action_started: gameMinutes(world.time),
            // Game minutes, like every action duration. Informational only:
            // isActionComplete never ends `talking` on a timer, the conversation
            // system does.
            action_duration: maxTurns * 2,
          })
          .where(eq(agents.id, participantId))
          .run();
      }

      // Collect dispatch — actual startConversation() call goes outside transaction.
      // `conversation:started` is emitted there, only once the task runner accepts:
      // emitting here recorded memories and cascades for conversations that were
      // deleted moments later when all runner slots were full.
      dispatches.push({
        conversationId,
        speakerId: entry.participants[0],
        participantIds: entry.participants as number[],
        participantNames: [firstParticipant.name, secondParticipant.name],
      });

      fillEntries.push({
        conversationId,
        startedAt: now,
        startedGameMin: nowGameMin,
        budgetGameMin,
        plannedTurns: maxTurns,
      });
      currentActive++;
      changed = true;

      // Remove from queue
      db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
    }

    // --- Update scheduler state ---
    db.update(conversationSchedulerState)
      .set({
        active_llm_conversations: fillEntries,
        stats: {
          llmConversationsTotal: llmTotal,
          templateConversationsTotal: templateTotal,
          // Was never written (always 0); now the rolling turn latency the
          // scheduler sizes conversations by, so diagnostics can see it.
          averageResponseTimeMs: Math.round(averageTurnLatencyMs() ?? schedulerState.stats.averageResponseTimeMs),
          queueTimeoutsTotal: queueTimeouts,
        },
      })
      .where(eq(conversationSchedulerState.id, schedulerState.id))
      .run();
  });

  // ── Async part: dispatch LLM calls outside transaction ─────────────────────
  for (const d of dispatches) {
    const accepted = taskRunner.startConversation(d.conversationId, d.speakerId);
    if (accepted) {
      simEvents.emit('conversation:started', { agentId: d.participantIds[0], otherName: d.participantNames[1] });
      simEvents.emit('conversation:started', { agentId: d.participantIds[1], otherName: d.participantNames[0] });
    }
    if (!accepted) {
      // Task runner slots full — remove the conversation record and reset agents to idle
      db.delete(conversations).where(eq(conversations.id, d.conversationId)).run();
      for (const pid of d.participantIds) {
        db.update(agents)
          .set({ current_action: { type: 'idle' }, action_duration: null })
          .where(eq(agents.id, pid))
          .run();
      }
    }
  }

  // Process timed-out queue entries with template fallback
  for (const { entry, world } of timedOutQueue) {
    try {
      await processTimedOutEntry(entry, world);
    } catch (err) {
      console.error('[conversations] Error processing timed-out entry:', err);
    }
  }

  // Process completed LLM conversations
  for (const { conversation, world, truncated } of completedConversations) {
    try {
      await processCompletedConversation(conversation, world, truncated);
    } catch (err) {
      console.error('[conversations] Error processing completed conversation:', err);
    }
  }

  if (changed) {
    emitter.markDirty('conversations');
  }
  if (agentsReleased) {
    // Releasing an agent changes no conversation row, so the agent snapshot has to
    // be pushed explicitly or the client keeps rendering them as talking.
    emitter.markDirty('agents.all');
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

async function finishCompletedConversation(
  conversation: ConversationRow,
  world: WorldRow,
  truncated: boolean,
): Promise<void> {
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
    return;
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
    return;
  }

  // Calculate overall sentiment: average of all message sentiments
  // (canned fallback actions are not speech and don't count — sanitizeDialogue.ts)
  let overallSentiment = 0;
  const isFallback = fallbackDetector(fresh.participants as number[]);
  const spoken = messages.filter((m) => !isFallback(m));
  if (spoken.length > 0) {
    const sentimentSum = spoken.reduce((sum, m) => sum + m.sentiment, 0);
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
    return;
  }

  // Accumulate relationship deltas across all pairs for quality evaluation
  let totalFriendshipDelta = 0;
  let totalRomanceDelta = 0;
  let totalTrustDelta = 0;

  // Create relationship events for each pair
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const agentA = participants[i];
      const agentB = participants[j];

      // Enforce A < B ordering for consistency with relationship table.
      // The personalities MUST be swapped alongside the ids: the engine returns
      // `*AB` deltas keyed to `personalityA`, and those are written into
      // `friendship_delta_ab`, which relationships.ts applies to orderedA -> orderedB.
      const aIsFirst = agentA.id < agentB.id;
      const [orderedA, orderedB] = aIsFirst
        ? [agentA.id, agentB.id]
        : [agentB.id, agentA.id];

      // --- Compute relationship deltas via engine ---
      const personalityA = (aIsFirst ? agentA : agentB).personality as PersonalityProfile | null;
      const personalityB = (aIsFirst ? agentB : agentA).personality as PersonalityProfile | null;

      let compat = 1.0;
      if (personalityA && personalityB) {
        compat = calculateCompatibility(personalityA, personalityB);
      }

      const existingRelationship = db.select().from(relationships)
        .where(and(eq(relationships.agent_a, orderedA), eq(relationships.agent_b, orderedB))).get();

      const impactCtx: ConversationImpactContext = {
        overallSentiment,
        turnCount: messages.length,
        topic: fresh.topic,
        personalityA,
        personalityB,
        compatibility: compat,
        existingFriendshipAB: existingRelationship?.friendship_ab ?? 0,
        existingFriendshipBA: existingRelationship?.friendship_ba ?? 0,
        existingRomanceAB: existingRelationship?.romance_ab ?? 0,
        existingRomanceBA: existingRelationship?.romance_ba ?? 0,
        isTemplate: false,
      };

      const deltas = computeRelationshipDeltas(impactCtx);
      const { friendshipAB: friendshipDeltaAB, friendshipBA: friendshipDeltaBA } = deltas;
      const { romanceAB: romanceDeltaAB, romanceBA: romanceDeltaBA } = deltas;
      const { trustAB: trustDeltaAB, trustBA: trustDeltaBA } = deltas;

      totalFriendshipDelta += friendshipDeltaAB + friendshipDeltaBA;
      totalRomanceDelta += romanceDeltaAB + romanceDeltaBA;
      totalTrustDelta += trustDeltaAB + trustDeltaBA;

      // Derive event type from deltas
      let eventType = 'conversation';
      let eventDescription = `Conversation about ${fresh.topic ?? 'various things'}`;
      if (romanceDeltaAB > 2 || romanceDeltaBA > 2) {
        eventType = 'flirting';
        eventDescription = `Flirtatious conversation between them`;
      } else if (overallSentiment < -0.3) {
        eventType = 'conflict';
        eventDescription = `Heated argument about ${fresh.topic ?? 'something'}`;
      } else if (overallSentiment > 0.5 && (trustDeltaAB > 2 || trustDeltaBA > 2)) {
        eventType = 'bonding';
        eventDescription = `Deep bonding conversation about ${fresh.topic ?? 'personal matters'}`;
      } else if (fresh.topic?.includes('gossip')) {
        eventType = 'gossip';
        eventDescription = `Shared gossip about ${fresh.topic.replace('gossip about ', '')}`;
      }

      db.insert(relationshipEvents)
        .values({
          agent_a: orderedA,
          agent_b: orderedB,
          event_type: eventType,
          description: eventDescription,
          friendship_delta_ab: friendshipDeltaAB,
          friendship_delta_ba: friendshipDeltaBA,
          romance_delta_ab: romanceDeltaAB,
          romance_delta_ba: romanceDeltaBA,
          trust_delta_ab: trustDeltaAB,
          trust_delta_ba: trustDeltaBA,
          sentiment: overallSentiment,
          processed: false,
          timestamp: now,
        })
        .run();
    }
  }

  // --- Conversation-triggered interactions ---
  // Very negative conversations can escalate to insults or confrontations
  if (overallSentiment < -0.5 && participants.length >= 2) {
    const aggressorId = participantIds[0];
    const targetId = participantIds[1];
    const aggressorAgent = participants.find(p => p.id === aggressorId);
    const targetAgent = participants.find(p => p.id === targetId);
    const aggressorPersonality = aggressorAgent?.personality as PersonalityProfile | null;

    if (aggressorPersonality) {
      // High aggression + very negative → insult
      if (aggressorPersonality.aggression > 45 && overallSentiment < -0.6 && Math.random() < 0.3) {
        simEvents.emit('interaction:completed', {
          agentId: aggressorId,
          perpetratorId: aggressorId,
          victimId: targetId,
          action: 'insult',
          locationId: aggressorAgent?.current_location,
        });
        logActivity({
          type: 'drama',
          initiator: aggressorId,
          target: targetId,
          templateData: {
            description: `${aggressorAgent?.name} insulted ${targetAgent?.name} during a heated argument`,
          },
        });
      }
      // Low morality + very negative + drunk → confrontation
      if (aggressorPersonality.morality < 40 && overallSentiment < -0.7 &&
          getAgentStates(aggressorId).includes('drunk') && Math.random() < 0.4) {
        simEvents.emit('interaction:completed', {
          agentId: aggressorId,
          perpetratorId: aggressorId,
          victimId: targetId,
          action: 'confrontation',
          locationId: aggressorAgent?.current_location,
        });
        logActivity({
          type: 'drama',
          initiator: aggressorId,
          target: targetId,
          templateData: {
            description: `${aggressorAgent?.name} started a fight with ${targetAgent?.name}`,
          },
        });
      }
    }
  }

  // Flirtatious conversations can trigger romance interactions
  if (overallSentiment > 0.3 && participants.length >= 2) {
    const p1 = participants[0];
    const p2 = participants[1];
    const p1Personality = p1.personality as PersonalityProfile | null;

    if (p1Personality && p1Personality.sensuality > 50 && totalRomanceDelta > 3 && Math.random() < 0.25) {
      simEvents.emit('interaction:completed', {
        agentId: p1.id,
        perpetratorId: p1.id,
        victimId: p2.id,
        action: 'flirt',
        locationId: p1.current_location,
      });
      logActivity({
        type: 'drama',
        initiator: p1.id,
        target: p2.id,
        templateData: {
          description: `${p1.name} flirted with ${p2.name} after their conversation`,
        },
      });
    }
  }

  // --- Proactive Financial Help ---
  if (overallSentiment > 0 && participants.length >= 2) {
    const speaker = participants[0];
    const otherParticipants = participants.slice(1);
    const speakerId = speaker.id;
    const otherId = otherParticipants[0].id;

    const rel = db.select().from(relationships).where(
      and(
        eq(relationships.agent_a, Math.min(speakerId, otherId)),
        eq(relationships.agent_b, Math.max(speakerId, otherId)),
      )
    ).get();
    const friendship = rel ? (speakerId < otherId ? rel.friendship_ab : rel.friendship_ba) : 0;

    if (friendship > 50) {
      const speakerEcon = db.select().from(economy).where(eq(economy.agent_id, speakerId)).get();
      const otherEcon = db.select().from(economy).where(eq(economy.agent_id, otherId)).get();
      if (speakerEcon && otherEcon) {
        let giverId: number | null = null;
        let receiverId: number | null = null;
        let giverMoney = 0;
        if (speakerEcon.money > 60 && otherEcon.money < 15) { giverId = speakerId; receiverId = otherId; giverMoney = speakerEcon.money; }
        else if (otherEcon.money > 60 && speakerEcon.money < 15) { giverId = otherId; receiverId = speakerId; giverMoney = otherEcon.money; }

        if (giverId && receiverId) {
          const giverAgent = giverId === speakerId ? speaker : otherParticipants[0];
          const warmth = (giverAgent?.personality as any)?.warmth ?? 50;
          if (warmth > 55) {
            const gift = Math.min(10, Math.round(giverMoney * 0.1));
            if (gift >= 2) {
              db.update(economy).set({ money: giverMoney - gift }).where(eq(economy.agent_id, giverId)).run();
              const recvEcon = db.select().from(economy).where(eq(economy.agent_id, receiverId)).get();
              if (recvEcon) db.update(economy).set({ money: recvEcon.money + gift }).where(eq(economy.agent_id, receiverId)).run();
            }
          }
        }
      }
    }
  }

  // --- Fact Creation ---

  // Drunk incident: drunk participant in a negative conversation
  for (const participantId of participantIds) {
    const states = getAgentStates(participantId);
    if (states.includes('drunk') && overallSentiment < -0.3) {
      const otherId = participantIds.find(p => p !== participantId);
      if (otherId) {
        createFact('drunk_incident', participantId, otherId, 3, [...participantIds], 'witnessed');
      }
    }
  }

  // Secret told: heartbroken/lonely participant confides to a close friend
  for (const participantId of participantIds) {
    const states = getAgentStates(participantId);
    if (states.includes('heartbroken') || states.includes('lonely')) {
      const otherId = participantIds.find(p => p !== participantId);
      if (otherId) {
        const rel = db.select().from(relationships)
          .where(and(
            eq(relationships.agent_a, Math.min(participantId, otherId)),
            eq(relationships.agent_b, Math.max(participantId, otherId))
          )).get();
        const friendship = rel ? (participantId < otherId ? rel.friendship_ab : rel.friendship_ba) : 0;
        if (friendship > 60) {
          // The secret is what they actually said. Conversations carry no
          // structured summary, so take the latest line with real speech in it:
          // stage directions stripped, whole sentences only. A fixed 80-char
          // cut used to turn "(My heart gives a little skip, and I feel a
          // warmth bloom…" into a sensitivity-3 secret the town then passed
          // around. No quotable line means nothing was confided — no fact.
          const quote = messages
            .filter(m => m.speakerId === participantId)
            .reverse()
            .map(m => extractConfidedQuote(m.text))
            .find((q): q is string => q != null);
          if (quote) {
            createFact('secret_told', participantId, otherId, 3, [participantId, otherId], 'confided', {
              quote,
            });
          }
        }
      }
    }
  }

  // Reputation: negative conversation + agent has 3+ recent negative conversations
  if (overallSentiment < -0.2) {
    // Filter in SQL: this used to load every ended conversation ever, messages
    // included, each time a negative one finished.
    const recentNegative = db.select({ participants: conversations.participants })
      .from(conversations)
      .where(and(
        eq(conversations.status, 'ended'),
        lt(conversations.sentiment, -0.2),
        gt(conversations.ended_at, Date.now() - 1440000),
      ))
      .all();

    for (const pid of participantIds) {
      const recentConvos = recentNegative.filter(c => (c.participants as number[]).includes(pid));
      if (recentConvos.length >= 3) {
        createFact('reputation', pid, null, 1, [], 'observed');
      }
    }
  }

  const time = world.time as {
    day: number;
    hour: number;
    minute: number;
    totalTicks: number;
  };

  // For each participant: create memory, queue embedding, update needs
  for (const participant of participants) {
    const otherParticipants = participants.filter(
      (p) => p.id !== participant.id,
    );
    const otherNames = otherParticipants.map((p) => p.name);

    // Gather partner state and romance level for cascade rules
    const otherIds = otherParticipants.map((p) => p.id);
    const partnerStates = otherIds.flatMap((oid) => getAgentStates(oid));
    const partnerState = partnerStates.find((s) =>
      ['lonely', 'heartbroken', 'depressed', 'stressed', 'grieving', 'in_debt'].includes(s),
    ) ?? null;
    const relForRomance = otherIds.length === 1
      ? db.select().from(relationships).where(
          and(eq(relationships.agent_a, Math.min(participant.id, otherIds[0])),
              eq(relationships.agent_b, Math.max(participant.id, otherIds[0]))),
        ).get() ?? null
      : null;
    const romanceLevel = relForRomance
      ? (relForRomance.agent_a === participant.id ? relForRomance.romance_ab : relForRomance.romance_ba)
      : 0;
    // Check for recent conflict between this pair
    const hadRecentConflict = otherIds.length === 1 && db.select().from(relationshipEvents)
      .where(eq(relationshipEvents.processed, false)).all()
      .some((re) => {
        const reParticipants = [re.agent_a, re.agent_b];
        return reParticipants.includes(participant.id) && reParticipants.includes(otherIds[0]) &&
               (re.sentiment ?? 0) < -0.3;
      });

    simEvents.emit('conversation:ended', {
      agentId: participant.id,
      perpetratorId: otherIds[0] ?? null,
      otherName: otherNames.join(' and '),
      summary: fresh.topic ?? '',
      turns: messages.length,
      sentiment: overallSentiment ?? 0,
      topics: extractTopics(messages.map((m: ConversationMessage) => ({ text: m.text }))),
      partnerState,
      romanceLevel,
      hadRecentConflict,
      // Lets the memory stream record "we got cut off" instead of "we wrapped up
      // our conversation" for an exchange the turn budget amputated mid-flow.
      truncated: cutShort,
      // The memory quotes the transcript's most loaded line instead of only
      // naming the topic (see lib/memory/conversationGist.ts).
      messages,
    });

    // Update needs: social boost + mood modifier
    const agentNeeds = db
      .select()
      .from(needs)
      .where(eq(needs.agent_id, participant.id))
      .get();

    if (agentNeeds) {
      const personality = participant.personality as PersonalityProfile | null;

      let socialBoost = clamp(8 + overallSentiment * 7, 1, 15);
      if (personality && personality.warmth > 60 && overallSentiment > 0) {
        socialBoost *= 1.3;
      }
      const newSocial = clamp(agentNeeds.social + socialBoost, 0, 100);

      // Fun boost from enjoyable conversations
      let funBoost = 0;
      if (overallSentiment > 0.3) {
        funBoost = clamp(overallSentiment * 4, 0, 8); // good convos are fun
      } else if (overallSentiment < -0.3) {
        funBoost = clamp(overallSentiment * 2, -4, 0); // arguments drain fun
      }
      const newFun = clamp(agentNeeds.fun + funBoost, 0, 100);

      const currentTime = gameMinutes(time);
      let moodModifierDuration: number = CONFIG.NEEDS.MOOD_MODIFIER_DURATION_GAME_MINUTES;
      if (personality && personality.neuroticism > 60) {
        moodModifierDuration = Math.round(moodModifierDuration * 1.5);
      }
      const moodModifiers = [
        ...agentNeeds.mood_modifiers,
        {
          source: 'conversation',
          value: overallSentiment * 5,
          expiresAt: currentTime + moodModifierDuration,
        },
      ];

      db.update(needs)
        .set({
          social: newSocial,
          fun: newFun,
          mood_modifiers: moodModifiers,
        })
        .where(eq(needs.id, agentNeeds.id))
        .run();
    }
  }

  // Spread gossip: for each participant, share known shared_knowledge if the subject
  // was mentioned. Only the speaker's OWN lines count — matching against the whole
  // transcript leaked a secret whenever the *listener* happened to say the subject's name.
  for (const pid of participantIds) {
    const otherId = participantIds.find((p) => p !== pid);
    if (!otherId) continue;
    const agent = db.select().from(agents).where(eq(agents.id, pid)).get();
    if (!agent?.personality) continue;
    const personalityData = agent.personality as any;
    const sharable = getShareableFacts(pid, otherId, personalityData);
    const spokenTexts = messages.filter((m) => m.speakerId === pid).map((m) => m.text);
    if (spokenTexts.length === 0) continue;
    spreadGossip(pid, otherId, spokenTexts, sharable);
  }

  // --- Dark Social Dynamics: Post-Conversation Effects ---

  // Begging outcome: in_debt agent asking friends for help
  for (const pid of participantIds) {
    const pidStates = getAgentStates(pid);
    if (!pidStates.includes('in_debt')) continue;

    const otherId = participantIds.find(p => p !== pid);
    if (!otherId) continue;
    const otherAgent = participants.find(p => p.id === otherId);
    const otherPersonality = otherAgent?.personality as PersonalityProfile | null;
    if (!otherPersonality) continue;

    // Check friendship
    const rel = db.select().from(relationships).where(
      and(
        eq(relationships.agent_a, Math.min(pid, otherId)),
        eq(relationships.agent_b, Math.max(pid, otherId)),
      )
    ).get();
    const friendship = rel ? (pid < otherId ? rel.friendship_ab : rel.friendship_ba) : 0;
    if (friendship <= 30) continue;

    if (otherPersonality.warmth > 60 && overallSentiment > 0) {
      // Warm friend helps
      const amount = 10 + Math.floor(Math.random() * 11);
      const giverEcon = db.select().from(economy).where(eq(economy.agent_id, otherId)).get();
      const receiverEcon = db.select().from(economy).where(eq(economy.agent_id, pid)).get();
      if (giverEcon && receiverEcon && giverEcon.money >= amount) {
        db.update(economy).set({ money: giverEcon.money - amount }).where(eq(economy.agent_id, otherId)).run();
        db.update(economy).set({ money: receiverEcon.money + amount }).where(eq(economy.agent_id, pid)).run();

        const [ordA, ordB] = [Math.min(pid, otherId), Math.max(pid, otherId)];
        db.insert(relationshipEvents).values({
          agent_a: ordA, agent_b: ordB,
          event_type: 'begging',
          description: `${otherAgent?.name} helped ${participants.find(p => p.id === pid)?.name} with money`,
          friendship_delta_ab: pid === ordA ? 5 : 3,
          friendship_delta_ba: pid === ordA ? 3 : 5,
          romance_delta_ab: 0, romance_delta_ba: 0,
          trust_delta_ab: 3, trust_delta_ba: 3,
          sentiment: 0.5, processed: false, timestamp: now,
        }).run();
      }
    } else if (otherPersonality.warmth < 40) {
      // Refused — update begging fail count in state metadata
      const debtState = db.select().from(agentStates)
        .where(and(eq(agentStates.agent_id, pid), eq(agentStates.type, 'in_debt'))).get();
      if (debtState) {
        const meta = { ...((debtState.metadata as any) ?? {}) };
        meta.beggingFailCount = ((meta.beggingFailCount as number) ?? 0) + 1;
        if (meta.beggingFailCount >= 3) meta.desperationUnlocked = true;
        db.update(agentStates).set({ metadata: meta }).where(eq(agentStates.id, debtState.id)).run();
      }
    }
  }

  // Confession outcome: honest agent with hidden sins confides in trusted friend
  for (const pid of participantIds) {
    const pidAgent = participants.find(p => p.id === pid);
    const pidPersonality = pidAgent?.personality as PersonalityProfile | null;
    if (!pidPersonality || pidPersonality.honesty <= 50) continue;
    if (getHiddenSinCount(pid) < 2) continue;

    const otherId = participantIds.find(p => p !== pid);
    if (!otherId) continue;

    // Check trust
    const rel = db.select().from(relationships).where(
      and(
        eq(relationships.agent_a, Math.min(pid, otherId)),
        eq(relationships.agent_b, Math.max(pid, otherId)),
      )
    ).get();
    if (!rel) continue;
    const trust = pid < otherId ? rel.trust_ab : rel.trust_ba;
    if (trust <= 50) continue;

    // Find a hidden sin to reveal
    const hiddenSin = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.subject_id, pid), eq(shared_knowledge.is_active, true))).all()
      .find(f => ['theft', 'affair', 'blackmail'].includes(f.type) && (f.known_by as number[]).length <= 2);
    if (!hiddenSin) continue;

    // Share the sin with the friend
    const knownBy = [...new Set([...(hiddenSin.known_by as number[]), otherId])];
    db.update(shared_knowledge).set({ known_by: knownBy }).where(eq(shared_knowledge.id, hiddenSin.id)).run();
    createFact('confession', pid, otherId, 2, [pid, otherId], 'confided', {
      relatedFact: hiddenSin.content,
    });

    // Friend reaction based on personality
    const otherPersonality = participants.find(p => p.id === otherId)?.personality as PersonalityProfile | null;
    let friendshipDelta = 0;
    let trustDelta = 5;
    if (otherPersonality) {
      if (otherPersonality.morality > 60) {
        friendshipDelta = -5;
        trustDelta = 8;
      } else if (otherPersonality.warmth > 60) {
        friendshipDelta = 2;
      }
    }

    const [ordA, ordB] = [Math.min(pid, otherId), Math.max(pid, otherId)];
    db.insert(relationshipEvents).values({
      agent_a: ordA, agent_b: ordB,
      event_type: 'confession',
      description: `${pidAgent?.name} confessed a secret to ${participants.find(p => p.id === otherId)?.name}`,
      friendship_delta_ab: friendshipDelta,
      friendship_delta_ba: friendshipDelta,
      romance_delta_ab: 0, romance_delta_ba: 0,
      trust_delta_ab: pid === ordA ? trustDelta : 0,
      trust_delta_ba: pid === ordA ? 0 : trustDelta,
      sentiment: 0.3, processed: false, timestamp: now,
    }).run();

    // Confessor mood boost + stress reduction
    const confessorNeeds = db.select().from(needs).where(eq(needs.agent_id, pid)).get();
    if (confessorNeeds) {
      db.update(needs).set({
        mood: Math.min(100, confessorNeeds.mood + 15),
        stress: Math.max(0, confessorNeeds.stress - 10),
      }).where(eq(needs.agent_id, pid)).run();
    }

    logActivity({
      type: 'drama',
      initiator: pid,
      target: otherId,
      templateData: { description: `${pidAgent?.name} confessed a secret to ${participants.find(p => p.id === otherId)?.name}.` },
    });
  }

  // Reconciliation outcome: loyal agent forgives transgressor who has cleaned up
  if (overallSentiment > 0.2) {
    for (const pid of participantIds) {
      const pidPersonality = participants.find(p => p.id === pid)?.personality as PersonalityProfile | null;
      if (!pidPersonality || pidPersonality.loyalty <= 60) continue;

      const otherId = participantIds.find(p => p !== pid);
      if (!otherId) continue;

      const rel = db.select().from(relationships).where(
        and(
          eq(relationships.agent_a, Math.min(pid, otherId)),
          eq(relationships.agent_b, Math.max(pid, otherId)),
        )
      ).get();
      if (!rel) continue;

      const tags = rel.tags as string[];
      if (!tags.includes('grudge')) continue;

      const friendship = pid < otherId ? rel.friendship_ab : rel.friendship_ba;
      if (friendship < 30 || friendship > 50) continue;

      if (getNegativeFactCount(otherId) >= 3) continue;

      // Remove grudge, boost friendship
      const newTags = tags.filter(t => t !== 'grudge');
      db.update(relationships).set({ tags: newTags }).where(eq(relationships.id, rel.id)).run();

      db.insert(relationshipEvents).values({
        agent_a: rel.agent_a, agent_b: rel.agent_b,
        event_type: 'reconciliation',
        description: `${participants.find(p => p.id === pid)?.name} and ${participants.find(p => p.id === otherId)?.name} reconciled`,
        friendship_delta_ab: 15, friendship_delta_ba: 15,
        romance_delta_ab: 0, romance_delta_ba: 0,
        trust_delta_ab: 5, trust_delta_ba: 5,
        sentiment: 0.7, processed: false, timestamp: now,
      }).run();

      logActivity({
        type: 'drama',
        initiator: pid,
        target: otherId,
        templateData: { description: `${participants.find(p => p.id === pid)?.name} and ${participants.find(p => p.id === otherId)?.name} have reconciled.` },
      });
    }
  }

  // Alcoholism recovery: positive convo with warm friend while sober
  for (const pid of participantIds) {
    const pidStates = getAgentStates(pid);
    if (!pidStates.includes('alcoholic')) continue;
    if (pidStates.includes('drunk') || pidStates.includes('hungover')) continue;
    if (overallSentiment <= 0.3) continue;

    const otherId = participantIds.find(p => p !== pid);
    if (!otherId) continue;

    const otherPersonality2 = participants.find(p => p.id === otherId)?.personality as PersonalityProfile | null;
    if (!otherPersonality2 || otherPersonality2.warmth <= 60) continue;

    const rel = db.select().from(relationships).where(
      and(
        eq(relationships.agent_a, Math.min(pid, otherId)),
        eq(relationships.agent_b, Math.max(pid, otherId)),
      )
    ).get();
    if (!rel) continue;
    const friendship = pid < otherId ? rel.friendship_ab : rel.friendship_ba;
    if (friendship <= 40) continue;

    const alcState = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, pid), eq(agentStates.type, 'alcoholic'))).get();
    if (alcState) {
      const meta = { ...((alcState.metadata as any) ?? {}), recoveryTriggered: true };
      db.update(agentStates).set({ metadata: meta }).where(eq(agentStates.id, alcState.id)).run();
    }
  }

  // Affair discovery: partner learns about affair through gossip
  for (const pid of participantIds) {
    const otherId = participantIds.find(p => p !== pid);
    if (!otherId) continue;

    // Check if pid has a partner relationship with otherId
    const partnerRel = db.select().from(relationships).where(
      and(
        eq(relationships.agent_a, Math.min(pid, otherId)),
        eq(relationships.agent_b, Math.max(pid, otherId)),
      )
    ).get();
    if (!partnerRel || partnerRel.status !== 'partners') continue;

    // Check if pid knows about an affair involving their partner (otherId)
    const affairFacts = db.select().from(shared_knowledge)
      .where(and(eq(shared_knowledge.type, 'affair'), eq(shared_knowledge.subject_id, otherId), eq(shared_knowledge.is_active, true))).all()
      .filter(f => (f.known_by as number[]).includes(pid));
    if (affairFacts.length === 0) continue;

    const pidPersonality = participants.find(p => p.id === pid)?.personality as PersonalityProfile | null;
    if (!pidPersonality) continue;

    // Partner reaction based on personality
    if (pidPersonality.aggression > 60) {
      // Aggressive breakup: partnership → rivals, grudge
      db.update(relationships).set({
        status: 'rivals',
        romance_ab: 0, romance_ba: 0,
        tags: [...(partnerRel.tags as string[]).filter(t => t !== 'partner'), 'grudge'],
      }).where(eq(relationships.id, partnerRel.id)).run();

      // Heartbroken + angry
      if (!getAgentStates(pid).includes('heartbroken')) {
        db.insert(agentStates).values({
          agent_id: pid, type: 'heartbroken', severity: 0.8,
          started_at: gameMinutes(time), duration: Math.floor(2880 + Math.random() * 4320),
          target_agent_id: otherId, source: 'event:affair_discovery', metadata: null,
        }).run();
      }
      if (!getAgentStates(pid).includes('angry')) {
        db.insert(agentStates).values({
          agent_id: pid, type: 'angry', severity: 0.9,
          started_at: gameMinutes(time), duration: Math.floor(480 + Math.random() * 720),
          target_agent_id: otherId, source: 'event:affair_discovery', metadata: null,
        }).run();
      }

      logActivity({
        type: 'drama',
        initiator: pid,
        target: otherId,
        templateData: { description: `${participants.find(p => p.id === pid)?.name} discovered ${participants.find(p => p.id === otherId)?.name}'s affair and broke up!` },
      });
    } else if (pidPersonality.loyalty > 60) {
      // Forgiveness path: trust drop but keep partnership
      const trustField = pid < otherId ? 'trust_ab' : 'trust_ba';
      const currentTrust = pid < otherId ? partnerRel.trust_ab : partnerRel.trust_ba;
      db.update(relationships).set({
        [trustField]: Math.max(0, currentTrust - 30),
      }).where(eq(relationships.id, partnerRel.id)).run();
    } else {
      // Default: quiet breakup
      db.update(relationships).set({ status: 'acquaintances', romance_ab: 0, romance_ba: 0 })
        .where(eq(relationships.id, partnerRel.id)).run();
    }
  }

  // Blackmail report: if victim talks to constable with positive sentiment, share blackmail knowledge
  if (overallSentiment > 0 && participants.length >= 2) {
    const speaker = participants[0];
    const speakerId = speaker.id;
    const otherParticipants = participants.slice(1);
    const otherId = otherParticipants[0]?.id;

    if (otherId != null) {
      const speakerJobRow = db.select({ job: economy.job }).from(economy).where(eq(economy.agent_id, speakerId)).get();
      const otherJobRow = db.select({ job: economy.job }).from(economy).where(eq(economy.agent_id, otherId)).get();
      const speakerJob = speakerJobRow?.job ?? '';
      const otherJob = otherJobRow?.job ?? '';

      const constableId = speakerJob === 'constable' ? speakerId : otherJob === 'constable' ? otherId : null;
      const nonConstableId = constableId === speakerId ? otherId : speakerId;

      if (constableId !== null) {
        // Check if non-constable is a blackmail victim
        const blackmailFacts = db.select().from(shared_knowledge)
          .where(and(
            eq(shared_knowledge.type, 'blackmail'),
            eq(shared_knowledge.is_active, true),
            eq(shared_knowledge.target_id, nonConstableId),
          )).all();

        for (const fact of blackmailFacts) {
          const knownBy = fact.known_by as number[];
          if (!knownBy.includes(constableId)) {
            // Constable learns about blackmail
            const updatedKnownBy = [...knownBy, constableId];
            db.update(shared_knowledge).set({ known_by: updatedKnownBy }).where(eq(shared_knowledge.id, fact.id)).run();
            const victimName = db.select({ name: agents.name }).from(agents).where(eq(agents.id, nonConstableId)).get()?.name ?? `Agent#${nonConstableId}`;
            logActivity({ type: 'drama', initiator: nonConstableId, templateData: { description: `${victimName} reported blackmail to the constable.` } });
          }
        }
      }
    }
  }

  // --- Conversation Quality Evaluation ---
  const evaluation = evaluateConversation({
    messages: messages.map(m => ({ text: m.text || '', sentiment: m.sentiment || 0, fallback: isFallback(m) })),
    injectedMemories: [], // Memories are in the LLM prompt, not stored on conversation record; evaluator redistributes this weight
    topic: (fresh.topic as string) || null,
    maxTurns: fresh.max_turns || 6,
    relationshipDeltas: {
      friendship: totalFriendshipDelta,
      romance: totalRomanceDelta,
      trust: totalTrustDelta,
    },
    truncated: cutShort,
  });

  // Mark conversation as ended
  db.update(conversations)
    .set({
      status: 'ended',
      ended_at: now,
      sentiment: overallSentiment,
      quality_score: evaluation.quality_score,
      quality_breakdown: evaluation.quality_breakdown,
    })
    .where(eq(conversations.id, fresh.id))
    .run();

  // Reset participants back to idle — only if still talking THIS conversation
  for (const participantId of participantIds) {
    const agent = db.select().from(agents).where(eq(agents.id, participantId)).get();
    if (agent) {
      const action = agent.current_action as any;
      // Only reset if agent is still talking in THIS conversation
      if (action?.type === 'talking' && String(action?.conversationId) === String(fresh.id)) {
        db.update(agents)
          .set({ current_action: { type: 'idle' }, action_duration: null })
          .where(eq(agents.id, participantId))
          .run();
      }
    }
  }

  emitter.markDirty('agents.all');

  // Log activity. `location` is the registry template's `{location}` slot; it
  // used to be fed the topic, so the feed read "finished talking at flirting".
  // The topic rides along under its own key.
  const locationName = fresh.location != null
    ? db.select({ name: locations.name }).from(locations).where(eq(locations.id, fresh.location)).get()?.name
    : undefined;
  logActivity({
    type: 'conversation_ended',
    agents: participants.map((p) => p.id),
    location: fresh.location ?? undefined,
    templateData: {
      agent1: participants[0]?.name ?? '',
      agent2: participants[1]?.name ?? '',
      location: locationName ?? '',
      topic: fresh.topic ?? '',
    },
  });
}

// ---------------------------------------------------------------------------
// Process a timed-out queue entry with template fallback
// ---------------------------------------------------------------------------

/** A generic answer matching the opener's tone; see TEMPLATE_REPLY_FALLBACKS. */
function fallbackReply(openerSentiment: number, openerName: string): { text: string; sentiment: number } {
  const tone = openerSentiment <= -0.2 ? 'cold' : openerSentiment >= 0.3 ? 'warm' : 'neutral';
  const pool = TEMPLATE_REPLY_FALLBACKS[tone];
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return { text: interpolateTemplate(picked.text, { 'other.name': openerName }), sentiment: picked.sentiment };
}

function categoryToTopic(category: string): string | null {
  const map: Record<string, string> = {
    greeting_friendly: 'friendly greeting',
    greeting_neutral: 'casual greeting',
    greeting_cold: 'cold exchange',
    tense_encounter: 'tense encounter',
    passive_aggressive: 'passive-aggressive exchange',
    snide_remark: 'snide remark',
    tavern_social: 'tavern socializing',
    complaint_mood: 'venting frustration',
    hungry: 'food',
    tired: 'being tired',
    excited_event: 'exciting news',
    purchase: 'shopping',
    work_handoff: 'work handoff',
    small_talk_weather: 'weather',
    small_talk_work: 'work',
    farewell: 'farewell',
  };
  return map[category] ?? null;
}

/**
 * The two agents of a template conversation, or null when they can't have one:
 * missing or deactivated (a dead agent's row stays, and used to still produce a
 * template chat with real relationship and needs effects), too far apart (a
 * queue entry may have waited out `max_wait` while the pair walked off), or with
 * no location to hold it in. Same liveness/proximity contract as the LLM path.
 * Checked in the tick before claiming agents, and again when processing.
 */
function loadTemplatePair(participants: number[]): [AgentRow, AgentRow] | null {
  if (participants.length < 2) return null;
  const first = db.select().from(agents).where(eq(agents.id, participants[0])).get();
  const second = db.select().from(agents).where(eq(agents.id, participants[1])).get();
  if (!first?.is_active || !second?.is_active) return null;
  const sameLocation = first.current_location != null && first.current_location === second.current_location;
  if (!sameLocation) {
    const dx = first.position.x - second.position.x;
    const dy = first.position.y - second.position.y;
    if (dx * dx + dy * dy > 64 * 64) return null;
  }
  if (!first.current_location) return null;
  return [first, second];
}

async function processTimedOutEntry(
  entry: QueueRow,
  world: WorldRow,
): Promise<void> {
  const now = Date.now();

  const agentList = loadTemplatePair(entry.participants as number[]);
  if (!agentList) return;
  const locationId = agentList[0].current_location!;

  // Get relationship for template conditions
  const [orderedA, orderedB] =
    entry.participants[0] < entry.participants[1]
      ? [entry.participants[0], entry.participants[1]]
      : [entry.participants[1], entry.participants[0]];

  const relationship = db
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.agent_a, orderedA),
        eq(relationships.agent_b, orderedB),
      ),
    )
    .get();

  // Each speaker's lines are chosen from THEIR OWN state: their feelings toward
  // the other (friendship is directional) and their own needs. Both used to use
  // the pair's average friendship and the opener's mood, so a miserable listener
  // replied with the opener's cheer, and one-sided feelings averaged away.
  const speakerState = agentList.map((agent) => {
    const isA = agent.id === orderedA;
    const n = db.select().from(needs).where(eq(needs.agent_id, agent.id)).get();
    return {
      friendship: relationship ? (isA ? relationship.friendship_ab : relationship.friendship_ba) : 0,
      mood: n?.mood ?? 50,
      hunger: n?.hunger ?? 50,
      energy: n?.energy ?? 50,
    };
  });
  const { friendship, mood } = speakerState[0];
  const dayPhase = world.day_phase;

  // Build a prioritized list of categories to try (for the opener, speaker 0)
  const categoriesToTry: string[] = [];

  // Negative/conflict categories (highest priority — drama first).
  // Require an actually negative relationship: neutral strangers (friendship ~0)
  // should get neutral small talk, not hostility — otherwise every new pair
  // meeting at low mood reads as "passive-aggressive exchange" in the feed.
  if (friendship < -10) categoriesToTry.push('tense_encounter');
  if (friendship < -10 && mood < 40) categoriesToTry.push('passive_aggressive');
  if (friendship < -20 && mood < 50) categoriesToTry.push('snide_remark');

  // Contextual categories (interesting situations)
  if (mood < 30) categoriesToTry.push('complaint_mood');
  if (speakerState[0].hunger < 35) categoriesToTry.push('hungry');
  if (speakerState[0].energy < 35) categoriesToTry.push('tired');
  if (mood > 70 && friendship > 30) categoriesToTry.push('excited_event');

  // Location-specific
  const loc0 = db.select({ type: locations.type }).from(locations).where(eq(locations.id, locationId)).get();
  if (loc0?.type === 'tavern') categoriesToTry.push('tavern_social');
  if (loc0?.type === 'shop') categoriesToTry.push('purchase');
  if (['farm', 'shop', 'clinic', 'bakery', 'workshop'].includes(loc0?.type ?? '')) categoriesToTry.push('work_handoff');

  // Weather small talk
  categoriesToTry.push('small_talk_weather');
  categoriesToTry.push('small_talk_work');

  // Greeting as fallback
  categoriesToTry.push(greetingCategory(friendship));

  // Get location name for template interpolation
  const templateLocation = db.select({ name: locations.name }).from(locations).where(eq(locations.id, locationId)).get();
  // Lines like "Perfect weather for being outdoors" or "I can barely see the
  // hills through this fog" were said inside a house; templates now declare the
  // setting they need.
  const setting: 'indoor' | 'outdoor' | null =
    loc0?.type != null ? (OUTDOOR_TYPES.has(loc0.type) ? 'outdoor' : 'indoor') : null;

  // Real townsfolk for `{baker.name}`-style placeholders (see ROLE_PLACEHOLDERS):
  // only active agents in that job who aren't part of this conversation. A role
  // nobody fills leaves its placeholder unset, which makes selectTemplate skip
  // the variants that use it.
  const roleVars: Record<string, string> = {};
  for (const [placeholder, job] of Object.entries(ROLE_PLACEHOLDERS)) {
    const holders = db
      .select({ name: agents.name, id: agents.id })
      .from(economy)
      .innerJoin(agents, eq(agents.id, economy.agent_id))
      .where(and(eq(economy.job, job), eq(agents.is_active, true)))
      .all()
      .filter((h) => !entry.participants.includes(h.id));
    if (holders.length > 0) roleVars[placeholder] = holders[Math.floor(Math.random() * holders.length)].name;
  }
  const tavern = db.select({ name: locations.name }).from(locations).where(eq(locations.type, 'tavern')).get();
  if (tavern) roleVars['tavern.name'] = tavern.name;

  /**
   * Picks the first category that yields a template and renders it for the
   * given speaker. `selectTemplate` records usage, and its cooldown is keyed on
   * (pair, category), so a category consumed by an earlier turn is unavailable
   * to the later ones — the turns can't echo each other.
   */
  const buildLine = (
    categories: string[],
    speakerIdx: 0 | 1,
    ignoreLocation = false,
  ): { text: string; sentiment: number; category: string } | null => {
    const speaker = agentList[speakerIdx];
    const other = agentList[speakerIdx === 0 ? 1 : 0];
    const vars: Record<string, string> = {
      ...roleVars,
      'speaker.name': speaker.name,
      'other.name': other.name,
      'listener.name': other.name,
      'location.name': templateLocation?.name ?? 'town',
      'weather': (world.weather as string) ?? 'weather',
    };
    for (const category of categories) {
      const picked = selectTemplate(
        category,
        entry.participants[0],
        entry.participants[1],
        {
          friendship: speakerState[speakerIdx].friendship,
          mood: speakerState[speakerIdx].mood,
          timeOfDay: dayPhase,
          locationType: ignoreLocation ? null : (loc0?.type ?? null),
          weather: world.weather as string,
          setting,
          // `{location.name}` is the conversation's location; "you have to come
          // to Home 4" is only sayable to a listener who isn't already there.
          listenerElsewhere: other.current_location !== locationId,
        },
        vars,
      );
      if (!picked) continue;
      return {
        category,
        sentiment: picked.sentiment,
        text: interpolateTemplate(picked.text, vars),
      };
    }
    return null;
  };

  const opener =
    buildLine(categoriesToTry, 0) ?? buildLine([greetingCategory(friendship)], 0, true);

  const matchedCategory = opener?.category ?? '';

  // A single line reads as talking AT someone. Give the partner a reply and,
  // when one lands, let the opener sign off — still zero LLM cost.
  // No speaker name in the text: the UI already labels every message with its
  // speaker, so "Priya nodded at Omar." rendered as "Priya: Priya nodded at Omar."
  const turns: Array<{ text: string; sentiment: number }> = [
    opener ?? { text: `*nods at ${agentList[1].name}*`, sentiment: 0 },
  ];

  // The reply comes from the replier's own state too: a sour opener OR a
  // replier who dislikes the opener (friendship < -20, the cold greeting band)
  // answers coldly — a warm "hello!" to someone who can't stand you doesn't get
  // small talk back. Otherwise the replier's own mood and needs come first.
  const replier = speakerState[1];
  const replyCategories =
    turns[0].sentiment <= -0.2 || replier.friendship < -20
      ? ['snide_remark', 'passive_aggressive', 'tense_encounter', 'greeting_cold']
      : [
          ...(replier.mood < 30 ? ['complaint_mood'] : []),
          ...(replier.hunger < 35 ? ['hungry'] : []),
          ...(replier.energy < 35 ? ['tired'] : []),
          'small_talk_weather',
          'small_talk_work',
          'excited_event',
          greetingCategory(replier.friendship),
        ];
  // When every reply category is on its per-pair cooldown (pairs that keep
  // bumping into each other exhaust them fast) the exchange used to stop at the
  // opener. Fall back to a stock acknowledgement so both people always speak.
  const reply = buildLine(replyCategories, 1) ?? fallbackReply(turns[0].sentiment, agentList[0].name);
  turns.push(reply);

  const signOff = buildLine(['farewell'], 0);
  if (signOff) turns.push(signOff);

  const messageSentiment = turns.reduce((sum, t) => sum + t.sentiment, 0) / turns.length;

  // Create a completed conversation with the template messages
  const conversationDoc = {
    participants: entry.participants,
    messages: turns.map((turn, i) => ({
      speakerId: entry.participants[i % 2],
      text: turn.text,
      sentiment: turn.sentiment,
      topics: extractTopics([{ text: turn.text }]),
      timestamp: now,
    })),
    location: locationId,
    trigger_reason: entry.trigger_reason + ' (template)',
    topic: categoryToTopic(matchedCategory) ?? entry.topic,
    status: 'ended' as const,
    started_at: now,
    ended_at: now,
    sentiment: messageSentiment,
    max_turns: turns.length,
  };

  db.insert(conversations)
    .values(conversationDoc)
    .returning({ id: conversations.id })
    .get();

  // Lighter relationship event for template conversations.
  // Personalities follow orderedA/orderedB, not agentList order — the engine keys its
  // `*AB` deltas to personalityA and those are stored as `*_delta_ab`.
  const agentA = agentList.find((a) => a.id === orderedA) ?? agentList[0];
  const agentB = agentList.find((a) => a.id === orderedB) ?? agentList[1];
  const personalityA = agentA.personality as PersonalityProfile | null;
  const personalityB = agentB.personality as PersonalityProfile | null;

  let compat = 1.0;
  if (personalityA && personalityB) {
    compat = calculateCompatibility(personalityA, personalityB);
  }

  const existingRel = db.select().from(relationships)
    .where(and(eq(relationships.agent_a, orderedA), eq(relationships.agent_b, orderedB))).get();

  const templateImpactCtx: ConversationImpactContext = {
    overallSentiment: messageSentiment,
    turnCount: turns.length,
    topic: conversationDoc.topic,
    personalityA,
    personalityB,
    compatibility: compat,
    existingFriendshipAB: existingRel?.friendship_ab ?? 0,
    existingFriendshipBA: existingRel?.friendship_ba ?? 0,
    existingRomanceAB: existingRel?.romance_ab ?? 0,
    existingRomanceBA: existingRel?.romance_ba ?? 0,
    isTemplate: true,
  };

  const templateDeltas = computeRelationshipDeltas(templateImpactCtx);

  db.insert(relationshipEvents)
    .values({
      agent_a: orderedA,
      agent_b: orderedB,
      event_type: 'conversation',
      description: 'Brief exchange (template)',
      friendship_delta_ab: templateDeltas.friendshipAB,
      friendship_delta_ba: templateDeltas.friendshipBA,
      romance_delta_ab: templateDeltas.romanceAB,
      romance_delta_ba: templateDeltas.romanceBA,
      trust_delta_ab: templateDeltas.trustAB,
      trust_delta_ba: templateDeltas.trustBA,
      sentiment: messageSentiment,
      processed: false,
      timestamp: now,
    })
    .run();

  // Lighter memory for each participant
  for (const agent of agentList) {
    const otherAgent = agentList.find((a) => a.id !== agent.id)!;
    const templatePartnerStates = getAgentStates(otherAgent.id);
    const templatePartnerState = templatePartnerStates.find((s) =>
      ['lonely', 'heartbroken', 'depressed', 'stressed', 'grieving', 'in_debt'].includes(s),
    ) ?? null;

    simEvents.emit('conversation:ended', {
      agentId: agent.id,
      perpetratorId: otherAgent.id,
      otherName: otherAgent.name,
      summary: conversationDoc.topic ?? '',
      turns: (conversationDoc.messages as Array<unknown>).length,
      sentiment: messageSentiment ?? 0,
      topics: [],
      partnerState: templatePartnerState,
      romanceLevel: agent.id === orderedA
        ? (existingRel?.romance_ab ?? 0)
        : (existingRel?.romance_ba ?? 0),
      hadRecentConflict: false,
      // Lets the memory quote a loaded template line (conversationGist.ts);
      // plain small talk scores too low and keeps the topic template.
      messages: conversationDoc.messages,
    });
  }

  // Social + fun + mood boost (consistent with LLM conversation effects)
  const avgSentiment = agentList.length === 2 ? (messageSentiment ?? 0) : 0;
  for (const agent of agentList) {
    const agentNeeds = db
      .select()
      .from(needs)
      .where(eq(needs.agent_id, agent.id))
      .get();

    if (agentNeeds) {
      // Fun delta mirrors LLM conversations: positive sentiment → fun boost
      const funDelta = avgSentiment > 0 ? 2 : avgSentiment < -0.3 ? -1 : 0.5;
      const currentTime = agentNeeds.last_updated ?? 0;

      // Add mood modifier like LLM conversations do
      const moodModifiers = [...agentNeeds.mood_modifiers];
      if (Math.abs(avgSentiment) > 0.1) {
        moodModifiers.push({
          value: avgSentiment * 3,
          source: 'template_conversation',
          expiresAt: currentTime + CONFIG.NEEDS.MOOD_MODIFIER_DURATION_GAME_MINUTES,
        });
      }

      db.update(needs)
        .set({
          social: clamp(agentNeeds.social + 3, 0, 100),
          fun: clamp(agentNeeds.fun + funDelta, 0, 100),
          mood_modifiers: moodModifiers,
        })
        .where(eq(needs.id, agentNeeds.id))
        .run();
    }
  }
}
