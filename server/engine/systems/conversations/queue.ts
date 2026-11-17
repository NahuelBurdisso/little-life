/**
 * Steps C–E of the conversation tick: one pass over the conversation queue.
 */

import { db } from '../../../db';
import { agents, conversations, conversationQueue } from '../../../db/schema';
import type { ActiveLLMEntry } from '../../../db/schema';
import { eq, desc } from 'drizzle-orm';
import { gameMinutes } from '../../../lib/gameClock';
import { taskRunner } from '../../../ai/taskRunner';
import { queuedTopic } from '../../../ai/prompts';
import {
  latencyProbeDue,
  planConversation,
  turnLatencyEstimateMs,
  queueDeadlineGameMin,
  type ConversationPlan,
} from '../../../lib/conversationPacing';
import { simEvents } from '../../../lib/simEvents';
import { getAgentStates } from '../../../lib/states';
import type { AgentRow, QueueRow } from './types';
import { conversationPairKey, findNeedsInterrupt, isProtectedEntry, loadTemplatePair } from './helpers';
import { type ConversationTickState, claimParticipants, extendProtectedWait } from './tickState';

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

/**
 * Steps C–E: one pass over the queue, highest priority first. `updatedActiveLLM`
 * is what Step A left running; the LLM conversations opened here join it.
 */
export function workQueue(state: ConversationTickState, updatedActiveLLM: ActiveLLMEntry[]): void {
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

  state.currentActive = updatedActiveLLM.length;
  state.runnerFreeSlots = taskRunner.freeConversationSlots;
  state.fillEntries = [...updatedActiveLLM];

  for (const entry of queueEntries) {
    workQueueEntry(state, entry);
  }
}

/** One queue entry: stamp its deadline, then route it to Step C, D or E. */
function workQueueEntry(state: ConversationTickState, entry: QueueRow): void {
  const { world, nowGameMin } = state;
  // Queue waits run on the game clock: at 4x an entry used to wait four
  // times the game time (10 s = 40 game minutes), so the conversation rate
  // tracked real time. Producers write a 1x-equivalent `max_wait`; the
  // deadline is derived once and stored, so a later speed change can't move it.
  // Above 1x it gets a real-time floor: the LLM slot an entry waits for
  // frees in real seconds (conversationPacing.queueDeadlineGameMin).
  if (entry.deadline_game_min == null) {
    entry.deadline_game_min = queueDeadlineGameMin(entry, nowGameMin, world.tick_speed);
    db.update(conversationQueue)
      .set({ deadline_game_min: entry.deadline_game_min })
      .where(eq(conversationQueue.id, entry.id))
      .run();
  }
  if (nowGameMin > entry.deadline_game_min) {
    handleTimedOutEntry(state, entry);
    return;
  }

  if (entry.tier === 'template') {
    handleTemplateEntry(state, entry);
    return;
  }

  fillLLMSlot(state, entry);
}

/** Step C: an entry past its deadline is dropped or becomes a template chat. */
function handleTimedOutEntry(state: ConversationTickState, entry: QueueRow): void {
  const { world } = state;
  // Step C: timed out — delete; async template processing happens outside.
  // A timed-out entry has nowhere left to wait, so if its participants are
  // taken it is simply dropped rather than becoming a parallel template chat
  // — unless it's a protected entry held up by a live conversation (checked
  // first: a nudged pair is often still walking toward each other).
  const peek = claimParticipants(state, entry, { peek: true });
  if (peek === 'busy' && extendProtectedWait(state, entry)) return;
  db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
  state.queueTimeouts++;
  state.out.changed = true;
  // A dropped entry is gone without a trace; for a player's nudge that
  // used to mean a toast saying "on their way" and then silence. The
  // player-outcome reporter (lib/playerOutcomes.ts) turns this into a feed
  // line. 'duplicate' is not a drop from the player's point of view: the
  // pair is already talking to each other.
  if (peek === 'busy') {
    simEvents.emit('conversation:queue_dropped', { entry, reason: 'busy' });
    return;
  }
  if (peek !== 'ok') return;
  // Liveness/proximity before claiming: a pair that walked apart (or died)
  // can't have the template chat, and must not claim agents on the way out.
  if (!loadTemplatePair(entry.participants as number[])) {
    simEvents.emit('conversation:queue_dropped', { entry, reason: 'apart' });
    return;
  }
  claimParticipants(state, entry);
  state.out.timedOutQueue.push({ entry, world });
  state.templateTotal++;
}

