import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agents, conversationQueue, locations, relationships } from '../../db/schema';
import { callOllamaChat } from '../../ai/ollama';
import { firstName } from '../../ai/names';
import { RENDEZVOUS_TOPIC } from '../../ai/prompts';
import { isFallbackMessage } from '../../ai/sanitizeDialogue';
import { emitter } from '../../engine/emitter';
import { logActivity } from '../activityLogger';
import { CONFIG } from '../constants';
import { queueMaxWait } from '../conversationPacing';
import { addMoodModifier } from '../dailyLife';
import { MINUTES_PER_DAY, gameMinutes, type ClockTime } from '../gameClock';
import { MILESTONE_TAGS, MARRIED_TAG, spouseOf } from '../marriage';
import { committedTo } from './committed';
import {
  NO_WORDS, PROPOSAL_QUEUE_PRIORITY, YES_WORDS, canProposeNow, inNoProposalState,
} from '../milestonesEngine';
import { simEvents } from '../simEvents';
import { getAgentStates, getEffectivePersonality } from '../states';
import { clamp, pairKey } from '../utils';
import { isAdultContent } from '../worldRules';
import { gameMinutesNow } from '../worldClock';
import { currentWorldEpoch, isStaleWorldEpoch } from '../worldEpoch';
import { isIntimacyEligible } from './eligibility';
import { buildConsentPrompt, parseConsent, type ConsentInput, type ConsentLine } from './consentPrompt';
import { KISSED_TAG } from './kiss';
import {
  forEachPairIntimacy, forEachStay, getAgentIntimacy, getPairIntimacy, getStay, updatePairIntimacy, type PairIntimacy,
} from './state';

// ─── Rendezvous: a lover asks, the other may say no ──────────────────────────
//
// The adult layer starts here, and everything in this module runs only while the
// `adultContent` rule is on and only for two adults who are drawn to each other
// (`isIntimacyEligible`, the one age gate). It decides WHO asks WHOM and WHETHER
// they agree; where and how the evening goes is tryst.ts's, and nothing
// here narrates anything past an invitation.
//
//   evening (19-23 h), a pair that kissed, both keen and trusting, and one of
//   them aches enough (longing) to ask
//        ├─ married and at home together ─▶ nobody needs to ask: if both are
//        │                                   willing the pair is marked `agreed`
//        └─ everyone else ─▶ `pendingRendezvous` (asked, unanswered) ─▶ the
//             asker walks to the other (decisions.ts, score 6300) ─▶ an
//             `llm_deep` conversation on RENDEZVOUS_TOPIC
//                 ├─ yes ─▶ pending flips to `agreed` (tryst.ts takes it from here)
//                 └─ no  ─▶ asker's mood drops, no new invitation for two days
//
// Consent is modelled, and a refusal is a real outcome. The answer is read from
// the conversation three ways, best first (`decideConsent`): a small structured
// LLM call, a yes/no regex over the answerer's own words, and the answerer's
// character (`willingness`). Whatever any of them says, an answerer whose
// character says a flat no (willingness < 0.25) refuses: the model cannot make
// someone consent against who they are.
//
// The durable truth about a couple stays in the DB; this module's timers live in
// intimacy/state.ts (`pendingRendezvous`, `rendezvousRetryAfter`), checkpointed
// with the rest of the intimacy state.

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Invitations are made in the evening: from this hour to (not including) the last. */
export const RENDEZVOUS_FIRST_HOUR = 19;
export const RENDEZVOUS_LAST_HOUR = 23;
/** Both must feel at least this much toward the other, and trust them this much. */
export const RENDEZVOUS_MIN_ROMANCE = 60;
export const RENDEZVOUS_MIN_TRUST = 25;
/** The one who asks aches at least this much; a couple that is openly together, this much. */
export const RENDEZVOUS_MIN_LONGING = 55;
export const RENDEZVOUS_MIN_LONGING_COUPLE = 40;
/** The asker only asks when they think the answer is probably yes... */
export const INVITE_MIN_WILLINGNESS = 0.55;
/** ...and a married couple at home agree without asking when both are at least this willing. */
export const AGREE_MIN_WILLINGNESS = 0.5;
/** The answerer accepts on character alone at this much, and below CHARACTER_VETO nothing makes them. */
export const ACCEPT_MIN_WILLINGNESS = 0.5;
export const CHARACTER_VETO_BELOW = 0.25;
/** An invitation that never got its conversation is dropped after this long... */
export const RENDEZVOUS_PENDING_MINUTES = 3 * 60;
/** ...and the pair tries again the next evening. */
export const RENDEZVOUS_EXPIRED_RETRY_MINUTES = 12 * 60;
/** An agreed evening nobody acted on (no venue, no time) lapses this long after it was agreed. */
export const RENDEZVOUS_AGREED_MINUTES = 6 * 60;
/** A refusal: the asker's mood, and the wait before the pair asks again. */
export const REFUSAL_MOOD = -8;
export const REFUSAL_MOOD_MINUTES = 4 * 60;
export const REFUSAL_RETRY_MINUTES = 2 * MINUTES_PER_DAY;
/** How long the queued conversation may wait for a slot, in game minutes. */
export const RENDEZVOUS_QUEUE_WAIT_MINUTES = 60;
/**
 * Queue priority: the same protected level as a proposal (conversations.ts
 * `isProtectedEntry`), so hunger does not walk one of them off between the
 * question and the answer and a slot-starved scheduler seats it before small talk.
 */
