import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import { agentStates, agents, conversationQueue, conversations, relationships, shared_knowledge } from '../../db/schema';
import { SUSPICION_TOPIC } from '../../ai/prompts';
import { emitter } from '../../engine/emitter';
import { logActivity } from '../activityLogger';
import { queueMaxWait } from '../conversationPacing';
import { applyAffairFallout, insertPairEvent, pairRelationship } from '../conversationBeats';
import { MINUTES_PER_DAY, gameMinutes, type ClockTime } from '../gameClock';
import { PROPOSAL_QUEUE_PRIORITY } from '../milestonesEngine';
import { simEvents } from '../simEvents';
import { getAgentStates, getEffectivePersonality } from '../states';
import { clamp } from '../utils';
import { isAdultContent } from '../worldRules';
import { gameMinutesNow } from '../worldClock';
import { giveState } from './aftermath';
import { isIntimacyEligible } from './eligibility';
import {
  forEachAgentIntimacy, getAgentIntimacy, getSuspicionProcessedDay, setSuspicionProcessedDay, updateAgentIntimacy,
} from './state';

// ─── Suspicion: an empty bed, noticed ────────────────────────────────────────
//
// Adult layer only (the rule on, and only for a couple of two adults, the same
// `isIntimacyEligible` gate as everything intimate). Once each game morning the
// town's partners look at the other side of the bed:
//
//   a guest spent the night in somebody else's home (tryst.ts records it on
//   `AgentIntimacy.awayNight` when the evening ends and they stay) ─▶ every
//   partner of theirs who shares their home, and is not the host, and does not
//   already know why, suspects: +1, and +1 more when the guest is still glowing
//   and the one who notices is the curious sort (curiosity > 60)
//        │  a partner who lives elsewhere sees no empty bed and suspects nothing
//        ▼
//   suspicion >= 2 ─▶ the `suspicious` state (targeting the partner) and a queued
//   `llm_deep` conversation on SUSPICION_TOPIC, opened by the suspicious one
//        ├─ it ended badly (sentiment well below zero) ─▶ the suspicion is taken as
//        │     true: the same fallout as discovering an affair (conversationBeats
//        │     `applyAffairFallout`: rage and a breakup, forgiveness at a price,
//        │     or a quiet parting, by character)
//        └─ otherwise ─▶ trust −10 and the suspicion eases to 1 (one more night
//              away and it is back at 2)
//
// Learning a real fact about the partner (an `affair` or a `tryst_seen`) resets it:
// it is knowledge now, not suspicion. The reset is checked on the morning pass (a
// witness learns by `known_by`, which emits nothing) and at once on `gossip:learned`.

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** The pass runs on the first tick from this hour of each game day. */
export const SUSPICION_MORNING_HOUR = 7;
/** A night this old is not "last night" any more (the noon before the morning, 19 h at most). */
export const AWAY_NIGHT_WINDOW_MINUTES = 19 * 60;
/** From this much the partner is confronted. */
export const SUSPICION_THRESHOLD = 2;
/** The one who notices is this curious (or more) to read the glow on a partner's face. */
export const NOTICING_CURIOSITY_ABOVE = 60;
/** How long the suspicious state lasts if nothing settles it. */
export const SUSPICIOUS_MINUTES = 2 * MINUTES_PER_DAY;
/** How long the queued confrontation waits for the two to be together. */
export const CONFRONTATION_WAIT_MINUTES = 6 * 60;
/** A confrontation that ended this badly (or worse) is taken as proof. */
export const FIGHT_SENTIMENT = -0.4;
/** Trust lost by the one who asked and was not put at ease. */
export const DISTRUST_TRUST = -10;
/** Where suspicion stands after a talk that did not settle it. */
export const SUSPICION_AFTER_TALK = 1;
export const SUSPICION_TRIGGER = 'suspicion';

type AgentRow = typeof agents.$inferSelect;

const remember = (agentId: number, description: string, valence: number, importance: number, relatedAgentId: number): void => {
  simEvents.emit('life:milestone', { agentId, description, valence, importance, relatedAgentId });
};

// ─── Knowing ─────────────────────────────────────────────────────────────────

