import { db } from '../db';
import { agents, conversations, relationshipEvents, shared_knowledge } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { simEvents } from './simEvents';
import { logActivity } from './activityLogger';
import { computeConversationImpact } from './conversationImpact';
import { shortenForFeed, thatSentence } from './factText';

/**
 * Tells the player what their meddling came to.
 *
 * A nudge used to end at the toast ("Mara and Jonas are on their way"): whether
 * the confrontation the player forced ended in a feud or a hug was only findable
 * by digging through the conversation history, and a nudge that never happened
 * (the pair never met, the queue entry timed out) vanished without a word. This
 * module writes one `player_outcome` feed row per player-caused conversation,
 * which getAlerts turns into a gold toast and the inbox keeps:
 *
 *   "Your confrontation: Mara & Jonas — it turned ugly (friendship −18), now rivals."
 *
 * Timing is the subtle part. `finishCompletedConversation` (and the template
 * fallback) inserts the conversation's relationship events *unprocessed* and
 * then emits `conversation:ended`; the relationships phase applies them — and
 * changes the pair's status — on its next run. Reporting at `conversation:ended`
 * would always miss "now rivals". So the report waits for every one of the
 * conversation's events to come back through `relationship:event_applied`,
 * collecting the before/after status on the way, and is written then (by which
 * point the facts other `conversation:ended` listeners create exist too).
 *
 * Also here, because they are the same kind of message:
 *   - `player_nudge_expired` when a player's queue entry is dropped
 *     (`conversation:queue_dropped` from the conversation scheduler);
 *   - the moment a rumor the player planted reaches its own subject
 *     (`rumor:reached_subject` from gossip.ts) — the planted rumor's payoff.
 *
 * Side-effect module: registers its listeners on import (server/index.ts), like
 * giftEngine. State is per world and cleared by `clearPlayerOutcomes`.
 */

// ─── Wording (pure, exported for tests) ──────────────────────────────────────

/** Relationship statuses (relationships.ts `deriveStatus`) as a clause about the pair. */
const STATUS_CLAUSES: Record<string, string> = {
  partners: 'now a couple',
  romantic_interest: 'now sweet on each other',
  complicated: "now it's complicated",
  best_friends: 'now best friends',
  close_friends: 'now close friends',
  friends: 'now friends',
  acquaintances: 'now mere acquaintances',
  strangers: 'strangers again',
  rivals: 'now rivals',
  enemies: 'now enemies',
  estranged: 'estranged for good',
};

export function statusClause(status: string): string {
  return STATUS_CLAUSES[status] ?? `now ${status.replace(/_/g, ' ')}`;
}

/** The player's action, as the subject of the report. Unknown player_* reasons read as a plain nudge. */
function actionLabel(trigger: string): string {
  if (trigger.startsWith('player_confront')) return 'Your confrontation';
  if (trigger.startsWith('player_tell_secret')) return 'The secret you had told';
  return 'Your nudge';
}

/**
 * How it went, from the conversation's mean sentiment. A template fallback (the
 * LLM conversation never started in time) is a few stock lines, so it gets its
 * own phrase rather than a verdict read off canned sentiment.
 */
function toneOf(trigger: string, sentiment: number, template: boolean): string {
  if (template) return 'they only traded a few words';
  const confront = trigger.startsWith('player_confront');
  if (sentiment >= 0.5) return confront ? 'they made peace' : 'it ended warmly';
  if (sentiment >= 0.15) return confront ? 'they cleared the air' : 'it went well';
  if (sentiment > -0.15) return 'nothing much came of it';
  if (sentiment > -0.5) return 'it got tense';
  return 'it turned ugly';
}

/** "+4" / "−18" with a real minus sign; 0 after rounding means "didn't move". */
function signed(n: number): string {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : `−${Math.abs(r)}`;
}

export interface OutcomeFacts {
  /** The conversation's `trigger_reason` ("player_confront", "player_nudge (template)", ...). */
  trigger: string;
  names: string[];
  friendship: number;
  romance: number;
  trust: number;
  sentiment: number;
  /** First status change among the participants, if any. */
  status?: { from: string; to: string } | null;
  /** The most sensitive fact the conversation put into circulation. */
  fact?: string | null;
}