export const RENDEZVOUS_QUEUE_PRIORITY = PROPOSAL_QUEUE_PRIORITY;
/**
 * Decision score of the walk to find the other: above the day plan (6000), below
 * a pending proposal (6400) and a wedding (6500) — a marriage question outranks
 * an evening's invitation.
 */
export const RENDEZVOUS_SEEK_SCORE = 6300;
/** The trigger_reason of the queued conversation. */
export const RENDEZVOUS_TRIGGER = 'rendezvous';

// ─── Pure rules (exported for tests) ─────────────────────────────────────────

export interface WillingnessSelf {
  /** This person's romance toward the other, 0..100. */
  romance: number;
  /** ... and their trust in them. */
  trust: number;
  /** Their own longing, 0..100. */
  longing: number;
  impulsiveness: number;
  loyalty: number;
  morality: number;
  /** Engaged or married to someone other than the one asking / being asked. */
  spokenForElsewhere: boolean;
}

export interface WillingnessOther {
  /** The other one is married to somebody else. */
  marriedElsewhere: boolean;
}

export interface WillingnessCtx {
  /** The two are openly together: partners, engaged or married to each other. */
  together: boolean;
}

/**
 * How willing `self` is to spend a private evening with `other`, 0..1. Pure.
 *
 * Feeling carries it (romance 0.5, trust 0.2, longing 0.3, each scaled 0..1).
 * Conscience takes away: being spoken for to someone else costs up to 0.35, more
 * for the loyal and the moral; being asked by someone else's husband or wife
 * costs up to 0.2 for the moral. The impulsive (over 70) add 0.15, and a couple
 * who are openly together 0.25, since nothing stands in the way.
 */
export function willingness(self: WillingnessSelf, other: WillingnessOther, ctx: WillingnessCtx): number {
  let w = clamp(self.romance, 0, 100) / 100 * 0.5
    + clamp(self.trust, 0, 100) / 100 * 0.2
    + clamp(self.longing, 0, 100) / 100 * 0.3;
  if (self.spokenForElsewhere) w -= 0.35 * (clamp(self.loyalty, 0, 100) + clamp(self.morality, 0, 100)) / 200;
  if (other.marriedElsewhere) w -= 0.2 * clamp(self.morality, 0, 100) / 100;
  if (self.impulsiveness > 70) w += 0.15;
  if (ctx.together) w += 0.25;
  return clamp(w, 0, 1);
}

/** Who asks: the one who aches more; equal longing goes to the lower id so it never depends on order. */
export function pickRendezvousInitiator<T extends { id: number; longing: number }>(x: T, y: T): { initiator: T; other: T } {
  const xLeads = x.longing > y.longing || (x.longing === y.longing && x.id < y.id);
  return xLeads ? { initiator: x, other: y } : { initiator: y, other: x };
}

/** How much the asker has to ache before asking: less when the two are openly a couple. */
export function longingThreshold(together: boolean): number {
  return together ? RENDEZVOUS_MIN_LONGING_COUPLE : RENDEZVOUS_MIN_LONGING;
}

/** Whether invitations are made at this hour of the day. */
export function isRendezvousHour(hour: number): boolean {
  return hour >= RENDEZVOUS_FIRST_HOUR && hour < RENDEZVOUS_LAST_HOUR;
}

// ─── Reading the answer ──────────────────────────────────────────────────────