/**
 * Whether `observerId` already knows something real about `partnerId`: an active
 * `affair` or `tryst_seen` fact with them in it, that the observer is a knower of
 * (and not themselves a party to: a fact about their own tryst with the partner is
 * not a betrayal by the partner, the same rule `reactToPartnerAffair` applies).
 */
function knowsOfPartner(observerId: number, partnerId: number): boolean {
  return db.select().from(shared_knowledge)
    .where(and(
      inArray(shared_knowledge.type, ['affair', 'tryst_seen']),
      eq(shared_knowledge.is_active, true),
      or(eq(shared_knowledge.subject_id, partnerId), eq(shared_knowledge.target_id, partnerId)),
    )).all()
    .some((f) => f.subject_id !== observerId && f.target_id !== observerId && (f.known_by as number[]).includes(observerId));
}

const suspiciousOf = (observerId: number, partnerId: number) =>
  db.select({ id: agentStates.id }).from(agentStates)
    .where(and(eq(agentStates.agent_id, observerId), eq(agentStates.type, 'suspicious'), eq(agentStates.target_agent_id, partnerId)))
    .get() !== undefined;

/** Suspicion of `partnerId` is over: the number and the state that carried it. */
export function clearSuspicion(observerId: number, partnerId: number): boolean {
  const had = getAgentIntimacy(observerId)?.suspicion[partnerId] != null;
  if (had) updateAgentIntimacy(observerId, (a) => { delete a.suspicion[partnerId]; });
  const held = db.select({ id: agentStates.id }).from(agentStates)
    .where(and(eq(agentStates.agent_id, observerId), eq(agentStates.type, 'suspicious'), eq(agentStates.target_agent_id, partnerId)))
    .all();
  if (held.length > 0) {
    db.delete(agentStates).where(inArray(agentStates.id, held.map((s) => s.id))).run();
  }
  return had || held.length > 0;
}

// ─── The morning pass ────────────────────────────────────────────────────────

/** Living partners of `agentId` (relationship status `partners`, engaged and married included). */
function partnersOf(agentId: number): number[] {
  return db.select({ a: relationships.agent_a, b: relationships.agent_b }).from(relationships)
    .where(and(eq(relationships.status, 'partners'), or(eq(relationships.agent_a, agentId), eq(relationships.agent_b, agentId))))
    .all().map((r) => (r.a === agentId ? r.b : r.a));
}

/** The asker's trust in the partner and the traits that colour how a template-tier confrontation goes. */
function askerTraits(observer: AgentRow, rel: NonNullable<ReturnType<typeof pairRelationship>>): { trust: number; aggression: number; loyalty: number } {
  const personality = getEffectivePersonality(observer.id) ?? (observer.personality as Partial<Record<string, number>> | null);
  return {
    trust: observer.id === rel.agent_a ? rel.trust_ab : rel.trust_ba,
    aggression: personality?.aggression ?? 30,
    loyalty: personality?.loyalty ?? 50,
  };
}

const rowsOf = (ids: number[]): Map<number, AgentRow> =>
  new Map(db.select().from(agents).where(inArray(agents.id, ids)).all().map((r) => [r.id, r]));

/** Count last night's empty beds. Each recorded night is consumed: one absence counts once. */
function noticeEmptyBeds(now: number): boolean {
  const nights: Array<[number, { since: number; hostId: number }]> = [];
  forEachAgentIntimacy((id, a) => { if (a.awayNight) nights.push([id, a.awayNight]); });
  let changed = false;
  for (const [guestId, night] of nights) {
    updateAgentIntimacy(guestId, (a) => { delete a.awayNight; });
    changed = true;
    // A night from before this morning's window (a pass that never came) is not last night.
    if (night.since > now || now - night.since > AWAY_NIGHT_WINDOW_MINUTES) continue;

    const partners = partnersOf(guestId).filter((id) => id !== night.hostId);
    if (partners.length === 0) continue;
    const rows = rowsOf([guestId, ...partners]);
    const guest = rows.get(guestId);
    if (!guest) continue;
    const glowing = getAgentStates(guestId).includes('afterglow');

    for (const partnerId of partners) {
      const observer = rows.get(partnerId);
      // Somebody who is not both an adult and in town, or who lives elsewhere (there is no
      // empty bed to see), or who already knows the truth, has nothing to suspect.
      if (!observer || !isIntimacyEligible(observer, guest) || observer.home !== guest.home) continue;
      if (knowsOfPartner(partnerId, guestId)) continue;
      const curiosity = (getEffectivePersonality(partnerId) ?? (observer.personality as { curiosity?: number } | null))?.curiosity ?? 50;
      const gain = 1 + (glowing && curiosity > NOTICING_CURIOSITY_ABOVE ? 1 : 0);
      updateAgentIntimacy(partnerId, (a) => { a.suspicion[guestId] = clamp((a.suspicion[guestId] ?? 0) + gain, 0, 100); });
    }
  }
  return changed;
}

