import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db';
import {
  agents, conversationQueue, locations, needs, relationshipEvents, relationships, shared_knowledge, worldEvents,
} from '../db/schema';
import { CONFIG } from './constants';
import { simEvents } from './simEvents';
import { logActivity } from './activityLogger';
import { createFact } from './gossip';
import { getAgentStates } from './states';
import { gameMinutesNow } from './worldClock';
import { queueMaxWait } from './conversationPacing';
import { clamp, pairKey } from './utils';
import { startWorldEvent } from '../engine/systems/events';
import { emitter } from '../engine/emitter';
import { PROPOSAL_TOPIC } from '../ai/prompts';
import { isFallbackMessage } from '../ai/sanitizeDialogue';
import {
  ENGAGED_TAG, MARRIED_AFFAIR_SENSITIVITY, MARRIED_TAG, isSpokenFor, weddingTriggeredBy,
} from './marriage';
import { asNumber, asRecord, type SnapshotStore } from '../engine/snapshotCodec';
import { rehomeCouple } from './residents';
import type { PersonalityProfile } from './personality';
import type { ClockTime } from './gameClock';

// ─── Life milestones: proposals, engagements, weddings ───────────────────────
//
// `partners` used to be the top of the ladder: a couple could be together for
// a month of game time and nothing would ever happen to them, while "Wedding
// Celebration" was a random world event with nobody at the altar (STATUS C13).
// This module gives real couples a next step:
//
//   partners for a few game days ──▶ proposal (an llm_deep conversation)
//        ├─ yes ──▶ `engaged` tag ──▶ ~1 game day later: their wedding
//        │                             (world event on the square, whole town
//        │                             invited) ──▶ sticky `married` tag
//        └─ no ───▶ heartbreak: romance and mood drop, gossip, a long wait
//                   before either tries again
//
// The tags are the durable truth (relationships row, see lib/marriage.ts). The
// timers — who is about to propose, when the engagement began, how long a
// refusal keeps them from trying again — live here in memory and are
// checkpointed to sim_snapshots (worldCaches.ts), so a restart neither loses a
// planned wedding nor lets a refused suitor propose again the next morning.
//
// Side-effect module: importing it registers its `conversation:ended`
// listener (server/index.ts imports it like giftEngine). The periodic pass,
// `milestonesTick`, runs from the tick loop every 10 game minutes.

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** A couple that has everything going for it proposes after this many game days as partners... */
export const PROPOSAL_MIN_DAYS = 4;
/** ...and even a cautious one gets there by this many. */
export const PROPOSAL_MAX_DAYS = 7;
/**
 * After a refusal, neither of them proposes again for this long. The
 * relationship itself usually falls out of `partners` from the romance drop;
 * this covers the couple that stays together anyway.
 */
export const PROPOSAL_RETRY_AFTER_REFUSAL_DAYS = 7;
/**
 * A proposer who has not managed to pop the question this long after deciding
 * to (the two never ended up together and free) gives up for a day and
 * decides again. Keeps a pending proposal from lingering forever.
 *
 * 42 h, not the 18 h it used to be: the only time a couple who keep different
 * hours share is the evening (canSeekPartner rules out shifts and bed hours), and
 * a decision taken at 23:00 expired at 17:00 the next day, just before the 19-22
 * window, so the proposer gave up having never had a real chance. 42 h always
 * spans two full evenings whatever the hour of the decision.
 */
export const PROPOSAL_PENDING_MINUTES = 42 * 60;
/** How long the queued conversation may wait for a slot, in game minutes. */
export const PROPOSAL_QUEUE_WAIT_MINUTES = 60;
/**
 * Queue priority. At the protected level (conversations.ts `isProtectedEntry`)
 * on purpose: hunger must not walk someone out between the question and the
 * answer, and a slot-starved scheduler should seat this before small talk.
 */
export const PROPOSAL_QUEUE_PRIORITY = CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY - 5;
/** Engaged couples marry about a game day later... */
export const WEDDING_DELAY_MINUTES = 24 * 60;
/**
 * ...at the first daytime hour after that. A six-hour event started at 16:00
 * ends at 22:00, when the town goes to bed; a wedding at 03:00 would be
 * attended by nobody.
 */
export const WEDDING_FIRST_HOUR = 10;
export const WEDDING_LAST_START_HOUR = 16;
/** Two agents this close (px) may talk even outside a building; same bound as the scheduler. */
const TALK_RANGE_PX = 64;
const ADULT_AGE = 18;
/**
 * A shotgun proposal (an unwed father asked to do right by her, `queueShotgunProposal`) is
 * not the couple's own idea and cannot wait a game day to be re-decided: it stays pending
 * this long, then is given up (the pregnancy's scandal path takes over).
 */
const SHOTGUN_PENDING_MINUTES = 2 * 24 * 60;
/** States that put a proposal out of the question for now. */
const NOT_NOW_STATES = new Set(['heartbroken', 'depressed', 'arrested', 'grieving', 'sick']);

// ─── Per-pair state ──────────────────────────────────────────────────────────