export function describeOutcome(o: OutcomeFacts): string {
  const template = o.trigger.endsWith('(template)');
  const who = o.names.map((n) => n.split(' ')[0]).join(' & ');
  const deltas = (
    [['friendship', o.friendship], ['romance', o.romance], ['trust', o.trust]] as const
  )
    .filter(([, v]) => Math.round(v) !== 0)
    .map(([k, v]) => `${k} ${signed(v)}`);
  let text = `${actionLabel(o.trigger)}: ${who} — ${toneOf(o.trigger, o.sentiment, template)}`;
  if (deltas.length > 0) text += ` (${deltas.join(', ')})`;
  if (o.status && o.status.from !== o.status.to) text += `, ${statusClause(o.status.to)}`;
  text += '.';
  if (o.fact) text += ` ${thatSentence('Word got out', shortenForFeed(o.fact, 90))}`;
  return text;
}

export type DropReason = 'busy' | 'apart';

export function describeExpired(trigger: string, names: string[], reason: DropReason): string {
  const who = names.map((n) => n.split(' ')[0]).join(' & ');
  const lead = trigger.startsWith('player_confront')
    ? 'Your confrontation never happened'
    : trigger.startsWith('player_tell_secret')
      ? 'Your secret was never told'
      : 'Your nudge came to nothing';
  const why = reason === 'busy' ? "couldn't break away from what they were doing" : 'never found each other';
  return `${lead}: ${who} ${why}.`;
}

// ─── State ────────────────────────────────────────────────────────────────────

interface PendingOutcome {
  conversationId: number;
  trigger: string;
  /** Relationship event ids not yet applied by the relationships phase. */
  waiting: Set<number>;
  /** First "from" and latest "to" status seen, per pair. */
  statusChanges: Map<string, { from: string; to: string }>;
}

/** Conversations already reported (or being waited on): `conversation:ended` fires once per participant. */
const seenConversations = new Set<number>();
const pendingByConversation = new Map<number, PendingOutcome>();
const pendingByEvent = new Map<number, number>();
/** Planted rumors already reported as having reached their subject. */
const seenRumors = new Set<number>();

/**
 * Bounds. The waits are short (events are applied on the next relationships
 * phase) and player conversations are rare, so these only matter if something
 * upstream stops applying events — then the oldest report goes out without a
 * status rather than the maps growing for the life of the process.
 */
const MAX_SEEN = 500;
const MAX_PENDING = 50;

function remember(set: Set<number>, id: number): void {
  set.add(id);
  if (set.size > MAX_SEEN) set.delete(set.values().next().value as number);
}

/** Drop everything; called by worldCaches on a world replace (ids restart). */
export function clearPlayerOutcomes(): void {
  seenConversations.clear();
  pendingByConversation.clear();
  pendingByEvent.clear();
  seenRumors.clear();
}

function nameOf(id: number): string {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? 'Someone';
}

// ─── Conversation outcomes ────────────────────────────────────────────────────

function finalize(p: PendingOutcome): void {
  pendingByConversation.delete(p.conversationId);
  for (const id of p.waiting) pendingByEvent.delete(id);

  // Re-read now rather than reuse the numbers from `conversation:ended`: by
  // this point the row is closed and the facts other listeners add exist.
  const impact = computeConversationImpact(p.conversationId);
  if (!impact) return;
  const participants = impact.conversation.participants as number[];
  const status = [...p.statusChanges.values()].find((s) => s.from !== s.to) ?? null;
  const fact = [...impact.createdFacts].sort((a, b) => b.sensitivity - a.sensitivity)[0]?.content ?? null;

  const description = describeOutcome({
    trigger: p.trigger,
    names: participants.map((id) => impact.names[id] ?? 'Someone'),
    friendship: impact.totals.friendship,
    romance: impact.totals.romance,
    trust: impact.totals.trust,
    sentiment: impact.totals.sentiment,
    status,
    fact,
  });

  logActivity({
    type: 'player_outcome',
    agents: participants,
    // The numbers ride along in template_data (the row's only free-form
    // column; `metadata` is typed for cascade chains) for anything that wants
    // more than the sentence.
    templateData: {
      description,
      trigger: p.trigger,
      friendship: impact.totals.friendship,
      romance: impact.totals.romance,
      trust: impact.totals.trust,
      ...(status ? { statusFrom: status.from, statusTo: status.to } : {}),
    },
    sourceType: 'conversation',
    sourceId: p.conversationId,
  });
}