/** Whoever now knows the real thing about the partner they doubted stops doubting. */
function settleWhatIsKnown(): boolean {
  const doubts: Array<[number, number]> = [];
  forEachAgentIntimacy((id, a) => { for (const partner of Object.keys(a.suspicion)) doubts.push([id, Number(partner)]); });
  let changed = false;
  for (const [observerId, partnerId] of doubts) {
    if (knowsOfPartner(observerId, partnerId) && clearSuspicion(observerId, partnerId)) changed = true;
  }
  return changed;
}

function confrontationQueued(a: number, b: number): boolean {
  return db.select({ participants: conversationQueue.participants }).from(conversationQueue)
    .where(eq(conversationQueue.trigger_reason, SUSPICION_TRIGGER)).all()
    .some((q) => q.participants.includes(a) && q.participants.includes(b));
}

/** Enough suspicion: the state, and the conversation the suspicious one opens. */
function confrontTheSuspected(now: number): boolean {
  const doubts: Array<[number, number]> = [];
  forEachAgentIntimacy((id, a) => {
    for (const [partner, level] of Object.entries(a.suspicion)) if (level >= SUSPICION_THRESHOLD) doubts.push([id, Number(partner)]);
  });
  let changed = false;
  for (const [observerId, partnerId] of doubts) {
    const rows = rowsOf([observerId, partnerId]);
    const observer = rows.get(observerId);
    const partner = rows.get(partnerId);
    const rel = pairRelationship(observerId, partnerId);
    // The pair broke up, somebody is gone: nothing left to be suspicious of.
    if (!observer || !partner || rel?.status !== 'partners' || !isIntimacyEligible(observer, partner)) {
      changed = clearSuspicion(observerId, partnerId) || changed;
      continue;
    }
    if (!suspiciousOf(observerId, partnerId)) { giveState(observerId, 'suspicious', partnerId, SUSPICIOUS_MINUTES, now, 'intimacy:suspicion'); changed = true; }
    if (!confrontationQueued(observerId, partnerId)) {
      db.insert(conversationQueue).values({
        // The suspicious one first: participants[0] opens, and the topic's intent is theirs. Protected
        // (like a proposal) so it waits for the two to be in the same place instead of being dropped.
        participants: [observerId, partnerId],
        tier: 'llm_deep',
        priority: PROPOSAL_QUEUE_PRIORITY,
        trigger_reason: SUSPICION_TRIGGER,
        topic: SUSPICION_TOPIC,
        queued_at: Date.now(), // wall-clock ms, like every producer
        max_wait: queueMaxWait(CONFRONTATION_WAIT_MINUTES),
      }).run();
      changed = true;
    }
  }
  return changed;
}

/**
 * The rule went off: everything this layer had in flight stops. The confrontation
 * still waiting in the queue would otherwise open a conversation about nights away
 * that the world no longer models, the `suspicious` states would keep colouring
 * dialogue, and the counters would resume from where they were when it goes back on.
 * Idempotent and cheap (two deletes and a walk over in-memory counters), so it simply
 * runs on every pass while the rule is off. True when anything was removed.
 */
function standDown(): boolean {
  let changed = false;
  forEachAgentIntimacy((id, a) => {
    if (Object.keys(a.suspicion).length > 0 || a.awayNight) {
      updateAgentIntimacy(id, (s) => { s.suspicion = {}; delete s.awayNight; });
      changed = true;
    }
  });
  if (db.delete(conversationQueue).where(eq(conversationQueue.trigger_reason, SUSPICION_TRIGGER)).run().changes > 0) changed = true;
  if (db.delete(agentStates).where(eq(agentStates.type, 'suspicious')).run().changes > 0) changed = true;
  return changed;
}

