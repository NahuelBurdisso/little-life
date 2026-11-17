/**
 * Small helpers the conversation steps share: pair keys, protected entries,
 * releasing participants, needs interrupts, transcript closing and the template pair check.
 */

import { db } from '../../../db';
import { agents, needs, conversations } from '../../../db/schema';
import type { ConversationMessage } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../../../lib/constants';
import { WRAP_UP_FAREWELLS, farewellText } from '../../../data/wrapUpFarewells';
import { isPastBedtime, needsWrapUpReason, type NeedsWrapUpReason } from '../../../lib/conversationPacing';
import { PersonalityProfile } from '../../../lib/personality';
import { getEffectivePersonality } from '../../../lib/states';
import type { AgentRow, ConversationRow, QueueRow, WorldRow, WrapUpReason } from './types';

/**
 * Entries the player (or the autoplay stand-in, just below the player) asked
 * for, and comfort visits someone walked across town for. These must not be
 * silently lost just because a participant happened to be mid-conversation.
 */
export function isProtectedEntry(entry: QueueRow): boolean {
  return entry.priority >= CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY - 10
    || entry.trigger_reason === 'comfort_visit';
}

/** Order-independent key, so [A,B] and [B,A] are recognised as the same pair. */
export function conversationPairKey(participants: number[]): string {
  return [...participants].sort((a, b) => a - b).join('-');
}

/**
 * Put every participant still marked as talking in THIS conversation back to idle.
 * Used whenever a conversation leaves the pipeline without going through
 * `processCompletedConversation` (ended externally, aborted, too few participants).
 * Returns true when at least one agent was released.
 */
export function releaseTalkingParticipants(conversation: ConversationRow): boolean {
  const participantIds = conversation.participants as number[];
  let released = false;
  for (const participantId of participantIds) {
    const agent = db.select().from(agents).where(eq(agents.id, participantId)).get();
    if (!agent) continue;
    const action = agent.current_action;
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
export function findNeedsInterrupt(
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
      ? isPastBedtime(agent.schedule, personality, world.time.hour, agent.workplace != null)
      : false;
    const reason = needsWrapUpReason({ hunger: n.hunger, energy: n.energy, critical }, pastBedtime);
    if (reason) return { agentId, reason };
  }
  return null;
}

/** Whoever didn't say the last line — the one whose turn it is. */
export function nextSpeaker(conversation: ConversationRow): number {
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
export function closeWrappedTranscript(
  conversation: ConversationRow,
  leaverId: number,
  reason: WrapUpReason,
  plannedTurns: number,
): void {
  const messages = [...(conversation.messages as ConversationMessage[])];
  // Never two lines in a row from the leaver: if they spoke last (their
  // partner's reply never came), the conversation ends on their own line.
  const leaverSpokeLast = messages[messages.length - 1]?.speakerId === leaverId;
  if (messages.length > 0 && messages.length < plannedTurns && !leaverSpokeLast) {
    const otherId = (conversation.participants as number[]).find((p) => p !== leaverId);
    const otherName = otherId != null
      ? db.select({ name: agents.name }).from(agents).where(eq(agents.id, otherId)).get()?.name
      : undefined;
    const lines = WRAP_UP_FAREWELLS[reason];
    const line = lines[Math.floor(Math.random() * lines.length)];
    messages.push({
      speakerId: leaverId,
      text: farewellText(line.text, otherName),
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
 * The distress a chat partner is in, as the goal and cascade listeners read it off `conversation:ended`.
 * `sick` is the newest entry and deliberately the last resort: someone who is ill AND lonely is still
 * reported as lonely (the ripple rules key on that list and know nothing of `sick`), and a partner who
 * is only ill now reports `sick`, which is what advances a friend's protect goal (systems/goals.ts).
 */
const DISTRESS_STATES = ['lonely', 'heartbroken', 'depressed', 'stressed', 'grieving', 'in_debt'];
export function partnerDistressState(states: readonly string[]): string | null {
  return states.find((s) => DISTRESS_STATES.includes(s)) ?? (states.includes('sick') ? 'sick' : null);
}

/**
 * The two agents of a template conversation, or null when they can't have one:
/**
 * The two agents of a template conversation, or null when they can't have one:
 * missing or deactivated (a dead agent's row stays, and used to still produce a
 * template chat with real relationship and needs effects), too far apart (a
 * queue entry may have waited out `max_wait` while the pair walked off), or with
 * no location to hold it in. Same liveness/proximity contract as the LLM path.
 * Checked in the tick before claiming agents, and again when processing.
 */
export function loadTemplatePair(participants: number[]): [AgentRow, AgentRow] | null {
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
