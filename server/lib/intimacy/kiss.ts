import { and, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { activityLog, agents, conversations, relationships, worldEvents } from '../../db/schema';
import { aggregateEventEffects } from '../../data/worldEventCatalog';
import { logActivity } from '../activityLogger';
import { addMoodModifier } from '../dailyLife';
import { insertPairEvent, pairRelationship } from '../conversationBeats';
import { learnFact } from '../gossip';
import { MILESTONE_TAGS, affairInvolvesMarriage, affairSensitivity, isSpokenFor } from '../marriage';
import { simEvents } from '../simEvents';
import { getAgentStates, getEffectivePersonality } from '../states';
import { gameMinutesNow } from '../worldClock';
import { MINUTES_PER_DAY } from '../gameClock';
import { isIntimacyEligible, type IntimacyParty } from './eligibility';
import { relieveLonging } from './longing';
import { getPairIntimacy, updatePairIntimacy } from './state';
import { witnessesOf } from './witnesses';

// ─── The kiss ────────────────────────────────────────────────────────────────
//
// The first rung of romance that is not a number. When two people finish a warm
// conversation and one of them is keen enough, they may kiss: the initiator is
// whoever feels more (ties go to the lower id), the other either answers it or
// turns away. A kiss is PG and always on (it does not read the `adultContent`
// rule; the adult layer starts after it); everything that involves someone
// under 18 is refused earlier, by `isIntimacyEligible`.
//
// Handled on the initiator's own `conversation:ended` (the event fires once per
// participant, so the other side's copy is ignored) and, as a second line of
// defence against a duplicate, by the once-a-game-day rule.
//
// Effects are the usual ones: a sticky `kissed` tag, a relationship event (the
// first kiss is pivotal and kept forever, later ones are routine, see
// storyBeats.ts), feed rows, a memory of the first, longing relieved, and the
// `intimacy:kiss` event for whatever reacts to it (witnesses, rumours). If
// either is spoken for to a third person it is also the seed of an affair
// secret, known to whoever was there.

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** The one who leans in needs at least this much romance toward the other. */
export const KISS_MIN_ROMANCE = 45;
/** The conversation has to have been warm. */
export const KISS_MIN_SENTIMENT = 0.3;
/** Chance per warm conversation of a pair who never kissed / who already have. */
export const FIRST_KISS_CHANCE = 0.30;
export const KISSED_BEFORE_CHANCE = 0.55;
/** An evening together (see `isDateHour`) makes it likelier. */
export const DATE_FACTOR = 1.5;
/** A festival or a moonlit fair (`romance_boost` world event) too. */
export const ROMANCE_BOOST_FACTOR = 1.3;
/** Somebody else is in the room: most people wait, the impulsive do not. */
export const PRIVACY_FACTOR = 0.3;
export const BOLD_IMPULSIVENESS = 70;
/** If the one being kissed feels less than this, they turn away. */
export const REBUFF_BELOW_ROMANCE = 30;
export const REBUFF_MOOD = -10;
export const REBUFF_MOOD_MINUTES = 4 * 60;
export const REBUFF_ROMANCE = -5;
/** Nobody is in the mood: a kiss is not on the cards for someone in one of these states. */
export const KISS_BLOCKING_STATES: readonly string[] = ['heartbroken', 'grieving', 'sick', 'arrested'];

/** The sticky relationship tag: these two have kissed (contract name). */
export const KISSED_TAG = 'kissed';

// ─── Pure rules ──────────────────────────────────────────────────────────────

export interface KissParty extends IntimacyParty {
  /** This person's romance toward the other one, 0..100. */
  romance: number;
  impulsiveness: number;
  /** Agent state types (`getAgentStates`). */
  states: readonly string[];
}

export interface KissChanceCtx {
  initiator: KissParty;
  receiver: KissParty;
  /** Overall sentiment of the conversation that just ended. */
  sentiment: number;
  /** The pair already carries the `kissed` tag. */
  kissedBefore: boolean;
  /** An evening together, the receiver at least warm: a date. */
  isDate: boolean;
  /** A `romance_boost` world event is running. */
  romanceBoost: boolean;
  /** A third person, awake, could see. */
  thirdPresent: boolean;
  /** They already kissed on this game day. */
  kissedToday: boolean;
}

/**
 * The initiator is the one with more romance toward the other; equal feelings
 * go to the lower id so the answer never depends on who was listed first.
 */
export function pickKissInitiator<T extends { id: number; romance: number }>(x: T, y: T): { initiator: T; receiver: T } {
  const xLeads = x.romance > y.romance || (x.romance === y.romance && x.id < y.id);
  return xLeads ? { initiator: x, receiver: y } : { initiator: y, receiver: x };
}

/** Evening hours: the walk home, the tavern's last round. */
export function isDateHour(hour: number): boolean {
  return hour >= 18 && hour < 23;
}

/**
 * Chance that this warm conversation ends in the initiator leaning in, 0..1.
 * Pure: every input is passed in. 0 unless both are eligible (adults, alive,
 * drawn to each other's gender), the talk was warm, the initiator keen, neither
 * in a state that rules it out, and they have not kissed today.
 */
export function kissChance(ctx: KissChanceCtx): number {
  const { initiator, receiver } = ctx;
  if (!isIntimacyEligible(initiator, receiver)) return 0;
  if (!(ctx.sentiment > KISS_MIN_SENTIMENT)) return 0;
  if (!(initiator.romance >= KISS_MIN_ROMANCE)) return 0;
  if (ctx.kissedToday) return 0;
  for (const p of [initiator, receiver]) {
    if (p.states.some((s) => KISS_BLOCKING_STATES.includes(s))) return 0;
  }

  let chance = ctx.kissedBefore ? KISSED_BEFORE_CHANCE : FIRST_KISS_CHANCE;
  if (ctx.isDate) chance *= DATE_FACTOR;
  if (ctx.romanceBoost) chance *= ROMANCE_BOOST_FACTOR;
  if (ctx.thirdPresent && !(initiator.impulsiveness > BOLD_IMPULSIVENESS)) chance *= PRIVACY_FACTOR;
  return Math.min(1, chance);
}

// ─── The listener ────────────────────────────────────────────────────────────

/** The fields of `conversation:ended` this reads (conversations.ts emits many more). */
export interface KissConversationEnded {
  agentId: number;
  perpetratorId?: number | null;
  conversationId?: number;
  sentiment?: number;
}

type AgentRow = typeof agents.$inferSelect;
type RelRow = typeof relationships.$inferSelect;

const day = (minute: number): number => Math.floor(minute / MINUTES_PER_DAY);

function hourOf(minute: number): number {
  return Math.floor((minute % MINUTES_PER_DAY) / 60);
}

function romanceToward(rel: RelRow, from: number): number {
  return from === rel.agent_a ? rel.romance_ab : rel.romance_ba;
}

function romanceBoostActive(): boolean {
  const active = db.select({ effects: worldEvents.effects }).from(worldEvents).where(eq(worldEvents.is_active, true)).all();
  return aggregateEventEffects(active.map((e) => e.effects)).romance_boost > 0;
}

function partyOf(row: AgentRow, rel: RelRow): KissParty {
  const personality = getEffectivePersonality(row.id) ?? (row.personality as { impulsiveness?: number } | null);
  return {
    id: row.id, age: row.age, gender: row.gender, orientation: row.orientation, is_active: row.is_active,
    romance: romanceToward(rel, row.id),
    impulsiveness: personality?.impulsiveness ?? 50,
    states: getAgentStates(row.id),
  };
}

/** Whether `initiator` was already turned away by `target` within the last game day. */
function rebuffedRecently(initiatorId: number, targetId: number, now: number): boolean {
  return db.select({ id: activityLog.id }).from(activityLog)
    .where(and(
      eq(activityLog.type, 'kiss_rebuffed'),
      eq(activityLog.initiator_id, initiatorId),
      eq(activityLog.target_id, targetId),
      gte(activityLog.game_minute, now - MINUTES_PER_DAY),
    ))
    .limit(1).get() !== undefined;
}

/**
 * Whether the conversation was between exactly these two. A kiss is a private
 * gesture between two people: a group chat (the event fires for each of its
 * participants, with the first of the others as `perpetratorId`) is never the
 * moment. A conversation the DB has no row for (an id from nowhere) is not
 * blocked: every real conversation, template tier included, has a row.
 */
function isTwoPersonConversation(conversationId: number): boolean {
  const row = db.select({ participants: conversations.participants }).from(conversations)
    .where(eq(conversations.id, conversationId)).get();
  return !row || row.participants.length === 2;
}

/**
 * A warm conversation just ended: maybe they kiss. `rng` is injectable so the
 * tests can force either outcome; a chance of 0 (a minor, a straight same-sex
 * pair) never passes, whatever it returns.
 */
export function onKissConversationEnded(p: KissConversationEnded, rng: () => number = Math.random): void {
  const otherId = p.perpetratorId;
  if (otherId == null || otherId === p.agentId) return;
  // Cheap exit first: this runs for every conversation in town.
  if (!((p.sentiment ?? 0) > KISS_MIN_SENTIMENT)) return;
  if (p.conversationId != null && !isTwoPersonConversation(p.conversationId)) return;

  const rel = pairRelationship(p.agentId, otherId);
  if (!rel) return;
  const rows = db.select().from(agents).where(inArray(agents.id, [p.agentId, otherId])).all();
  const first = rows.find((r) => r.id === p.agentId);
  const second = rows.find((r) => r.id === otherId);
  if (!first || !second) return;

  const { initiator, receiver } = pickKissInitiator(partyOf(first, rel), partyOf(second, rel));
  // The event fires once per participant; only the one who would lean in acts.
  if (p.agentId !== initiator.id) return;

  const initRow = initiator.id === first.id ? first : second;
  const recvRow = initiator.id === first.id ? second : first;
  const now = gameMinutesNow();
  const pair = getPairIntimacy(initiator.id, receiver.id);
  const witnessIds = witnessesOf(initRow, recvRow);

  const chance = kissChance({
    initiator, receiver,
    sentiment: p.sentiment ?? 0,
    kissedBefore: rel.tags.includes(KISSED_TAG),
    isDate: isDateHour(hourOf(now)) && receiver.romance > REBUFF_BELOW_ROMANCE,
    romanceBoost: romanceBoostActive(),
    thirdPresent: witnessIds.length > 0,
    kissedToday: pair?.lastKissAt != null && day(pair.lastKissAt) === day(now),
  });
  if (chance <= 0) return;

  const rebuff = receiver.romance < REBUFF_BELOW_ROMANCE;
  // A refused suitor does not try again the same day (each try would cost the pair -5 romance).
  if (rebuff && rebuffedRecently(initiator.id, receiver.id, now)) return;
  if (!(rng() < chance)) return;

  if (rebuff) rebuffKiss(initRow, recvRow, now);
  else shareKiss(rel, initRow, recvRow, witnessIds, now);
}

function rebuffKiss(initiator: AgentRow, receiver: AgentRow, now: number): void {
  insertPairEvent(initiator.id, receiver.id, 'kiss_rebuffed',
    `${receiver.name} turned away from ${initiator.name}'s kiss`,
    { friendshipFrom: -1, friendshipTo: 0, romanceFrom: REBUFF_ROMANCE, romanceTo: REBUFF_ROMANCE }, -0.4);
  addMoodModifier(initiator.id, REBUFF_MOOD, 'kiss_rebuffed', REBUFF_MOOD_MINUTES, now);

  logActivity({
    type: 'kiss_rebuffed',
    initiator: initiator.id,
    target: receiver.id,
    ...(initiator.current_location != null ? { location: initiator.current_location } : {}),
    templateData: { agent1: initiator.name, agent2: receiver.name },
    metadata: { beat: 'kiss_rebuffed' },
  });
  simEvents.emit('life:milestone', {
    agentId: initiator.id,
    description: `I tried to kiss ${receiver.name}, and they turned away.`,
    valence: -0.6, importance: 6, relatedAgentId: receiver.id,
  });
}

function shareKiss(rel: RelRow, initiator: AgentRow, receiver: AgentRow, witnessIds: number[], now: number): void {
  const firstTime = !rel.tags.includes(KISSED_TAG) && getPairIntimacy(initiator.id, receiver.id)?.firstKissAt == null;

  if (!rel.tags.includes(KISSED_TAG)) {
    db.update(relationships).set({ tags: [...rel.tags, KISSED_TAG] }).where(eq(relationships.id, rel.id)).run();
  }
  // A first kiss is a pivotal, permanent beat; later ones are routine (storyBeats.ts ROMANTIC_EVENTS).
  insertPairEvent(initiator.id, receiver.id, firstTime ? 'first_kiss' : 'kiss',
    firstTime ? `${initiator.name} and ${receiver.name} shared a first kiss` : `${initiator.name} and ${receiver.name} kissed`,
    firstTime
      ? { friendshipFrom: 2, friendshipTo: 2, romanceFrom: 6, romanceTo: 6, trustFrom: 2, trustTo: 2 }
      : { friendshipFrom: 1, friendshipTo: 1, romanceFrom: 2, romanceTo: 2 },
    firstTime ? 0.8 : 0.5);

  updatePairIntimacy(initiator.id, receiver.id, (s) => {
    s.kisses += 1;
    s.lastKissAt = now;
    if (s.firstKissAt == null) s.firstKissAt = now;
  });
  for (const id of [initiator.id, receiver.id]) relieveLonging(id, 10);

  logActivity({
    type: firstTime ? 'first_kiss' : 'kiss',
    initiator: initiator.id,
    target: receiver.id,
    ...(initiator.current_location != null ? { location: initiator.current_location } : {}),
    templateData: { agent1: initiator.name, agent2: receiver.name },
    metadata: { beat: 'kiss' },
  });

  if (firstTime) {
    simEvents.emit('life:milestone', {
      agentId: initiator.id, description: `I kissed ${receiver.name} for the first time.`,
      valence: 0.9, importance: 7, relatedAgentId: receiver.id,
    });
    simEvents.emit('life:milestone', {
      agentId: receiver.id, description: `I kissed ${initiator.name} for the first time.`,
      valence: 0.9, importance: 7, relatedAgentId: initiator.id,
    });
  }

  seedAffair(initiator.id, receiver.id, witnessIds);
  simEvents.emit('intimacy:kiss', { a: initiator.id, b: receiver.id, first: firstTime, witnessIds });
}

/**
 * A kiss with someone else's fiancé, wife or husband is the seed of an affair
 * secret. Known to the two and to whoever saw. Subject is the one who is
 * spoken for (the lower id when both are), so a repeat from the other side
 * lands on the same fact instead of minting a mirror image. `createFact` raises
 * the sensitivity itself when a marriage is betrayed (`affairSensitivity`).
 */
function seedAffair(a: number, b: number, witnessIds: number[]): void {
  const aTaken = isSpokenFor(a, b);
  const bTaken = isSpokenFor(b, a);
  if (!aTaken && !bTaken) return;
  const subject = aTaken && bTaken ? Math.min(a, b) : aTaken ? a : b;
  const target = subject === a ? b : a;
  learnFact('affair', subject, target, 3, [a, b, ...witnessIds], 'observed');
}

// ─── Seen ────────────────────────────────────────────────────────────────────

/** A kiss nobody minds: two people who are openly a couple are not news. */
const KISS_SEEN_SENSITIVITY = 2;
/** ... or one that is scandalous because one of them is engaged or married to someone else. */
const KISS_SEEN_SPOKEN_FOR_SENSITIVITY = 3;

export interface IntimacyKissPayload {
  a: number;
  b: number;
  first: boolean;
  witnessIds: number[];
}

/**
 * Whether the two are openly together: partners, engaged or married to each
 * other. Someone who is spoken for to a THIRD person is not openly anyone's,
 * even when their row with the kisser says partners: a couple that has to
 * hide behind a marriage elsewhere is exactly what a witness remembers.
 */
export function isOpenCouple(a: number, b: number): boolean {
  const rel = pairRelationship(a, b);
  if (!rel) return false;
  const together = rel.status === 'partners' || rel.tags.some((t) => MILESTONE_TAGS.includes(t));
  return together && !isSpokenFor(a, b) && !isSpokenFor(b, a);
}

/**
 * Sensitivity of "X was seen kissing Y": 2, 3 when either is engaged or
 * married to somebody else, 4 when a marriage is betrayed (the same step
 * `affairSensitivity` gives an affair secret).
 */
export function kissSeenSensitivity(a: number, b: number): number {
  const spokenFor = isSpokenFor(a, b) || isSpokenFor(b, a);
  return affairSensitivity(
    spokenFor ? KISS_SEEN_SPOKEN_FOR_SENSITIVITY : KISS_SEEN_SENSITIVITY,
    affairInvolvesMarriage(a, b),
  );
}

/**
 * Whoever saw a kiss between two people who are not openly together learns it as
 * a `kiss_seen` secret: "create or add knowers", so a second sighting of the same
 * pair by someone new is not lost. The two are not knowers (they do not know they
 * were seen) and never gossip about it (`PARTICIPANT_TARGET_TYPES`). An open couple
 * kissing produces nothing: nobody cares. The subject is the lower id so a kiss led
 * by either of them lands on the same fact.
 *
 * Not routed through the WitnessAmplifier: that one reacts to `interaction:completed`
 * and friends, and a kiss is not one; creating the fact here as well would double it.
 */
export function witnessKiss(p: IntimacyKissPayload): void {
  if (p.witnessIds.length === 0) return;
  if (isOpenCouple(p.a, p.b)) return;
  learnFact('kiss_seen', Math.min(p.a, p.b), Math.max(p.a, p.b), kissSeenSensitivity(p.a, p.b), p.witnessIds, 'observed');
}

// ─── Registration ────────────────────────────────────────────────────────────

let registered = false;

/** Called once by intimacy/index.ts (importing it registers the listener like the other engines). */
export function registerKissListener(): void {
  if (registered) return;
  registered = true;
  simEvents.on('conversation:ended', (p: KissConversationEnded) => {
    try {
      onKissConversationEnded(p);
    } catch (err) {
      // A listener runs inside the emitting phase: a failed kiss must never take
      // the conversation's own bookkeeping down with it.
      console.warn('[intimacy] kiss failed:', (err as Error).message);
    }
  });
  simEvents.on('intimacy:kiss', (p: IntimacyKissPayload) => {
    try {
      witnessKiss(p);
    } catch (err) {
      console.warn('[intimacy] witnessing a kiss failed:', (err as Error).message);
    }
  });
}