/**
 * Once per game morning (game time: the first pass from 7 h of each day, never a tick
 * count), from `intimacyTick`. With the rule off it only stands down (`standDown`); the
 * day is not spent then, so turning the rule on mid-morning still gets that morning's pass.
 */
export function suspicionPass(time: ClockTime): void {
  if (!isAdultContent()) {
    if (standDown()) emitter.markDirty('agents.all');
    return;
  }
  const now = gameMinutes(time);
  const today = Math.floor(now / MINUTES_PER_DAY);
  if (time.hour < SUSPICION_MORNING_HOUR || getSuspicionProcessedDay() === today) return;
  setSuspicionProcessedDay(today);

  const settled = settleWhatIsKnown();
  const noticed = noticeEmptyBeds(now);
  const confronted = confrontTheSuspected(now);
  if (settled || noticed || confronted) emitter.markDirty('agents.all');
}

// ─── The confrontation's outcome ─────────────────────────────────────────────

/** The fields of `conversation:ended` this reads (conversations.ts emits many more). */
export interface SuspicionConversationEnded {
  agentId: number;
  perpetratorId?: number | null;
  conversationId?: number;
  /** The template tier's emit sets it (the LLM was off, or no slot came free in time). */
  template?: boolean;
  /** The queue entry's trigger_reason (the template tier's emit carries it: its `summary` is a script topic). */
  triggerReason?: string;
  /** The conversation's topic. */
  summary?: string;
  sentiment?: number;
}

/**
 * How a confrontation that fell to the template tier is settled, as the sentiment the LLM
 * tier would have produced (compared with FIGHT_SENTIMENT below). A canned script says nothing
 * about the empty bed, so the asker's own character decides how it went, from three traits:
 *
 *   sentiment = 0.3 - 0.7 * doubt - 0.6 * temper + 0.3 * faith
 *
 * with doubt = 1 - trust in the partner (0..1), temper = aggression / 100 and faith =
 * loyalty / 100 (a loyal person gives the benefit of the doubt). A calm asker who trusts
 * their partner (trust 70, aggression 30, loyalty 50) lands at +0.06: an uneasy talk, trust
 * -10, suspicion back to 1. A distrustful hot-tempered one (trust 20, aggression 85) lands
 * near -0.7 and takes the suspicion as proven. The fight line (-0.4) is crossed only by the
 * distrustful AND quick to anger, so most template confrontations end quietly, as most
 * of the LLM ones do. Pure.
 */
export function templateConfrontationSentiment(asker: { trust: number; aggression: number; loyalty: number }): number {
  const doubt = 1 - clamp(asker.trust, 0, 100) / 100;
  const temper = clamp(asker.aggression, 0, 100) / 100;
  const faith = clamp(asker.loyalty, 0, 100) / 100;
  return 0.3 - 0.7 * doubt - 0.6 * temper + 0.3 * faith;
}

/**
 * The confrontation ended. `conversation:ended` fires once per participant, so this acts
 * only on the copy of the one who opened it (`participants[0]`, the suspicious one) and
 * only while their `suspicious` state toward the other is still there: settling it
 * removes the state, so the same conversation is settled once (A6; no id set to go
 * stale across a world replace). A template chat that was the queued confrontation (the
 * queue's fallback: no LLM, or a slot busy past the wait) is settled by the asker's character
 * (`templateConfrontationSentiment`), as a proposal is; before that it settled nothing, and the
 * confrontation was queued again every morning without ever ending.
 */