export type ConsentSource = 'llm' | 'regex' | 'rule' | 'character';

export interface ConsentDecision {
  accepted: boolean;
  source: ConsentSource;
  reason?: string;
}

/** One structured call; null when it fails or is unusable (the caller falls back). */
async function llmConsent(input: ConsentInput): Promise<{ accepted: boolean; reason: string } | null> {
  const prompt = buildConsentPrompt(input);
  try {
    const res = await callOllamaChat({
      model: CONFIG.AI.LIGHT_MODEL,
      purpose: 'intimacy.consent',
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      priority: 'normal',
      format: prompt.format,
      options: { temperature: 0.2, num_predict: 80 },
    });
    return parseConsent(res.text);
  } catch {
    return null;
  }
}

/**
 * The regex layer: the answerer's first reply says yes or no, and only one of
 * them ("Of course not — well, yes" has both and falls through). `lines` are
 * already free of canned fallback replies (the caller filters them).
 */
export function regexConsent(lines: readonly ConsentLine[], answererId: number): boolean | null {
  const reply = lines.find((l) => l.speakerId === answererId);
  if (!reply) return null;
  const yes = YES_WORDS.test(reply.text);
  const no = NO_WORDS.test(reply.text);
  return yes !== no ? yes : null;
}

/**
 * Did the one who was asked say yes? In order:
 *
 * 0. `willingness < CHARACTER_VETO_BELOW`: no, whatever was said. Checked first
 *    so a flat-no character never even reaches the model (and a yes from it
 *    could not change anything).
 * 1. A structured LLM call reading the last CONSENT_LINES lines (`llm: false`,
 *    the default under tests and with LLM_INTIMACY_CONSENT=0, skips it).
 * 2. The regex over the answerer's own words.
 * 3. The rule: `willingness >= ACCEPT_MIN_WILLINGNESS`.
 *
 * A "no" from 1 or 2 stands however willing the answerer's character is: they
 * were asked and declined.
 */
export async function decideConsent(
  input: ConsentInput,
  opts: { llm?: boolean } = {},
): Promise<ConsentDecision> {
  if (input.willingness < CHARACTER_VETO_BELOW) return { accepted: false, source: 'character' };

  const spoke = input.lines.some((l) => l.speakerId === input.answererId);
  if ((opts.llm ?? CONFIG.AI.INTIMACY_CONSENT) && spoke) {
    const read = await llmConsent(input);
    if (read) return { accepted: read.accepted, source: 'llm', ...(read.reason ? { reason: read.reason } : {}) };
  }
  const words = regexConsent(input.lines, input.answererId);
  if (words !== null) return { accepted: words, source: 'regex' };
  return { accepted: input.willingness >= ACCEPT_MIN_WILLINGNESS, source: 'rule' };
}

// ─── Reading the DB ──────────────────────────────────────────────────────────

type AgentRow = typeof agents.$inferSelect;
type RelRow = typeof relationships.$inferSelect;

function feelings(rel: RelRow, from: number): { romance: number; trust: number } {
  const isA = rel.agent_a === from;
  return { romance: isA ? rel.romance_ab : rel.romance_ba, trust: isA ? rel.trust_ab : rel.trust_ba };
}

/** Partners, engaged or married to each other: nothing to hide. */
function isTogether(rel: RelRow): boolean {
  return rel.status === 'partners' || rel.tags.some((t) => MILESTONE_TAGS.includes(t));
}

function longingOf(id: number): number {
  return getAgentIntimacy(id)?.longing ?? 0;
}

function willingnessOf(self: AgentRow, other: AgentRow, rel: RelRow): number {
  const personality = getEffectivePersonality(self.id) ?? (self.personality as Partial<Record<string, number>> | null);
  const spouse = spouseOf(other.id);
  const { romance, trust } = feelings(rel, self.id);
  return willingness(
    {
      romance, trust, longing: longingOf(self.id),
      impulsiveness: personality?.impulsiveness ?? 50,
      loyalty: personality?.loyalty ?? 50,
      morality: personality?.morality ?? 50,
      spokenForElsewhere: committedTo(self.id, other.id) != null,
    },
    { marriedElsewhere: spouse != null && spouse !== self.id },
    { together: isTogether(rel) },
  );
}

const actionType = (a: Pick<AgentRow, 'current_action'>): string =>
  (a.current_action as { type?: string } | null)?.type ?? 'idle';

