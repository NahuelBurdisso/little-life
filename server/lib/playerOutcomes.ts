import { db } from '../db';
import { agents, conversations, relationshipEvents, shared_knowledge } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { simEvents } from './simEvents';
import { logActivity } from './activityLogger';
import { computeConversationImpact } from './conversationImpact';
import { joinForFeed, shortenForFeed, thatSentence } from './factText';
import { gameMinutesNow } from './worldClock';

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
 *     (`rumor:reached_subject` from gossip.ts) — the planted rumor's payoff;
 *   - the first time a whispered thought shows: the agent voices it in a
 *     conversation (`conversation:ended`, keywords in their own lines) or it
 *     makes them rework their day (`plan:replanned`, whose reason is the
 *     whisper itself). Whichever comes first, once per whisper;
 *   - an anonymous letter landing: the first finished conversation between its
 *     recipient and the one it was about (`registerLetter`), once per letter.
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
  if (trigger.startsWith('player_letter')) return 'Your letter';
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
/** Whispered thoughts not yet reported, per agent (see `registerWhisper`). */
const openWhispers = new Map<number, Whisper[]>();
/** Anonymous letters not yet reported, per recipient (see `registerLetter`). */
const openLetters = new Map<number, Letter[]>();

/**
 * Bounds. The waits are short (events are applied on the next relationships
 * phase) and player conversations are rare, so these only matter if something
 * upstream stops applying events — then the oldest report goes out without a
 * status rather than the maps growing for the life of the process.
 */
const MAX_SEEN = 500;
const MAX_PENDING = 50;
/** A letter nobody talked about within this many game minutes (three days) is forgotten, not reported late. */
const LETTER_OUTCOME_WINDOW_MINUTES = 3 * 1440;
const MAX_LETTERS_PER_AGENT = 3;

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
  openWhispers.clear();
  openLetters.clear();
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

/**
 * Start waiting on a conversation the player is answerable for (one they forced, or
 * the one a letter of theirs led to): once its relationship events are applied,
 * `finalize` writes the report, worded after `trigger`. The caller has already
 * decided the conversation counts and marked it seen.
 */