export function onSuspicionConversationEnded(p: SuspicionConversationEnded): void {
  const isTemplate = p.template === true;
  if (isTemplate ? p.triggerReason !== SUSPICION_TRIGGER && p.summary !== SUSPICION_TOPIC : p.summary !== SUSPICION_TOPIC) return;
  const partnerId = p.perpetratorId;
  if (partnerId == null || partnerId === p.agentId) return;
  if (!isAdultContent()) return;
  if (!suspiciousOf(p.agentId, partnerId)) return;
  if (p.conversationId != null) {
    const row = db.select({ participants: conversations.participants }).from(conversations)
      .where(eq(conversations.id, p.conversationId)).get();
    if (row && row.participants[0] !== p.agentId) return;
  }

  const rows = rowsOf([p.agentId, partnerId]);
  const observer = rows.get(p.agentId);
  const partner = rows.get(partnerId);
  const rel = pairRelationship(p.agentId, partnerId);
  if (!observer || !partner || rel?.status !== 'partners') {
    clearSuspicion(p.agentId, partnerId);
    return;
  }
  const now = gameMinutesNow();
  const sentiment = isTemplate ? templateConfrontationSentiment(askerTraits(observer, rel)) : (p.sentiment ?? 0);

  // It went so badly that whatever was suspected is now believed: the same fallout as finding out
  // (the discoverer's memory and the pair's chronicle beat are applyAffairFallout's own).
  if (sentiment <= FIGHT_SENTIMENT
    && applyAffairFallout(observer, partner, rel, now,
      `${observer.name} confronted ${partner.name} about the nights spent away from home, and broke up!`)) {
    remember(partner.id, `${observer.name} confronted me about my nights away, and it ended between us.`, -0.8, 8, observer.id);
    clearSuspicion(p.agentId, partnerId);
    emitter.markDirty('agents.all');
    return;
  }

  // Not put at ease, not proven either: trust suffers, and one more night away brings it back.
  insertPairEvent(observer.id, partner.id, 'suspicion',
    `${observer.name} asked ${partner.name} where they had been at night`,
    { friendshipFrom: 0, friendshipTo: 0, trustFrom: DISTRUST_TRUST }, -0.3);
  // A scene in the feed (a toast for a favourite, never the paper) and a memory each: the asker was not
  // put at ease, the asked did not tell the truth.
  logActivity({
    type: 'suspicion',
    initiator: observer.id,
    target: partner.id,
    templateData: { agent1: observer.name, agent2: partner.name },
  });
  remember(observer.id, `I asked ${partner.name} where they had been at night, and I was not put at ease.`, -0.5, 6, partner.id);
  remember(partner.id, `${observer.name} asked me where I had been at night. I did not tell the truth.`, -0.4, 6, observer.id);
  updateAgentIntimacy(observer.id, (a) => { a.suspicion[partner.id] = SUSPICION_AFTER_TALK; });
  db.delete(agentStates)
    .where(and(eq(agentStates.agent_id, observer.id), eq(agentStates.type, 'suspicious'), eq(agentStates.target_agent_id, partner.id)))
    .run();
  emitter.markDirty('agents.all');
}

// ─── Registration ────────────────────────────────────────────────────────────

/** Fields of `gossip:learned` (gossip.ts) this reads. */
interface GossipLearned {
  agentId: number;
  factType?: string;
  factId?: number;
}

/** Someone just learnt a fact: if it is a real one about a partner they doubted, they doubt no more. */
function onGossipLearned(p: GossipLearned): void {
  if (p.factId == null || (p.factType !== 'affair' && p.factType !== 'tryst_seen')) return;
  const doubts = Object.keys(getAgentIntimacy(p.agentId)?.suspicion ?? {}).map(Number);
  if (doubts.length === 0) return;
  const fact = db.select().from(shared_knowledge).where(eq(shared_knowledge.id, p.factId)).get();
  if (!fact || fact.subject_id === p.agentId || fact.target_id === p.agentId) return;
  for (const partnerId of doubts) {
    if (fact.subject_id === partnerId || fact.target_id === partnerId) clearSuspicion(p.agentId, partnerId);
  }
}

let registered = false;

/** Called once by intimacy/index.ts (importing it registers the listeners like the other engines). */
export function registerSuspicionListeners(): void {
  if (registered) return;
  registered = true;
  simEvents.on('conversation:ended', (p: SuspicionConversationEnded) => {
    try {
      onSuspicionConversationEnded(p);
    } catch (err) {
      console.warn('[intimacy] suspicion outcome failed:', (err as Error).message);
    }
  });
  simEvents.on('gossip:learned', (p: GossipLearned) => {
    try {
      onGossipLearned(p);
    } catch (err) {
      console.warn('[intimacy] suspicion reset failed:', (err as Error).message);
    }
  });
}