function relBetween(a: number, b: number): RelRow | undefined {
  return db.select().from(relationships)
    .where(and(eq(relationships.agent_a, Math.min(a, b)), eq(relationships.agent_b, Math.max(a, b))))
    .get();
}

function rendezvousQueued(a: number, b: number): boolean {
  return db.select({ participants: conversationQueue.participants }).from(conversationQueue)
    .where(eq(conversationQueue.trigger_reason, RENDEZVOUS_TRIGGER)).all()
    .some((q) => q.participants.includes(a) && q.participants.includes(b));
}

function dropQueuedRendezvous(a?: number, b?: number): void {
  const rows = db.select({ id: conversationQueue.id, participants: conversationQueue.participants })
    .from(conversationQueue).where(eq(conversationQueue.trigger_reason, RENDEZVOUS_TRIGGER)).all()
    .filter((q) => a == null || b == null || (q.participants.includes(a) && q.participants.includes(b)));
  if (rows.length > 0) db.delete(conversationQueue).where(inArray(conversationQueue.id, rows.map((r) => r.id))).run();
}

function queueRendezvous(initiator: AgentRow, other: AgentRow): void {
  db.insert(conversationQueue).values({
    // The asker first: participants[0] opens the conversation, and the topic's
    // intent is written for the one who asks.
    participants: [initiator.id, other.id],
    tier: 'llm_deep',
    priority: RENDEZVOUS_QUEUE_PRIORITY,
    trigger_reason: RENDEZVOUS_TRIGGER,
    topic: RENDEZVOUS_TOPIC,
    queued_at: Date.now(), // wall-clock ms, like every producer
    max_wait: queueMaxWait(RENDEZVOUS_QUEUE_WAIT_MINUTES),
  }).run();
}

/** Pairs whose answer is being read right now (the LLM call is async): nothing new is queued for them. */
const deciding = new Set<string>();

// ─── The periodic pass ───────────────────────────────────────────────────────

/** An asked-but-unanswered invitation, or `null`. */
function askedPending(p: PairIntimacy | Readonly<PairIntimacy> | undefined): PairIntimacy['pendingRendezvous'] | null {
  const rv = p?.pendingRendezvous;
  return rv && !rv.agreed ? rv : null;
}

/**
 * Every 10 game minutes (intimacy/index.ts): look after the invitations that
 * are out, and in the evening let new ones start.
 *
 * With the rule off nothing new starts and anything pending is dropped
 * (with its queued conversation): flipping it off mid-game leaves no
 * invitation lying in wait.
 */
export function rendezvousPass(time: ClockTime): void {
  const now = gameMinutes(time);
  const adult = isAdultContent();
  let dirty = false;

  // --- Invitations that are out ---
  const stale: Array<{ key: string; retry: boolean }> = [];
  const busyAgents = new Set<number>();
  forEachPairIntimacy((key, p) => {
    const rv = p.pendingRendezvous;
    // Spoken for tonight: in a tryst right now (tryst.ts) is as busy as an invitation out.
    if (p.activeTryst) key.split('-').map(Number).forEach((id) => busyAgents.add(id));
    if (!rv) return;
    const [x, y] = key.split('-').map(Number);
    if (!adult) { stale.push({ key, retry: false }); return; }
    if (deciding.has(key)) { busyAgents.add(x); busyAgents.add(y); return; }
    const expired = rv.agreed
      ? now - (rv.agreedAt ?? rv.since) > RENDEZVOUS_AGREED_MINUTES
      : now - rv.since > RENDEZVOUS_PENDING_MINUTES;
    if (expired || now < rv.since) { stale.push({ key, retry: true }); return; }
    busyAgents.add(x); busyAgents.add(y);
  });
  // A guest asleep at their lover's house is not free to be asked either.
  forEachStay((id) => busyAgents.add(id));
  for (const { key, retry } of stale) {
    const [x, y] = key.split('-').map(Number);
    updatePairIntimacy(x, y, (p) => {
      delete p.pendingRendezvous;
      if (retry) p.rendezvousRetryAfter = now + RENDEZVOUS_EXPIRED_RETRY_MINUTES;
    });
    dropQueuedRendezvous(x, y);
    dirty = true;
  }

  // --- New invitations ---
  if (adult && isRendezvousHour(time.hour)) {
    if (startEveningRendezvous(now, busyAgents)) dirty = true;
  }
  if (dirty) emitter.markDirty('agents.all');
}