/** Exported for tests; the listener below is the only production caller. */
export function onConversationEnded(payload: { conversationId?: number | null }): void {
  const conversationId = payload.conversationId;
  if (conversationId == null || seenConversations.has(conversationId)) return;
  const convo = db.select({ trigger: conversations.trigger_reason }).from(conversations)
    .where(eq(conversations.id, conversationId)).get();
  if (!convo?.trigger?.startsWith('player_')) return;
  remember(seenConversations, conversationId);

  const impact = computeConversationImpact(conversationId);
  if (!impact) return;
  const eventIds = impact.relationshipEvents.map((e) => e.id);
  // Only unprocessed events will come back through `relationship:event_applied`.
  // In practice that is all of them (they were inserted a moment ago, in the
  // same synchronous run that emitted this), but an event already applied must
  // not hold the report forever.
  const waiting = eventIds.length === 0 ? [] : db.select({ id: relationshipEvents.id })
    .from(relationshipEvents)
    .where(and(inArray(relationshipEvents.id, eventIds), eq(relationshipEvents.processed, false)))
    .all()
    .map((r) => r.id);

  const pending: PendingOutcome = {
    conversationId,
    trigger: convo.trigger,
    waiting: new Set(waiting),
    statusChanges: new Map(),
  };
  if (pending.waiting.size === 0) {
    finalize(pending);
    return;
  }
  if (pendingByConversation.size >= MAX_PENDING) {
    const oldest = pendingByConversation.values().next().value as PendingOutcome;
    finalize(oldest);
  }
  pendingByConversation.set(conversationId, pending);
  for (const id of pending.waiting) pendingByEvent.set(id, conversationId);
}

export function onRelationshipEventApplied(payload: {
  eventId: number;
  agentA: number;
  agentB: number;
  oldStatus: string;
  newStatus: string;
}): void {
  const conversationId = pendingByEvent.get(payload.eventId);
  if (conversationId == null) return;
  pendingByEvent.delete(payload.eventId);
  const p = pendingByConversation.get(conversationId);
  if (!p) return;
  const key = `${payload.agentA}:${payload.agentB}`;
  const prev = p.statusChanges.get(key);
  p.statusChanges.set(key, { from: prev?.from ?? payload.oldStatus, to: payload.newStatus });
  p.waiting.delete(payload.eventId);
  if (p.waiting.size === 0) finalize(p);
}

// ─── Nudges that never happened ───────────────────────────────────────────────

export function onQueueDropped(payload: {
  entry: { participants: number[]; trigger_reason: string };
  reason: DropReason;
}): void {
  const { entry, reason } = payload;
  if (!entry.trigger_reason.startsWith('player_')) return;
  const participants = entry.participants as number[];
  logActivity({
    type: 'player_nudge_expired',
    agents: participants,
    templateData: {
      description: describeExpired(entry.trigger_reason, participants.map(nameOf), reason),
      trigger: entry.trigger_reason,
      reason,
    },
  });
}

// ─── Planted rumors ───────────────────────────────────────────────────────────

export function onRumorReachedSubject(payload: { factId: number; subjectId: number; tellerId: number }): void {
  if (seenRumors.has(payload.factId)) return;
  // `unverified` + `fabricated` is how startRumor marks a planted rumor; the
  // emitter already filters on reliability, this keeps the claim "your rumor"
  // honest if another source of unverified facts ever appears.
  const fact = db.select({ reliability: shared_knowledge.reliability, source: shared_knowledge.source })
    .from(shared_knowledge).where(eq(shared_knowledge.id, payload.factId)).get();
  if (fact?.reliability !== 'unverified' || fact.source !== 'fabricated') return;
  remember(seenRumors, payload.factId);

  const subject = nameOf(payload.subjectId).split(' ')[0];
  const teller = nameOf(payload.tellerId).split(' ')[0];
  logActivity({
    type: 'player_outcome',
    agents: [payload.subjectId, payload.tellerId],
    templateData: {
      description: `Your rumor reached ${subject} — who is furious with ${teller} for repeating it.`,
      trigger: 'player_rumor',
    },
    sourceType: 'shared_knowledge',
    sourceId: payload.factId,
  });
}

// ─── Registration ─────────────────────────────────────────────────────────────

let initialized = false;

function initPlayerOutcomes(): void {
  if (initialized) return;
  initialized = true;
  simEvents.on('conversation:ended', onConversationEnded);
  simEvents.on('relationship:event_applied', onRelationshipEventApplied);
  simEvents.on('conversation:queue_dropped', onQueueDropped);
  simEvents.on('rumor:reached_subject', onRumorReachedSubject);
}

// Auto-initialize on import
initPlayerOutcomes();