function trackOutcome(conversationId: number, trigger: string): void {
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
    trigger,
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

/** Exported for tests; the listener below is the only production caller. */
export function onConversationEnded(payload: { conversationId?: number | null }): void {
  const conversationId = payload.conversationId;
  if (conversationId == null || seenConversations.has(conversationId)) return;
  const convo = db.select({ trigger: conversations.trigger_reason, participants: conversations.participants })
    .from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!convo) return;
  if (convo.trigger?.startsWith('player_')) {
    remember(seenConversations, conversationId);
    trackOutcome(conversationId, convo.trigger);
    return;
  }
  // Not one the player forced, but it may be the scene a letter was waiting for.
  if (!takeLetterFor(convo.participants as number[])) return;
  remember(seenConversations, conversationId);
  trackOutcome(conversationId, 'player_letter');
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

// ─── Whispered thoughts ───────────────────────────────────────────────────────

/**
 * A whisper is a memory plus a replan nudge, and after that the player heard
 * nothing: the thought could resurface at supper or die unread. There is no
 * cheap "this memory was used" flag (retrieval touches `last_accessed` for
 * plans, reflections and prompts alike, and a retrieved memory the agent never
 * mentions changed nothing you could see), so the report keys off two things the
 * player can actually watch happen:
 *   - the agent SAYS it: their own lines in a finished conversation share
 *     distinctive words with the whisper (`whisperAired`);
 *   - it MOVES their day: the replan the whisper triggered rewrote the plan
 *     (`plan:replanned`, matched on the whisper text carried in the reason).
 * Each whisper is reported once and then forgotten; a few per agent are kept
 * (the oldest quietly drops) so a spammed agent doesn't grow the map.
 */
export interface Whisper {
  text: string;
  /** Distinctive-word stems (see `whisperStems`). */
  stems: string[];
}

const MAX_WHISPERS_PER_AGENT = 3;

/** Words that carry no meaning of their own; matching on them would fire on any chatter. */
const FILLER = new Set([
  'that', 'this', 'with', 'have', 'from', 'they', 'them', 'then', 'than', 'will', 'would', 'could',
  'should', 'about', 'what', 'when', 'where', 'which', 'while', 'there', 'their', 'been', 'were',
  'your', 'just', 'some', 'something', 'someone', 'maybe', 'really', 'very', 'much', 'more', 'into',
  'over', 'like', 'know', 'feel', 'think', 'thought', 'cant', 'dont', 'want', 'need', 'time',
]);

const NOT_A_WORD = /[^A-Za-z\u00c0-\u00ff']+/;

/** Comparable stem: lower case, letters only, first five characters ("hiding" ~ "hides"). */
function stemOf(word: string): string {
  return word.toLowerCase().replace(/[^a-z\u00df-\u00ff]/g, '').slice(0, 5);
}

/** Distinctive stems of a whispered text: words of 4+ letters that aren't filler. */
export function whisperStems(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.split(NOT_A_WORD)) {
    const bare = w.replace(/'/g, '').toLowerCase();
    if (bare.length < 4 || FILLER.has(bare)) continue;
    out.add(stemOf(bare));
  }
  return [...out];
}

/**
 * Do these spoken lines carry the whisper? Two shared stems, or the only one
 * when the whisper has fewer than two: one common word alone ("bakery") is a
 * coincidence in a town full of them, two is the thought coming out.
 */
export function whisperAired(lines: string[], stems: string[]): boolean {
  if (stems.length === 0) return false;
  const spoken = new Set<string>();
  for (const line of lines) {
    for (const w of line.split(NOT_A_WORD)) {
      const st = stemOf(w);
      if (st.length >= 4) spoken.add(st);
    }
  }
  const hits = stems.filter((st) => spoken.has(st)).length;
  return hits >= Math.min(2, stems.length);
}

/** Called by whisperThought with the sanitized text. */
export function registerWhisper(agentId: number, text: string): void {
  const list = openWhispers.get(agentId) ?? [];
  list.push({ text, stems: whisperStems(text) });
  while (list.length > MAX_WHISPERS_PER_AGENT) list.shift();
  openWhispers.set(agentId, list);
}

function reportWhisper(agentId: number, w: Whisper, description: string): void {
  const rest = (openWhispers.get(agentId) ?? []).filter((x) => x !== w);
  if (rest.length > 0) openWhispers.set(agentId, rest);
  else openWhispers.delete(agentId);
  logActivity({
    type: 'player_outcome',
    agents: [agentId],
    templateData: { description, trigger: 'player_whisper', thought: w.text },
  });
}

export function onWhisperConversation(payload: {
  messages?: Array<{ speakerId: number; text: string; fallback?: boolean }>;
}): void {
  if (openWhispers.size === 0 || !payload.messages) return;
  const speakers = new Set(payload.messages.map((m) => m.speakerId));
  for (const agentId of speakers) {
    const open = openWhispers.get(agentId);
    if (!open) continue;
    // Canned fallback lines are not the agent's voice; only real speech counts.
    const own = payload.messages.filter((m) => m.speakerId === agentId && !m.fallback);
    for (const w of [...open]) {
      if (!whisperAired(own.map((m) => m.text), w.stems)) continue;
      // The line that carries the most of it, for the quote.
      const line = own.find((m) => whisperAired([m.text], w.stems)) ?? own[0];
      const who = nameOf(agentId).split(' ')[0];
      reportWhisper(
        agentId,
        w,
        `Your whispered thought is out: ${who} said it aloud — "${shortenForFeed(line.text, 90)}"`,
      );
    }
  }
}

export function onPlanReplanned(payload: { agentId: number; description: string; blocks: string[] }): void {
  const open = openWhispers.get(payload.agentId);
  if (!open) return;
  // The reason a whisper hands the replanner quotes the sanitized text verbatim.
  const w = open.find((x) => payload.description.includes(`"${x.text}"`));
  if (!w) return;
  const who = nameOf(payload.agentId).split(' ')[0];
  // Plan blocks are written as titles ("Purchase fine flour"); mid-sentence
  // they read as "now purchase fine flour". Only the opening verb is lowered —
  // names later in a block keep their capitals.
  const plan = joinForFeed(payload.blocks.map((b) => b.charAt(0).toLowerCase() + b.slice(1)), 90);
  reportWhisper(
    payload.agentId,
    w,
    `Your whispered thought changed ${who}'s day${plan ? `: now ${plan}` : ''}.`,
  );
}

// ─── Anonymous letters ────────────────────────────────────────────────────────

/**
 * A letter is a fact put in one head (godPowers.ts `sendAnonymousLetter`), and its
 * payoff is a scene, not a line of text: the recipient and the one the secret is
 * about (or its named partner) finally talking. So there is no keyword to watch
 * for, unlike a whisper; the report keys off the conversation itself. Any finished
 * conversation between the recipient and the subject (or target) counts, whoever
 * started it, and each letter is reported once. A conversation the player forced
 * (a confrontation, a secret told) keeps its own label and leaves the letter open.
 */
export interface Letter {
  subjectId: number;
  targetId: number | null;
  factId: number;
  /** Game minute it was sent, for the report window. */
  at: number;
}

/** Called by sendAnonymousLetter once the fact is in the recipient's head. */
export function registerLetter(recipientId: number, subjectId: number, targetId: number | null, factId: number): void {
  const list = openLetters.get(recipientId) ?? [];
  list.push({ subjectId, targetId, factId, at: gameMinutesNow() });
  while (list.length > MAX_LETTERS_PER_AGENT) list.shift();
  openLetters.set(recipientId, list);
}

/**
 * The open letter a conversation among `participants` fulfils, taken off the open
 * list; null when none. Letters past their window are dropped on the way.
 */
function takeLetterFor(participants: number[]): Letter | null {
  if (openLetters.size === 0) return null;
  const now = gameMinutesNow();
  for (const recipientId of participants) {
    const open = openLetters.get(recipientId);
    if (!open) continue;
    // `now < at` (a clock that went back) keeps the letter: only a real gap expires it.
    const live = open.filter((l) => !(now - l.at >= LETTER_OUTCOME_WINDOW_MINUTES));
    const hit = live.find((l) => participants.some(
      (p) => p !== recipientId && (p === l.subjectId || (l.targetId != null && p === l.targetId)),
    ));
    const rest = hit ? live.filter((l) => l !== hit) : live;
    if (rest.length > 0) openLetters.set(recipientId, rest);
    else openLetters.delete(recipientId);
    if (hit) return hit;
  }
  return null;
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
  simEvents.on('conversation:ended', onWhisperConversation);
  simEvents.on('plan:replanned', onPlanReplanned);
}

// Auto-initialize on import
initPlayerOutcomes();