/** Candidate pairs, best first: who asks whom this evening. True when anything changed. */
function startEveningRendezvous(now: number, busyAgents: Set<number>): boolean {
  const kissed = db.select().from(relationships).all().filter((r) => r.tags.includes(KISSED_TAG));
  if (kissed.length === 0) return false;
  const byId = new Map(db.select().from(agents).all().map((a) => [a.id, a]));
  const homeTypes = new Map(db.select({ id: locations.id, type: locations.type }).from(locations).all().map((l) => [l.id, l.type]));
  let changed = false;

  for (const rel of kissed) {
    const a = byId.get(rel.agent_a);
    const b = byId.get(rel.agent_b);
    if (!a || !b || !a.is_active || !b.is_active) continue;
    // The one age gate: minors are never candidates, whatever their romance or longing.
    if (!isIntimacyEligible(a, b)) continue;
    if (busyAgents.has(a.id) || busyAgents.has(b.id)) continue;

    const fa = feelings(rel, a.id);
    const fb = feelings(rel, b.id);
    if (fa.romance < RENDEZVOUS_MIN_ROMANCE || fb.romance < RENDEZVOUS_MIN_ROMANCE) continue;
    if (fa.trust < RENDEZVOUS_MIN_TRUST || fb.trust < RENDEZVOUS_MIN_TRUST) continue;
    if (inNoProposalState(getAgentStates(a.id)) || inNoProposalState(getAgentStates(b.id))) continue;

    const pair = getPairIntimacy(a.id, b.id);
    if (pair?.pendingRendezvous) continue;
    if (pair?.rendezvousRetryAfter != null && now < pair.rendezvousRetryAfter) continue;

    const together = isTogether(rel);
    const { initiator } = pickRendezvousInitiator({ id: a.id, longing: longingOf(a.id) }, { id: b.id, longing: longingOf(b.id) });
    if (initiator.longing < longingThreshold(together)) continue;
    const initRow = initiator.id === a.id ? a : b;
    const otherRow = initiator.id === a.id ? b : a;

    // Married and home together: nobody has to ask. When both are willing the
    // evening is simply agreed (tryst.ts takes it from there).
    const home = commonHome(rel, initRow, otherRow, homeTypes);
    if (home != null) {
      if (willingnessOf(initRow, otherRow, rel) < AGREE_MIN_WILLINGNESS
        || willingnessOf(otherRow, initRow, rel) < AGREE_MIN_WILLINGNESS) continue;
      updatePairIntimacy(a.id, b.id, (p) => {
        p.pendingRendezvous = { initiatorId: initiator.id, since: now, venueId: home, agreed: true, agreedAt: now };
      });
      busyAgents.add(a.id); busyAgents.add(b.id);
      changed = true;
      continue;
    }

    if (willingnessOf(initRow, otherRow, rel) < INVITE_MIN_WILLINGNESS) continue;
    updatePairIntimacy(a.id, b.id, (p) => { p.pendingRendezvous = { initiatorId: initiator.id, since: now }; });
    busyAgents.add(a.id); busyAgents.add(b.id);
    // Already together and free: ask now instead of waiting for the walk.
    if (canProposeNow(initRow, otherRow) && !rendezvousQueued(a.id, b.id)) queueRendezvous(initRow, otherRow);
    changed = true;
  }
  return changed;
}

/** The home location id when the two are married, awake, and together inside a home of one of them; else null. */
function commonHome(rel: RelRow, a: AgentRow, b: AgentRow, types: Map<number, string>): number | null {
  if (!rel.tags.includes(MARRIED_TAG)) return null;
  if (a.current_location == null || a.current_location !== b.current_location) return null;
  if (types.get(a.current_location) !== 'home') return null;
  if (a.home !== a.current_location && b.home !== a.current_location) return null;
  for (const x of [a, b]) {
    const t = actionType(x);
    if (t === 'sleeping' || t === 'dead') return null;
  }
  return a.current_location;
}

// ─── Going to find them ──────────────────────────────────────────────────────

/** Who an asker is waiting to ask (an unanswered invitation of theirs), or null. Skipped while an answer is being read. */
export function pendingRendezvousPartner(initiatorId: number): number | null {
  let found: number | null = null;
  forEachPairIntimacy((key, p) => {
    if (found !== null || deciding.has(key)) return;
    const rv = askedPending(p);
    if (!rv || rv.initiatorId !== initiatorId) return;
    const [x, y] = key.split('-').map(Number);
    found = x === initiatorId ? y : x;
  });
  return found;
}