export interface PairMilestone {
  /** Set while a proposal is pending: who will ask, and since when (game minutes). */
  proposerId?: number;
  pendingSince?: number;
  /** The `proposal` feed line was written for this pending proposal. */
  announced?: boolean;
  /**
   * The proposal (and the engagement it leads to) was forced by a pregnancy
   * (lib/intimacy/pregnancy.ts), so the pair need not be `partners` for it to stand: the
   * status gates below accept them. Cleared by a refusal, like the rest of the state.
   */
  shotgun?: true;
  /** Game minute the engagement began. */
  engagedAt?: number;
  /** No new proposal before this game minute (after a refusal or an abandoned attempt). */
  retryAfter?: number;
}
// `announced` also rides along on a `retryAfter` entry (an ABANDONED attempt, never a refusal):
// the feed already said "X has something important to ask Y", and saying it again a day later
// for the same unasked question was the bug. The next pending state inherits it.

/** Keyed by `pairKey` (lower id first). */
const pairs = new Map<string, PairMilestone>();

/** Read-only view for tests and diagnostics. */
export function getPairMilestone(a: number, b: number): Readonly<PairMilestone> | undefined {
  return pairs.get(pairKey(a, b));
}

/** Drop every pair's timers (world replace: agent ids are reused). */
export function clearMilestones(): void {
  pairs.clear();
}

/**
 * Checkpoint: { [pairKey]: PairMilestone }. Always an object (never
 * undefined), so an empty town still overwrites an older world's row.
 */
export const milestonesSnapshotStore: SnapshotStore = {
  key: 'milestones',
  version: 1,
  serialize: () => {
    const out: Record<string, PairMilestone> = {};
    for (const [k, v] of pairs) out[k] = { ...v };
    return out;
  },
  restore: (data) => {
    pairs.clear();
    for (const [k, raw] of Object.entries(asRecord(data) ?? {})) {
      if (!/^\d+-\d+$/.test(k)) continue;
      const r = asRecord(raw);
      if (!r) continue;
      const entry: PairMilestone = {};
      const proposerId = asNumber(r.proposerId);
      const pendingSince = asNumber(r.pendingSince);
      const engagedAt = asNumber(r.engagedAt);
      const retryAfter = asNumber(r.retryAfter);
      if (proposerId !== null && pendingSince !== null) {
        entry.proposerId = proposerId;
        entry.pendingSince = pendingSince;
        if (r.announced === true) entry.announced = true;
      }
      if (engagedAt !== null) entry.engagedAt = engagedAt;
      if (r.shotgun === true && (entry.proposerId != null || entry.engagedAt != null)) entry.shotgun = true;
      if (retryAfter !== null) {
        entry.retryAfter = retryAfter;
        // Older checkpoints have no flag on a retry entry: absent means not announced.
        if (r.announced === true) entry.announced = true;
      }
      if (Object.keys(entry).length > 0) pairs.set(k, entry);
    }
  },
};

// ─── Pure rules (exported for tests) ─────────────────────────────────────────

/**
 * Game days a couple stays `partners` before one of them proposes: between
 * PROPOSAL_MIN_DAYS and PROPOSAL_MAX_DAYS. Faster when the romance runs deep
 * on both sides (`romance` is the LOWER of the two — a couple is as ready as
 * its less keen half), when they trust each other, and when the proposer is
 * impulsive or loyal; a cautious, guarded proposer takes the full week.
 */
export function proposalDelayDays(p: { romance: number; trust: number; impulsiveness: number; loyalty: number }): number {
  // Partners have romance > 65 on the lower side (relationships.ts romanceIsPartnership);
  // readiness counts from 70, so a couple that only just qualified proposes latest.
  const romance = clamp((p.romance - 70) / 30, 0, 1);
  const trust = clamp(p.trust / 100, 0, 1);
  const temperament = clamp((p.impulsiveness * 0.6 + p.loyalty * 0.4) / 100, 0, 1);
  const readiness = romance * 0.4 + trust * 0.3 + temperament * 0.3;
  return PROPOSAL_MAX_DAYS - (PROPOSAL_MAX_DAYS - PROPOSAL_MIN_DAYS) * readiness;
}

interface Suitor { id: number; romanceToward: number; impulsiveness: number }

/** Who asks: the keener and bolder of the two (lower id on a tie, so it is deterministic). */
export function pickProposer(x: Suitor, y: Suitor): number {
  const score = (s: Suitor) => s.romanceToward + s.impulsiveness * 0.5;
  const sx = score(x), sy = score(y);
  if (sx !== sy) return sx > sy ? x.id : y.id;
  return Math.min(x.id, y.id);
}

/** Whether a wedding may start at this hour of the day. */
export function isWeddingHour(hour: number): boolean {
  return hour >= WEDDING_FIRST_HOUR && hour <= WEDDING_LAST_START_HOUR;
}

/**
 * The template-tier answer, and the tiebreak when the words and the mood of an
 * LLM exchange don't settle it: the one being asked says yes when their
 * romance and trust toward the proposer are high enough. Romance weighs more —
 * it is a marriage proposal — but a partner they don't trust gets a no.
 */
export function deterministicAnswer(romance: number, trust: number): boolean {
  return romance * 0.6 + trust * 0.4 >= 55;
}