/** Step D: a template-tier entry is had now, as a template chat, if the pair is free. */
function handleTemplateEntry(state: ConversationTickState, entry: QueueRow): void {
  const { world } = state;
  // Step D: template tier — processed immediately, no LLM.
  // Busy participants keep the entry queued; it runs once they're free or
  // ages out through Step C. A pair that can't talk is dropped unclaimed.
  if (!loadTemplatePair(entry.participants as number[])) {
    db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
    state.out.changed = true;
    return;
  }
  const claim = claimParticipants(state, entry);
  if (claim === 'busy') return;
  // Process as template — no LLM needed for trivial conversations
  db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
  if (claim === 'duplicate') {
    state.out.changed = true;
    return;
  }
  state.out.timedOutQueue.push({ entry, world });
  state.templateTotal++;
  state.out.changed = true;
}

/**
 * Step E: try to open an LLM conversation for this entry — or leave it queued,
 * drop it, turn it into a template chat, or walk the initiator over first.
 */
function fillLLMSlot(state: ConversationTickState, entry: QueueRow): void {
  const { world, schedulerState, nowGameMin } = state;
  // Step E: fill open LLM slots. `continue`, not `break`, once they're full:
  // lower-priority template entries further down still get their turn — but
  // not for this pair: a same-pair template must not jump the queue just
  // because the slot this entry is waiting for isn't free yet.
  // Also full when the task runner has no chain free: a closed conversation
  // keeps its runner slot until its aborted turn unwinds, and a dispatch the
  // runner rejects is only re-queued after this pass (see below).
  if (state.currentActive >= schedulerState.max_concurrent_llm || state.out.dispatches.length >= state.runnerFreeSlots) {
    if (claimParticipants(state, entry, { peek: true }) === 'ok') {
      state.reservedPairs.add(conversationPairKey(entry.participants as number[]));
    }
    return;
  }

  // Peek only: the pair claim is taken once the conversation actually opens
  // below. A staging entry reserves just the agents (see there).
  const claim = claimParticipants(state, entry, { peek: true });
  if (claim === 'duplicate') {
    db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
    state.out.changed = true;
    return;
  }
  if (claim === 'busy') return;

  // Depressed agents skip conversations — remove from queue.
  // Checked for every participant, not just the initiator: a depressed agent
  // queued as the *target* was still dragged into a full LLM conversation.
  const anyDepressed = entry.participants.some((pid) =>
    getAgentStates(pid).includes('depressed'),
  );
  if (anyDepressed) {
    db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
    return;
  }

  const isProtected = isProtectedEntry(entry);

  // Don't open a conversation someone is about to walk out of. An ordinary
  // entry waits (unclaimed) instead: many are one-shot — a perception
  // reaction (PerceptionSystem) is never queued again — so deleting lost
  // them. If the need clears in time it opens then; otherwise it ages out
  // through Step C into a brief template chat. A protected one — the player
  // asked for it — goes ahead, and Step A lets its first exchange land
  // before needs can end it.
  if (!isProtected && findNeedsInterrupt(entry.participants as number[], world)) return;

  // Size the conversation to the game time it may take (see
  // planConversation): a turn costs the model's latency × tick_speed game
  // minutes, so at 4x a 20 s turn is 80 game minutes and the tier's full
  // length would eat the evening.
  const plan = planConversation({
    tierMaxTurns: entry.tier === 'llm_deep' ? schedulerState.max_turns_deep : schedulerState.max_turns_standard,
    tickSpeed: world.tick_speed,
    isProtected,
    observedLatencyMs: turnLatencyEstimateMs(nowGameMin),
    probeDue: latencyProbeDue(nowGameMin),
  });
  if (plan.tier === 'template') {
    // Not even one exchange fits: have it as a template chat now instead of
    // an LLM one the budget would cut before anyone finished a sentence.
    db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
    state.out.changed = true;
    if (!loadTemplatePair(entry.participants as number[])) return;
    claimParticipants(state, entry);
    state.out.timedOutQueue.push({ entry, world });
    state.templateTotal++;
    return;
  }
  const maxTurns = plan.maxTurns;

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
    return;
  }

  // Remove queue entry if either participant has died since it was queued
  if (!firstParticipant.is_active || !secondParticipant.is_active) {
    db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
    return;
  }

  // Skip if agents are not at the same location or too far apart
  const sameLocation = firstParticipant.current_location != null &&
    firstParticipant.current_location === secondParticipant.current_location;
  if (!sameLocation) {
    const dx = firstParticipant.position.x - secondParticipant.position.x;
    const dy = firstParticipant.position.y - secondParticipant.position.y;
    if (dx * dx + dy * dy > 64 * 64) {
      // A player's nudge walks both agents to a meeting point, so on its
      // first pass the pair is almost always still apart. Deleting it here
      // lost every confrontation/"make them talk" between people in
      // different places without a word; it waits for them instead, and
      // if they never meet it ages out through Step C (reported as 'apart').
      if (isProtected) return;
      // Too far apart — remove from queue, they'll re-queue when close
      db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
      return;
    }
  }

  if (stageApproach(state, entry, firstParticipant, secondParticipant)) return;

  const locationId = firstParticipant.current_location;
  if (!locationId) {
    // Can't start a conversation without a location; skip for now
    return;
  }

  openLLMConversation(state, entry, {
    plan, maxTurns, isProtected, firstParticipant, secondParticipant, locationId,
  });
}