/**
 * The asker has reached the other: seat the invitation now rather than at the
 * next pass. True when the two are together with it queued (now or already).
 * Re-checks the rule and the age gate: a stale pending never seats a conversation.
 */
export function queuePendingRendezvousNow(initiatorId: number): boolean {
  if (!isAdultContent()) return false;
  const partnerId = pendingRendezvousPartner(initiatorId);
  if (partnerId === null) return false;
  const rows = db.select().from(agents).where(inArray(agents.id, [initiatorId, partnerId])).all();
  const initiator = rows.find((r) => r.id === initiatorId);
  const other = rows.find((r) => r.id === partnerId);
  if (!initiator || !other || !initiator.is_active || !other.is_active) return false;
  if (!isIntimacyEligible(initiator, other)) return false;
  if (!canProposeNow(initiator, other)) return false;
  if (!rendezvousQueued(initiatorId, partnerId)) {
    queueRendezvous(initiator, other);
    emitter.markDirty('agents.all');
  }
  return true;
}

// ─── The player's hand ───────────────────────────────────────────────────────

/** Whether this person is already in the middle of an evening (invited, agreed, in it, or a guest asleep). */
function hasEveningPlanned(agentId: number): boolean {
  let busy = false;
  forEachPairIntimacy((key, p) => {
    if (busy || !(p.pendingRendezvous || p.activeTryst)) return;
    if (key.split('-').map(Number).includes(agentId)) busy = true;
  });
  return busy || getStay(agentId) !== undefined;
}

export type ArrangeCheck =
  | { ok: true; a: AgentRow; b: AgentRow }
  | { ok: false; reason: string };

/**
 * May the player arrange an evening for these two? Every gate the sim's own
 * invitation has (the rule, the one age gate, a first kiss behind them, nobody
 * already spoken for tonight) minus the ones that are the player's to override:
 * how much either aches, the hour of day, and the two-day wait after a refusal.
 * Whether the other says yes is still decided by the consent flow.
 *
 * Reasons are shown to the player as they are: short, discreet, and never a hint
 * at why an age check failed. Also read by the pair dossier to grey the button out.
 */
export function checkArrangeRendezvous(aId: number, bId: number): ArrangeCheck {
  if (!isAdultContent()) return { ok: false, reason: 'Adult content is turned off in this town.' };
  if (aId === bId) return { ok: false, reason: 'That takes two people.' };
  const rows = db.select().from(agents).where(inArray(agents.id, [aId, bId])).all();
  const a = rows.find((r) => r.id === aId);
  const b = rows.find((r) => r.id === bId);
  if (!a?.is_active || !b?.is_active) return { ok: false, reason: 'Agent not found or inactive' };
  // The one age gate (and attraction): a minor pair, or two people not drawn to each other, get the same plain refusal.
  if (!isIntimacyEligible(a, b)) return { ok: false, reason: 'That is not something you can arrange for them.' };
  const rel = relBetween(aId, bId);
  if (!rel?.tags.includes(KISSED_TAG)) return { ok: false, reason: "They haven't even kissed yet." };
  for (const x of [a, b]) {
    if (actionType(x) === 'sleeping') return { ok: false, reason: `${x.name} is sleeping` };
    if (inNoProposalState(getAgentStates(x.id))) return { ok: false, reason: `${x.name} is in no state for it right now.` };
    if (hasEveningPlanned(x.id)) return { ok: false, reason: `${x.name} already has an evening planned.` };
  }
  return { ok: true, a, b };
}

export type ArrangeResult =
  | { ok: true; initiator: AgentRow; other: AgentRow; queued: boolean }
  | { ok: false; reason: string };

/**
 * The player arranges a quiet evening: the same invitation the evening pass would
 * make, put out now. The one who asks is `initiatorId` when the player chose, else
 * whoever aches more (`pickRendezvousInitiator`). It goes through the existing path
 * and nothing shortcuts it: a pending invitation (the asker walks over,
 * decisions.ts `RENDEZVOUS_SEEK_SCORE`) and, when the two are already together and
 * free, the `rendezvous` conversation queued right away (`RENDEZVOUS_TRIGGER`, so
 * its topic is not stripped). The other can still say no there, and a refusal costs
 * the asker exactly what it always does.
 *
 * Arranging clears a refusal's two-day wait: the player is asking again, on purpose.
 */