/** Shared with lib/intimacy/rendezvous.ts (an invitation's answer is read the same way). */
export const YES_WORDS = /\b(yes|i will|i'?d love to|i would love to|of course|a thousand times|gladly|nothing would make me happier)\b/i;
export const NO_WORDS = /\b(no|i can(?:'|no)t|i won'?t|not ready|too soon|forgive me|of course not)\b/i;

export type ProposalOutcomeSource = 'answer' | 'sentiment' | 'relationship';

/**
 * Accepted or refused, and on what grounds:
 *
 * 1. `answer`: the reply of the one being asked says yes or no — and only one
 *    of them ("There's no one I'd rather marry — yes!" has both, and falls
 *    through).
 * 2. `sentiment`: the exchange's overall sentiment, when clearly warm or cold.
 * 3. `relationship`: `deterministicAnswer` on the answerer's feelings. This is
 *    the whole outcome for a template-tier conversation (no answer text, no
 *    meaningful sentiment).
 */
export function proposalOutcome(input: {
  answerText: string | null;
  sentiment: number | null;
  romance: number;
  trust: number;
}): { accepted: boolean; source: ProposalOutcomeSource } {
  const text = input.answerText ?? '';
  if (text) {
    const yes = YES_WORDS.test(text);
    const no = NO_WORDS.test(text);
    if (yes !== no) return { accepted: yes, source: 'answer' };
  }
  if (input.sentiment != null) {
    if (input.sentiment >= 0.15) return { accepted: true, source: 'sentiment' };
    if (input.sentiment <= -0.1) return { accepted: false, source: 'sentiment' };
  }
  return { accepted: deterministicAnswer(input.romance, input.trust), source: 'relationship' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type AgentRow = typeof agents.$inferSelect;
type RelRow = typeof relationships.$inferSelect;

function nameOf(id: number): string {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? `Agent#${id}`;
}

function relBetween(a: number, b: number): RelRow | undefined {
  return db.select().from(relationships)
    .where(and(eq(relationships.agent_a, Math.min(a, b)), eq(relationships.agent_b, Math.max(a, b))))
    .get();
}

/** `from`'s romance and trust toward `to`, read off a normalised row. */
function feelings(rel: RelRow, from: number): { romance: number; trust: number } {
  const isA = rel.agent_a === from;
  return { romance: isA ? rel.romance_ab : rel.romance_ba, trust: isA ? rel.trust_ab : rel.trust_ba };
}

function setTags(relId: number, tags: string[]): void {
  db.update(relationships).set({ tags }).where(eq(relationships.id, relId)).run();
}

function addMood(agentId: number, value: number, source: string, minutes: number, now: number): void {
  const row = db.select().from(needs).where(eq(needs.agent_id, agentId)).get();
  if (!row) return;
  const mods = row.mood_modifiers.filter((m) => m.source !== source);
  mods.push({ source, value, expiresAt: now + minutes });
  db.update(needs).set({ mood_modifiers: mods }).where(eq(needs.id, row.id)).run();
}

function remember(agentId: number, description: string, valence: number, importance: number, related: number): void {
  simEvents.emit('life:milestone', { agentId, description, valence, importance, relatedAgentId: related });
}

function personalityOf(agent: AgentRow): PersonalityProfile | null {
  return (agent.personality as PersonalityProfile | null) ?? null;
}

/** Both awake, neither mid-conversation, and together (same place, or within talking range). */
export function canProposeNow(a: Pick<AgentRow, 'current_action' | 'current_location' | 'position'>,
  b: Pick<AgentRow, 'current_action' | 'current_location' | 'position'>): boolean {
  const busy = (x: typeof a) => {
    const t = ((x.current_action as { type?: string } | null)?.type) ?? 'idle';
    return t === 'sleeping' || t === 'talking' || t === 'dead';
  };
  if (busy(a) || busy(b)) return false;
  if (a.current_location != null && a.current_location === b.current_location) return true;
  const pa = a.position as { x: number; y: number };
  const pb = b.position as { x: number; y: number };
  return Math.hypot(pa.x - pb.x, pa.y - pb.y) <= TALK_RANGE_PX;
}

function proposalQueued(a: number, b: number): boolean {
  return db.select({ participants: conversationQueue.participants }).from(conversationQueue)
    .where(eq(conversationQueue.trigger_reason, 'proposal')).all()
    .some((q) => q.participants.includes(a) && q.participants.includes(b));
}

function dropQueuedProposals(a: number, b: number): void {
  const rows = db.select({ id: conversationQueue.id, participants: conversationQueue.participants })
    .from(conversationQueue).where(eq(conversationQueue.trigger_reason, 'proposal')).all()
    .filter((q) => q.participants.includes(a) && q.participants.includes(b));
  if (rows.length > 0) db.delete(conversationQueue).where(inArray(conversationQueue.id, rows.map((r) => r.id))).run();
}

/** The open area a wedding is held on: the town square first, like the event decor. */
function weddingVenue(): number | null {
  const all = db.select({ id: locations.id, type: locations.type }).from(locations).all();
  for (const type of ['town_square', 'market_square', 'park']) {
    const found = all.filter((l) => l.type === type).sort((x, y) => x.id - y.id)[0];
    if (found) return found.id;
  }
  return null;
}

// ─── The periodic pass ───────────────────────────────────────────────────────

/**
 * Every 10 game minutes (engine/tick.ts): start clocks, decide who proposes,
 * seat the proposal once the two are together, hold weddings that are due,
 * and call off engagements that fell apart.
 */
export function milestonesTick(time: ClockTime, nowMinutes: number): void {
  const agentRows = db.select().from(agents).all();
  const byId = new Map(agentRows.map((a) => [a.id, a]));
  const alive = (id: number) => byId.get(id)?.is_active === true;

  const rels = db.select().from(relationships).all()
    .filter((r) => r.status === 'partners' || r.tags.includes(ENGAGED_TAG) || pairs.get(pairKey(r.agent_a, r.agent_b))?.shotgun === true);
  const seen = new Set<string>();
  let dirty = false;

  for (const rel of rels) {
    const key = pairKey(rel.agent_a, rel.agent_b);
    seen.add(key);
    const a = byId.get(rel.agent_a);
    const b = byId.get(rel.agent_b);
    const engaged = rel.tags.includes(ENGAGED_TAG);
    const married = rel.tags.includes(MARRIED_TAG);
    const shotgun = pairs.get(key)?.shotgun === true;

    // --- Engagements that fell apart ---
    // A shotgun engagement stands on the baby, not on the couple's romance: it survives the
    // pair not being `partners` and ends only with an estrangement or a death.
    const bond = shotgun ? !rel.tags.includes('estranged') : rel.status === 'partners';
    if (engaged && (!bond || !alive(rel.agent_a) || !alive(rel.agent_b))) {
      setTags(rel.id, rel.tags.filter((t) => t !== ENGAGED_TAG));
      pairs.delete(key);
      dirty = true;
      // A death is its own story (the funeral); a breakup is worth a line.
      if (alive(rel.agent_a) && alive(rel.agent_b)) {
        logActivity({
          type: 'engagement_ended',
          agents: [rel.agent_a, rel.agent_b],
          templateData: { description: `${nameOf(rel.agent_a)} and ${nameOf(rel.agent_b)} have called off their engagement.` },
        });
      }
      continue;
    }
    if (!a || !b || !alive(a.id) || !alive(b.id) || married) continue;

    // A pair written before the column existed (or by a writer that doesn't set
    // it): its clock starts now rather than at some guessed past.
    if (rel.status_since_minute == null) {
      db.update(relationships).set({ status_since_minute: nowMinutes }).where(eq(relationships.id, rel.id)).run();
      continue;
    }

    const state = pairs.get(key) ?? {};

    // --- Weddings that are due ---
    if (engaged) {
      if (state.engagedAt == null) {
        // Engaged with no timer (checkpoint older than the engagement): the day starts now.
        pairs.set(key, { engagedAt: nowMinutes });
        continue;
      }
      if (nowMinutes - state.engagedAt >= WEDDING_DELAY_MINUTES && isWeddingHour(time.hour)
        && !weddingBlocked()) {
        if (holdWedding(rel, a, b, nowMinutes)) {
          pairs.delete(key);
          dirty = true;
        }
      }
      continue;
    }

    // --- Proposals ---
    if (state.proposerId != null && state.pendingSince != null) {
      if (nowMinutes - state.pendingSince > (state.shotgun ? SHOTGUN_PENDING_MINUTES : PROPOSAL_PENDING_MINUTES)) {
        // Never managed it: think it over for a day. The flag is kept so the feed does not
        // announce the same unasked question a second time when the pair decides again, and
        // the proposer is left with the memory of having meant to ask.
        pairs.set(key, { retryAfter: nowMinutes + 24 * 60, ...(state.announced ? { announced: true as const } : {}) });
        // A still-queued question would otherwise be asked out of the blue after the pair gave up.
        dropQueuedProposals(a.id, b.id);
        const proposerId = state.proposerId;
        const partnerId = proposerId === a.id ? b.id : a.id;
        remember(proposerId, `I meant to ask ${nameOf(partnerId)} to marry me, but the moment never came.`, -0.2, 5, partnerId);
        dirty = true;
        continue;
      }
      const proposer = state.proposerId === a.id ? a : b;
      const other = proposer === a ? b : a;
      if (!proposalQueued(a.id, b.id) && canProposeNow(proposer, other)) {
        queueProposal(proposer, other, state);
        dirty = true;
      }
      continue;
    }

    if (state.retryAfter != null && nowMinutes < state.retryAfter) continue;
    if (!ready(rel, a, b, nowMinutes)) continue;

    const pa = personalityOf(a), pb = personalityOf(b);
    const proposerId = pickProposer(
      { id: a.id, romanceToward: feelings(rel, a.id).romance, impulsiveness: pa?.impulsiveness ?? 50 },
      { id: b.id, romanceToward: feelings(rel, b.id).romance, impulsiveness: pb?.impulsiveness ?? 50 },
    );
    // Inherits `announced` from an abandoned attempt's retry entry: same question, one feed line.
    const pending: PairMilestone = { proposerId, pendingSince: nowMinutes, ...(state.announced ? { announced: true as const } : {}) };
    pairs.set(key, pending);
    // Already together: no reason to wait for the next pass.
    const proposer = proposerId === a.id ? a : b;
    const other = proposer === a ? b : a;
    if (canProposeNow(proposer, other)) {
      queueProposal(proposer, other, pending);
      dirty = true;
    }
  }

  // Timers of pairs that are no longer a couple (and never became engaged).
  // A refusal's cooldown is kept: the pair may fall back into `partners`.
  for (const [key, state] of pairs) {
    if (seen.has(key)) continue;
    if (state.retryAfter != null && nowMinutes < state.retryAfter && state.proposerId == null && state.engagedAt == null) continue;
    pairs.delete(key);
  }

  if (dirty) emitter.markDirty('agents.all');
}

/** Whether a couple has been together long enough, and is free to take the step. */
function ready(rel: RelRow, a: AgentRow, b: AgentRow, nowMinutes: number): boolean {
  if (rel.status !== 'partners' || rel.tags.includes('estranged')) return false;
  if (a.age < ADULT_AGE || b.age < ADULT_AGE) return false;
  // 1900: two people of the same sex can be lovers and partners (the adult layer allows
  // it), but they cannot marry in this era, and their bond is kept hidden. So no
  // engagement is ever proposed to them: the pair stays `partners`, secret. Gated here,
  // where every proposal starts, and not in the wedding code, so nobody is left
  // half-engaged to something that can never happen.
  if (a.gender === b.gender) return false;
  const since = rel.status_since_minute;
  if (since == null) return false;
  const pa = personalityOf(a), pb = personalityOf(b);
  const days = proposalDelayDays({
    romance: Math.min(rel.romance_ab, rel.romance_ba),
    trust: (rel.trust_ab + rel.trust_ba) / 2,
    // The bolder of the two sets the pace (they are the likely proposer).
    impulsiveness: Math.max(pa?.impulsiveness ?? 50, pb?.impulsiveness ?? 50),
    loyalty: Math.max(pa?.loyalty ?? 50, pb?.loyalty ?? 50),
  });
  if (nowMinutes - since < days * 24 * 60) return false;
  if (isSpokenFor(a.id, b.id) || isSpokenFor(b.id, a.id)) return false;
  for (const id of [a.id, b.id]) {
    if (getAgentStates(id).some((s) => NOT_NOW_STATES.has(s))) return false;
  }
  return true;
}

/** Another couple's wedding still running (one ceremony at a time), or a storm. */
function weddingBlocked(): boolean {
  const active = db.select({ type: worldEvents.type }).from(worldEvents).where(eq(worldEvents.is_active, true)).all();
  return active.some((e) => e.type === 'wedding' || e.type === 'storm');
}

function queueProposal(proposer: AgentRow, other: AgentRow, state: PairMilestone): void {
  db.insert(conversationQueue).values({
    // The proposer first: participants[0] opens the conversation, and the
    // prompt's proposal intent is written for the one who asks.
    participants: [proposer.id, other.id],
    tier: 'llm_deep',
    priority: PROPOSAL_QUEUE_PRIORITY,
    trigger_reason: 'proposal',
    topic: PROPOSAL_TOPIC,
    queued_at: Date.now(), // wall-clock ms, like every producer
    max_wait: queueMaxWait(PROPOSAL_QUEUE_WAIT_MINUTES),
  }).run();
  if (!state.announced) {
    state.announced = true;
    logActivity({
      type: 'proposal',
      initiator: proposer.id,
      target: other.id,
      ...(proposer.current_location != null ? { location: proposer.current_location } : {}),
      templateData: { description: `${proposer.name} has something important to ask ${other.name}.` },
    });
  }
}

// ─── A proposal a baby forces ────────────────────────────────────────────────

/**
 * An unwed father who means to do right by the mother (lib/intimacy/pregnancy.ts) proposes
 * NOW: the 4 to 7 game days of being partners the couple's own proposal waits for are
 * skipped, and so is the `partners` status. Same answer flow as any proposal (an llm_deep
 * conversation, yes leads to the engagement and the wedding a game day later, no goes to the
 * scandal), so this only writes the pending state and seats the question when they are
 * together. Returns false, writing nothing, when the pair could never marry: not a man and a
 * woman (1900, and the adult layer's same-sex pairs stay unwed), someone under 18 or gone,
 * either already engaged or married to somebody else, or the two already engaged or married.
 */
export function queueShotgunProposal(proposerId: number, partnerId: number): boolean {
  const proposer = db.select().from(agents).where(eq(agents.id, proposerId)).get();
  const other = db.select().from(agents).where(eq(agents.id, partnerId)).get();
  if (!proposer?.is_active || !other?.is_active || proposerId === partnerId) return false;
  if (proposer.age < ADULT_AGE || other.age < ADULT_AGE || proposer.gender === other.gender) return false;
  if (isSpokenFor(proposerId, partnerId) || isSpokenFor(partnerId, proposerId)) return false;
  const rel = relBetween(proposerId, partnerId);
  if (!rel || rel.tags.includes(ENGAGED_TAG) || rel.tags.includes(MARRIED_TAG)) return false;

  const key = pairKey(proposerId, partnerId);
  const state: PairMilestone = { proposerId, pendingSince: gameMinutesNow(), shotgun: true };
  pairs.set(key, state);
  // A stale question from the couple's own (slower) timeline is replaced, not doubled.
  dropQueuedProposals(proposerId, partnerId);
  // Already together: no reason to wait for the next pass.
  if (canProposeNow(proposer, other)) queueProposal(proposer, other, state);
  emitter.markDirty('agents.all');
  return true;
}

// ─── Going to find them ──────────────────────────────────────────────────────
//
// `milestonesTick` only seats a proposal when the two happen to be together at
// one of its 10-minute passes, so a couple who keep different hours (one at the
// forge all day, one at the bakery) could sit on a pending proposal until it
// timed out and got re-decided a day later — a wedding that never came because
// nobody walked across town. Now the proposer goes looking: decisions.ts turns
// `pendingProposalPartner` into a walk to the partner (same shape as a comfort
// visit) whenever both are free to be found, and `queuePendingProposalNow`
// seats the question the moment they meet instead of at the next pass.

/**
 * Decision score of the walk to the partner: above the day plan (6000) so the
 * question is not postponed by "browse the market", below their own wedding
 * (6500), a comfort visit's promise (7000) and every emergency.
 */
export const PROPOSAL_SEEK_SCORE = 6400;

/** Who a proposer is waiting to ask, or null when none of their proposals is pending. */
export function pendingProposalPartner(proposerId: number): number | null {
  for (const [key, state] of pairs) {
    if (state.proposerId !== proposerId || state.pendingSince == null) continue;
    const [x, y] = key.split('-').map(Number);
    return x === proposerId ? y : x;
  }
  return null;
}

/** What `canSeekPartner` needs to know about one of the two, gathered by the caller. */
export interface SeekParty {
  /** `current_action.type` ('idle' when unset). */
  action: string;
  /** Inside their sleeping hours (they are in bed or about to be). */
  inSleepWindow: boolean;
  /** Inside their shift (they have a workplace and it is between workStart and workEnd). */
  onShift: boolean;
  /** One of NOT_NOW_STATES (heartbroken, sick, arrested...). */
  notNow: boolean;
}

/** Whether any of these agent states rules out a proposal for now (the `ready` gate's list). */
export function inNoProposalState(states: readonly string[]): boolean {
  return states.some((s) => NOT_NOW_STATES.has(s));
}

/**
 * Should the proposer set off to find their partner right now? Only when the
 * question can plausibly be asked on arrival: neither of them asleep, in bed
 * hours or in a state that rules it out, and neither on shift — a proposer
 * abandoning the counter, or barging in on someone at work, is worse than
 * waiting an hour for the evening. Pure, for the tests.
 */
export function canSeekPartner(me: SeekParty, partner: SeekParty): boolean {
  const unavailable = (p: SeekParty) => p.action === 'sleeping' || p.action === 'dead' || p.action === 'talking';
  if (unavailable(me) || unavailable(partner)) return false;
  if (me.inSleepWindow || partner.inSleepWindow) return false;
  if (me.onShift || partner.onShift || partner.action === 'working') return false;
  return !me.notNow && !partner.notNow;
}

/**
 * The proposer has reached the partner: seat the question now rather than at the
 * next 10-minute pass (by which time one of them may have wandered off). True
 * when the two are together with the proposal queued (now or already).
 */
export function queuePendingProposalNow(proposerId: number): boolean {
  const partnerId = pendingProposalPartner(proposerId);
  if (partnerId === null) return false;
  const state = pairs.get(pairKey(proposerId, partnerId));
  const proposer = db.select().from(agents).where(eq(agents.id, proposerId)).get();
  const other = db.select().from(agents).where(eq(agents.id, partnerId)).get();
  if (!state || !proposer || !other || !proposer.is_active || !other.is_active) return false;
  if (relBetween(proposerId, partnerId)?.status !== 'partners' && !state.shotgun) return false;
  if (!canProposeNow(proposer, other)) return false;
  if (!proposalQueued(proposerId, partnerId)) {
    queueProposal(proposer, other, state);
    emitter.markDirty('agents.all');
  }
  return true;
}

// ─── Outcome ─────────────────────────────────────────────────────────────────

interface ConversationEndedPayload {
  agentId: number;
  perpetratorId?: number | null;
  /** Both tiers carry it (a template chat is stored as a conversation row too); `template` tells them apart. */
  conversationId?: number;
  /** Set by the template tier's emit (conversations.ts `processTimedOutEntry`). */
  template?: boolean;
  summary?: string;
  turns?: number;
  sentiment?: number;
  messages?: Array<{ speakerId: number; text: string; fallback?: boolean }>;
}

/**
 * The proposal conversation (or, failing that, the next chat the pair has
 * while one is pending) decides it. Handled once, on the proposer's own
 * `conversation:ended`.
 */
export function onConversationEnded(p: ConversationEndedPayload): void {
  const otherId = p.perpetratorId;
  if (otherId == null || otherId === p.agentId) return;
  const key = pairKey(p.agentId, otherId);
  const state = pairs.get(key);
  if (!state || state.proposerId !== p.agentId || state.pendingSince == null) return;
  // Another LLM conversation the two had while the proposal waited for a slot:
  // not the moment. If the two had a template chat, that is when the question
  // came up (template tier: decided by feelings, below).
  //
  // The tier is read off `template`, not off the conversation id: template chats
  // were given a conversation row (and so an id) for the player-outcome reporter,
  // after which `conversationId != null` held for them too, their script topic
  // never matched PROPOSAL_TOPIC, and a proposal that fell to the template tier (a
  // slot busy for PROPOSAL_QUEUE_WAIT_MINUTES, or no LLM at all) was ignored,
  // expired at the (then) 18 h limit and was re-announced a day after that, forever. A 30-day
  // soak saw 12 proposals from 4 couples and not one answer.
  const isLLM = p.conversationId != null && !p.template;
  if (isLLM && p.summary !== PROPOSAL_TOPIC) return;

  const rel = relBetween(p.agentId, otherId);
  if (!rel || (rel.status !== 'partners' && !state.shotgun)) {
    pairs.delete(key);
    dropQueuedProposals(p.agentId, otherId);
    return;
  }

  const answererName = nameOf(otherId);
  const answer = isLLM && (p.turns ?? 0) >= 2
    ? (p.messages ?? []).find((m) => m.speakerId === otherId && !isFallbackMessage(m, answererName))?.text ?? null
    : null;
  const toward = feelings(rel, otherId);
  const outcome = proposalOutcome({
    answerText: answer,
    sentiment: isLLM ? (p.sentiment ?? 0) : null,
    romance: toward.romance,
    trust: toward.trust,
  });

  dropQueuedProposals(p.agentId, otherId);
  const now = gameMinutesNow();
  if (outcome.accepted) acceptProposal(rel, p.agentId, otherId, now, state.shotgun === true);
  else refuseProposal(p.agentId, otherId, now);
  emitter.markDirty('agents.all');
}

function acceptProposal(rel: RelRow, proposer: number, answerer: number, now: number, shotgun: boolean): void {
  const pName = nameOf(proposer);
  const aName = nameOf(answerer);
  setTags(rel.id, [...rel.tags.filter((t) => t !== ENGAGED_TAG), ENGAGED_TAG]);
  // A shotgun engagement keeps its flag: the couple is not `partners`, and the status gate would
  // call it off at the next pass.
  pairs.set(pairKey(proposer, answerer), { engagedAt: now, ...(shotgun ? { shotgun: true as const } : {}) });

  db.insert(relationshipEvents).values({
    agent_a: proposer, agent_b: answerer, event_type: 'proposal',
    description: `${pName} proposed to ${aName}, who said yes`,
    friendship_delta_ab: 3, friendship_delta_ba: 3,
    romance_delta_ab: 5, romance_delta_ba: 5,
    trust_delta_ab: 5, trust_delta_ba: 5,
    sentiment: 0.9, processed: false, timestamp: Date.now(),
  }).run();

  logActivity({
    type: 'engagement',
    initiator: proposer,
    target: answerer,
    templateData: { description: `${pName} asked ${aName} to marry them — and ${aName} said yes! They are engaged.` },
  });
  // Public news: sensitivity 1 spreads to whoever is nearby (gossipEngine).
  createFact('engagement', proposer, answerer, 1, [proposer, answerer], 'event');

  remember(proposer, `I asked ${aName} to marry me, and they said yes! We're engaged.`, 0.9, 9, answerer);
  remember(answerer, `${pName} asked me to marry them, and I said yes. We're engaged!`, 0.9, 9, proposer);
  addMood(proposer, 15, 'engagement', 24 * 60, now);
  addMood(answerer, 15, 'engagement', 24 * 60, now);
}

function refuseProposal(proposer: number, answerer: number, now: number): void {
  const pName = nameOf(proposer);
  const aName = nameOf(answerer);
  pairs.set(pairKey(proposer, answerer), { retryAfter: now + PROPOSAL_RETRY_AFTER_REFUSAL_DAYS * 24 * 60 });

  // The proposer's romance takes the fall. A drop past -20 in one event is
  // what the states phase reads as a heartbreak (states.ts "Heartbroken"), so
  // the `heartbroken` state, its feed line and its gossip follow on their own.
  // The answerer cools too: a refusal is rarely only about the question.
  db.insert(relationshipEvents).values({
    agent_a: proposer, agent_b: answerer, event_type: 'proposal',
    description: `${pName} proposed to ${aName}, who said no`,
    friendship_delta_ab: -5, friendship_delta_ba: -3,
    romance_delta_ab: -30, romance_delta_ba: -10,
    trust_delta_ab: -10, trust_delta_ba: -5,
    sentiment: -0.7, processed: false, timestamp: Date.now(),
  }).run();

  logActivity({
    type: 'rejection',
    initiator: proposer,
    target: answerer,
    templateData: { description: `${pName} asked ${aName} to marry them — and ${aName} said no.` },
  });
  // A juicy secret: only the two of them know, for now.
  createFact('proposal_rejected', proposer, answerer, 2, [proposer, answerer], 'witnessed');

  remember(proposer, `I asked ${aName} to marry me, and they said no. I don't know how to face them now.`, -0.8, 8, answerer);
  remember(answerer, `${pName} asked me to marry them. I said no — it wasn't right, not now.`, -0.3, 7, proposer);
  addMood(proposer, -20, 'proposal_refused', 24 * 60, now);
  addMood(answerer, -5, 'proposal_refused', 12 * 60, now);
}

// ─── Wedding ─────────────────────────────────────────────────────────────────

/** Start the couple's wedding and marry them. False when the event could not start (no world row). */
function holdWedding(rel: RelRow, a: AgentRow, b: AgentRow, now: number): boolean {
  const venue = weddingVenue();
  const title = `Wedding of ${a.name} & ${b.name}`;
  const result = startWorldEvent('wedding', {
    triggeredBy: weddingTriggeredBy(a.id, b.id),
    name: title,
    description: `${a.name} and ${b.name} are getting married on the square, and the whole town is invited.`,
    locationId: venue,
    // Recorded regardless of how many other events run: it is their day.
    enforceLimits: false,
    // The feed gets the typed `wedding` row below instead of a generic line.
    announce: false,
  });
  if (!result.ok) return false;

  setTags(rel.id, [...rel.tags.filter((t) => t !== ENGAGED_TAG && t !== MARRIED_TAG), MARRIED_TAG]);

  db.insert(relationshipEvents).values({
    agent_a: a.id, agent_b: b.id, event_type: 'wedding',
    description: `${a.name} and ${b.name} got married`,
    friendship_delta_ab: 5, friendship_delta_ba: 5,
    romance_delta_ab: 5, romance_delta_ba: 5,
    trust_delta_ab: 5, trust_delta_ba: 5,
    sentiment: 1, processed: false, timestamp: Date.now(),
  }).run();

  logActivity({
    type: 'wedding',
    agents: [a.id, b.id],
    ...(venue != null ? { location: venue } : {}),
    templateData: { description: `${a.name} and ${b.name} were married on the square, with the whole town looking on.` },
  });

  const town = db.select({ id: agents.id }).from(agents).where(eq(agents.is_active, true)).all().map((r) => r.id);
  createFact('wedding', a.id, b.id, 1, town, 'event');
  for (const id of town) {
    if (id === a.id || id === b.id) continue;
    simEvents.emit('event:world', { agentId: id, name: title, description: `${a.name} and ${b.name} are getting married today.` });
  }
  remember(a.id, `Today I married ${b.name} on the square, with the whole town looking on.`, 1, 10, b.id);
  remember(b.id, `Today I married ${a.name} on the square, with the whole town looking on.`, 1, 10, a.id);
  addMood(a.id, 20, 'wedding', 24 * 60, now);
  addMood(b.id, 20, 'wedding', 24 * 60, now);

  // Married couples share a house: the larger of the two, freeing the other
  // for a newcomer (lib/populationFlow.ts). Nothing moves when there is no room.
  const moved = rehomeCouple(a.id, b.id);
  if (moved) {
    const mover = moved.moverId === a.id ? a : b;
    const host = mover === a ? b : a;
    logActivity({
      type: 'moved_in',
      agents: [mover.id, host.id],
      location: moved.homeId,
      templateData: { description: `${mover.name} has moved into ${moved.homeName} with ${host.name}.` },
    });
    remember(mover.id, `I moved into ${moved.homeName} with ${host.name}. It's our home now.`, 0.7, 7, host.id);
    remember(host.id, `${mover.name} moved in with me at ${moved.homeName}. It's our home now.`, 0.7, 6, mover.id);
  }

  // An affair either of them was already known for now betrays a marriage.
  // createFact judges new affairs at birth; the ones already in circulation
  // are raised here, once, at the moment they became worse.
  const affairs = db.select({ id: shared_knowledge.id, s: shared_knowledge.sensitivity, subject: shared_knowledge.subject_id, target: shared_knowledge.target_id })
    .from(shared_knowledge)
    .where(and(
      eq(shared_knowledge.type, 'affair'),
      eq(shared_knowledge.is_active, true),
      or(inArray(shared_knowledge.subject_id, [a.id, b.id]), inArray(shared_knowledge.target_id, [a.id, b.id])),
    ))
    .all()
    .filter((f) => !(pairKey(f.subject, f.target ?? -1) === pairKey(a.id, b.id)) && f.s < MARRIED_AFFAIR_SENSITIVITY);
  for (const f of affairs) {
    db.update(shared_knowledge).set({ sensitivity: MARRIED_AFFAIR_SENSITIVITY }).where(eq(shared_knowledge.id, f.id)).run();
  }
  return true;
}

// ─── Registration ────────────────────────────────────────────────────────────

let initialized = false;

function initMilestones(): void {
  if (initialized) return;
  initialized = true;
  simEvents.on('conversation:ended', (p: ConversationEndedPayload) => {
    try {
      onConversationEnded(p);
    } catch (err) {
      // A listener runs inside the emitting phase: never let a milestone
      // failure take the conversation's own bookkeeping down with it.
      console.warn('[milestones] proposal outcome failed:', (err as Error).message);
    }
  });
}

// Auto-initialize on import
initMilestones();