/**
 * Walk the initiator over when the pair is not yet within talking distance.
 * Returns true when the entry is done for this pass (staged, or the initiator
 * can't be moved); false when they are close enough to open the conversation.
 */
function stageApproach(
  state: ConversationTickState,
  entry: QueueRow,
  firstParticipant: AgentRow,
  secondParticipant: AgentRow,
): boolean {
  const { world } = state;
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
      return true;
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
      state.out.changed = true;
    }
    // Reserve both agents for the rest of this pass: the initiator is walking
    // over to talk, so a lower-priority entry must not grab either of them.
    // The pair key is not claimed, so this entry opens normally next tick.
    for (const id of entry.participants as number[]) state.claimedAgents.add(id);
    return true;
  }
  return false;
}

/**
 * Open the LLM conversation: claim the pair, insert the row, set both agents
 * talking, and collect the dispatch the async pass hands to the task runner.
 */
function openLLMConversation(
  state: ConversationTickState,
  entry: QueueRow,
  opening: {
    plan: ConversationPlan;
    maxTurns: number;
    isProtected: boolean;
    firstParticipant: AgentRow;
    secondParticipant: AgentRow;
    locationId: number;
  },
): void {
  const { world, now, nowGameMin } = state;
  const { plan, maxTurns, isProtected, firstParticipant, secondParticipant, locationId } = opening;
  // Over by its budget plus the wrap-up grace at the latest.
  claimParticipants(state, entry, { freeAt: nowGameMin + plan.budgetGameMin + plan.graceGameMin });

  // Create conversation record
  const result = db
    .insert(conversations)
    .values({
      participants: entry.participants,
      messages: [],
      location: locationId,
      trigger_reason: entry.trigger_reason,
      topic: queuedTopic(entry),
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
  state.out.dispatches.push({
    conversationId,
    speakerId: entry.participants[0],
    participantIds: entry.participants as number[],
    participantNames: [firstParticipant.name, secondParticipant.name],
    entry,
    // Stamped only once the runner accepts it: a rejected dispatch measures
    // nothing and must not use up the probe.
    probeAt: plan.probe ? nowGameMin : null,
  });

  state.fillEntries.push({
    conversationId,
    startedAt: now,
    startedGameMin: nowGameMin,
    budgetGameMin: plan.budgetGameMin,
    plannedTurns: maxTurns,
    graceGameMin: plan.graceGameMin,
    protected: isProtected,
  });
  state.currentActive++;
  state.out.changed = true;

  // Remove from queue
  db.delete(conversationQueue).where(eq(conversationQueue.id, entry.id)).run();
}