export function arrangeRendezvous(aId: number, bId: number, initiatorId?: number): ArrangeResult {
  const check = checkArrangeRendezvous(aId, bId);
  if (!check.ok) return check;
  const { a, b } = check;
  if (initiatorId != null && initiatorId !== aId && initiatorId !== bId) {
    return { ok: false, reason: 'Only one of the two can be the one to ask.' };
  }
  const lead = initiatorId ?? pickRendezvousInitiator(
    { id: a.id, longing: longingOf(a.id) }, { id: b.id, longing: longingOf(b.id) },
  ).initiator.id;
  const initiator = lead === a.id ? a : b;
  const other = lead === a.id ? b : a;

  const now = gameMinutesNow();
  updatePairIntimacy(a.id, b.id, (p) => {
    p.pendingRendezvous = { initiatorId: initiator.id, since: now, byPlayer: true };
    delete p.rendezvousRetryAfter;
  });
  let queued = false;
  if (canProposeNow(initiator, other)) {
    if (!rendezvousQueued(a.id, b.id)) queueRendezvous(initiator, other);
    queued = true;
  }
  emitter.markDirty('agents.all');
  return { ok: true, initiator, other, queued };
}

// ─── The answer ──────────────────────────────────────────────────────────────

/** The fields of `conversation:ended` this reads (conversations.ts emits many more). */
export interface RendezvousConversationEnded {
  agentId: number;
  perpetratorId?: number | null;
  conversationId?: number;
  /** The template tier's emit sets it (the LLM was off, or no slot came free in time). */
  template?: boolean;
  /** The queue entry's trigger_reason (the template tier's emit carries it: its `summary` is a script topic). */
  triggerReason?: string;
  /** The conversation's topic. */
  summary?: string;
  messages?: Array<{ speakerId: number; text: string; fallback?: boolean }>;
}

/**
 * The rendezvous conversation just ended: read the answer and settle the
 * invitation. Handled once, on the asker's own `conversation:ended` (the event
 * fires per participant; the answerer's copy is ignored) and, as a second guard,
 * once per pending (the invitation is settled or in `deciding` before a repeat
 * could act). No per-conversation-id set: ids are reused when a world is replaced,
 * so a remembered id could wrongly swallow a later world's answer. Async
 * because the consent read may be an LLM call; the world epoch is re-checked
 * after it, since ids are reused when a world is replaced.
 *
 * A template-tier chat that was the queued invitation (no LLM, or a slot busy past
 * RENDEZVOUS_QUEUE_WAIT_MINUTES) is answered by the answerer's character alone, as a
 * proposal is (milestonesEngine.ts `onConversationEnded`): `willingness >= ACCEPT_MIN_WILLINGNESS`
 * with the same veto under CHARACTER_VETO_BELOW, no LLM call, and the canned script lines are never
 * read as words. Before, such an invitation was ignored, expired after 3 h and was asked again 12 h
 * later, forever (0 trysts in every as-shipped soak).
 */
export async function onRendezvousConversationEnded(
  p: RendezvousConversationEnded,
  opts: { llm?: boolean } = {},
): Promise<void> {
  const isTemplate = p.template === true;
  if (isTemplate ? p.triggerReason !== RENDEZVOUS_TRIGGER && p.summary !== RENDEZVOUS_TOPIC : p.summary !== RENDEZVOUS_TOPIC) return;
  const otherId = p.perpetratorId;
  if (otherId == null || otherId === p.agentId) return;
  if (!isAdultContent()) return;

  const key = pairKey(p.agentId, otherId);
  const rv = askedPending(getPairIntimacy(p.agentId, otherId));
  if (!rv || rv.initiatorId !== p.agentId || deciding.has(key)) return;

  const rows = db.select().from(agents).where(inArray(agents.id, [p.agentId, otherId])).all();
  const initiator = rows.find((r) => r.id === p.agentId);
  const answerer = rows.find((r) => r.id === otherId);
  const rel = relBetween(p.agentId, otherId);
  // Whoever it was, they are not both adults who may be intimate any more: no answer, no evening.
  if (!initiator || !answerer || !rel || !isIntimacyEligible(initiator, answerer)) {
    updatePairIntimacy(p.agentId, otherId, (s) => { delete s.pendingRendezvous; });
    dropQueuedRendezvous(p.agentId, otherId);
    return;
  }

  const nameOf = (id: number) => (id === initiator.id ? initiator.name : answerer.name);
  const lines: ConsentLine[] = isTemplate ? [] : (p.messages ?? [])
    .filter((m) => !isFallbackMessage(m, nameOf(m.speakerId)))
    .map((m) => ({ speakerId: m.speakerId, speaker: nameOf(m.speakerId), text: m.text }));

  const epoch = currentWorldEpoch();
  deciding.add(key);
  let decision: ConsentDecision;
  try {
    decision = await decideConsent({
      lines,
      initiatorName: initiator.name,
      answererId: answerer.id,
      answererName: answerer.name,
      willingness: willingnessOf(answerer, initiator, rel),
    }, isTemplate ? { llm: false } : opts);
  } finally {
    deciding.delete(key);
  }

  // The world may have been replaced while the model answered, and the pending
  // may have been dropped (rule off, expired) or already settled: leave it be.
  if (isStaleWorldEpoch(epoch) || !isAdultContent()) return;
  const still = askedPending(getPairIntimacy(p.agentId, otherId));
  if (!still || still.initiatorId !== p.agentId || still.since !== rv.since) return;

  dropQueuedRendezvous(p.agentId, otherId);
  const now = gameMinutesNow();
  if (decision.accepted) acceptRendezvous(p.agentId, otherId, now);
  else refuseRendezvous(initiator, answerer, now);
  // The player asked for this evening: they hear how it went (second person, discreet, never in the paper).
  if (rv.byPlayer) reportArrangement(initiator, answerer, decision.accepted);
  emitter.markDirty('agents.all');
}

/** What the arranged invitation came to, as `playerOutcomes.ts` words every nudge's result: a `player_outcome` row. */
function reportArrangement(initiator: AgentRow, answerer: AgentRow, accepted: boolean): void {
  const asker = firstName(initiator.name);
  const asked = firstName(answerer.name);
  logActivity({
    type: 'player_outcome',
    agents: [initiator.id, answerer.id],
    templateData: {
      description: accepted
        ? `Your arrangement: ${asker} and ${asked} agreed to spend the evening together.`
        : `Your arrangement: ${asked} turned ${asker} down.`,
      trigger: 'player_arrange',
    },
  });
}

/** Yes: the evening is agreed. The venue is tryst.ts's `pickVenue` to choose, so `venueId` stays unset. */
function acceptRendezvous(initiatorId: number, answererId: number, now: number): void {
  updatePairIntimacy(initiatorId, answererId, (s) => {
    const rv = s.pendingRendezvous;
    if (!rv) return;
    s.pendingRendezvous = { initiatorId: rv.initiatorId, since: rv.since, agreed: true, agreedAt: now };
  });
}

/**
 * No. A real outcome, with its own cost: the asker's mood drops for a few hours,
 * the pair does not try again for two game days, and both remember it. Nothing
 * goes in the feed (the town does not hear about a private "no").
 */
function refuseRendezvous(initiator: AgentRow, answerer: AgentRow, now: number): void {
  updatePairIntimacy(initiator.id, answerer.id, (s) => {
    delete s.pendingRendezvous;
    s.rendezvousRetryAfter = now + REFUSAL_RETRY_MINUTES;
  });
  addMoodModifier(initiator.id, REFUSAL_MOOD, 'rendezvous_refused', REFUSAL_MOOD_MINUTES, now);
  simEvents.emit('life:milestone', {
    agentId: initiator.id,
    description: `I asked ${answerer.name} to spend the evening with me, and they said no.`,
    valence: -0.5, importance: 5, relatedAgentId: answerer.id,
  });
  simEvents.emit('life:milestone', {
    agentId: answerer.id,
    description: `${initiator.name} asked me to spend the evening with them. I said no.`,
    valence: -0.1, importance: 4, relatedAgentId: initiator.id,
  });
}

// ─── Registration ────────────────────────────────────────────────────────────

let registered = false;

/** Called once by intimacy/index.ts (importing it registers the listener like the other engines). */
export function registerRendezvousListener(): void {
  if (registered) return;
  registered = true;
  simEvents.on('conversation:ended', (p: RendezvousConversationEnded) => {
    // Async: the answer may need an LLM call. Detached from the emitting phase, so
    // a throw would be an unhandled rejection and take the server down.
    onRendezvousConversationEnded(p).catch((err) => {
      console.warn('[intimacy] rendezvous answer failed:', (err as Error).message);
    });
  });
}
