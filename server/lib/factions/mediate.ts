/**
 * Making peace: the `mediate` social call.
 *
 * Someone close to both sides of a falling-out (decide.ts: a peaceable person,
 * usually torn) walks to one principal, then — if that went well — to the
 * other, and talks each of them round. Both visits welcome, and there is a
 * chance the two make up: the same reconciliation the conversations produce
 * (conversationBeats.ts `performReconciliation`: the grudge tag goes, both warm
 * up, the chronicle turns the rivalry into a reconciliation arc), credited to the
 * peacemaker in the feed, and the confrontation engine gives the pair the rest
 * it gives after a scene (`notePeaceMade`), so they don't come to blows the next
 * time they share a room while their numbers climb back.
 *
 * It extends the existing peace paths rather than duplicating them: the ripple
 * rules' `grudge_forgiveness` and `post_confrontation_apology` still soften a
 * pair after a good chat; this is the friend who makes the chat happen.
 */
import { mediateTopic } from '../socialCalls/topics';
import { registerSocialCallKind, scheduleCall } from '../socialCalls/engine';
import { defaultJudge } from '../socialCalls/kinds';
import { favour, feel, firstOf, nameOf, remember } from '../socialCalls/effects';
import { pairRelationship, performReconciliation } from '../conversationBeats';
import { notePeaceMade } from '../confrontationEngine';
import { logActivity } from '../activityLogger';
import { getEffectivePersonality } from '../states';
import { makeRng, stringToSeed } from '../worldgen/rng';
import { currentWorldSeed } from '../intimacy/worldSeed';
import type { SocialCall, SocialCallKind } from '../socialCalls/types';
import { addLog, countTally, feudById, type Feud } from './store';

const HOUR = 60;
const DAY = 24 * HOUR;

export const MEDIATE_KIND_ID = 'mediate';

let rngOverride: (() => number) | null = null;

/** Tests only: the reconciliation roll draws from `fn` (null restores the seeded source). */
export function setMediationRng(fn: (() => number) | null): void {
  rngOverride = fn;
}

function rollFor(key: string): number {
  if (rngOverride) return rngOverride();
  return makeRng(stringToSeed(`${String(currentWorldSeed())}|mediate|${key}`)).next();
}

/** The chance a pair talked round by a peacemaker makes up, from the peacemaker's warmth and what is left between them. */
export function peaceChance(mediatorWarmth: number, pairAvgFriendship: number): number {
  return Math.max(0.15, Math.min(0.75, 0.4 + (mediatorWarmth - 50) / 200 + pairAvgFriendship / 200));
}

function feudOf(call: SocialCall): Feud | null {
  return typeof call.payload.feudId === 'number' ? feudById(call.payload.feudId) : null;
}

function otherOf(call: SocialCall): number | null {
  return typeof call.payload.otherId === 'number' ? call.payload.otherId : null;
}

function feudRow(f: Feud, mediatorId: number, description: string, severity: number): void {
  logActivity({
    type: 'feud',
    initiator: mediatorId,
    agents: [mediatorId, f.aId, f.bId],
    severity,
    templateData: { description },
    metadata: { beat: 'mediation', feudId: f.id },
  });
}

let onPeace: (f: Feud, nowMin: number) => void = () => {};

/**
 * Send `mediatorId` to the first principal (the one they are less close to is
 * not tracked: the aggrieved first, who has the most to forgive). False when the
 * call rules refuse (already on another call).
 */
export function scheduleMediation(f: Feud, mediatorId: number, nowMin: number): boolean {
  const call = scheduleCall({
    kind: MEDIATE_KIND_ID, callerId: mediatorId, targetId: f.aId, nowMin,
    notBeforeMin: nowMin + HOUR,
    payload: { feudId: f.id, leg: 1, otherId: f.bId },
  });
  return call != null;
}

function failed(call: SocialCall, f: Feud, first: boolean, nowMin: number): void {
  const m = nameOf(call.callerId), t = nameOf(call.targetId);
  const other = otherOf(call);
  const o = other != null ? nameOf(other) : 'the other';
  f.stances.set(call.callerId, 'neutral');
  remember(call.callerId, `I tried to make peace between ${firstOf(f.aId)} and ${firstOf(f.bId)}. ${first ? `${firstOf(call.targetId)} wouldn't hear of it.` : 'Neither is ready to forgive.'}`, -0.3, 5, call.targetId);
  addLog(f, nowMin, `${m}'s attempt at peace came to nothing.`);
  feudRow(f, call.callerId, first
    ? `${m} tried to talk ${t} round about the quarrel with ${o}, and got nowhere.`
    : `${m} went between ${nameOf(f.aId)} and ${nameOf(f.bId)} to make peace; both listened, but neither is ready to forgive.`, 0);
}

export const MEDIATE: SocialCallKind = {
  id: MEDIATE_KIND_ID,
  maxPendingPerTarget: 1,
  pairCooldownMin: 3 * DAY,
  windowMin: 30 * HOUR,
  stillRelevant: (call) => feudOf(call) != null,
  topic: (call) => {
    const other = otherOf(call);
    return mediateTopic(other != null ? firstOf(other) : 'them');
  },
  label: (call, n) => {
    const other = otherOf(call);
    const o = other != null ? firstOf(other) : 'the other';
    return { walking: `On the way to talk ${n} round about ${o}`, there: `Trying to make peace between ${n} and ${o}` };
  },
  judge: defaultJudge,
  consequence(call, r) {
    const f = feudOf(call);
    const other = otherOf(call);
    if (!f || other == null) return;
    f.lastActivityMin = r.nowMin;
    const leg = call.payload.leg === 2 ? 2 : 1;
    if (!r.good) return failed(call, f, leg === 1, r.nowMin);
    if (leg === 1) {
      remember(call.targetId, `${firstOf(call.callerId)} came to talk to me about ${firstOf(other)}. Maybe I've been too hard.`, 0.2, 5, call.callerId);
      // Then the other one, later the same day or the next.
      const next = scheduleCall({
        kind: MEDIATE_KIND_ID, callerId: call.callerId, targetId: other, nowMin: r.nowMin,
        notBeforeMin: r.nowMin + 2 * HOUR,
        payload: { feudId: f.id, leg: 2, otherId: call.targetId },
      });
      if (!next) failed(call, f, true, r.nowMin);
      return;
    }
    // Both talked round: will they make up?
    const rel = pairRelationship(f.aId, f.bId);
    const avg = rel ? (rel.friendship_ab + rel.friendship_ba) / 2 : 0;
    const warmth = getEffectivePersonality(call.callerId)?.warmth ?? 50;
    if (rollFor(`peace|${call.id}`) >= peaceChance(warmth, avg)) return failed(call, f, false, r.nowMin);
    countTally('mediationsSucceeded');
    const m = nameOf(call.callerId), A = nameOf(f.aId), B = nameOf(f.bId);
    if (rel) {
      performReconciliation(rel, { id: f.aId, name: A }, { id: f.bId, name: B }, {
        description: `Thanks to ${m}, who went between them, ${A} and ${B} have made peace.`,
        initiator: call.callerId,
      });
    }
    notePeaceMade(f.aId, f.bId, r.nowMin);
    for (const p of [f.aId, f.bId]) {
      favour(call.callerId, p, 1);
      feel(call.callerId, p, 'peacemaker', `${m} made peace between ${A} and ${B}`, {
        fromCaller: { friendship: 1 }, fromTarget: { friendship: 4, trust: 3 }, sentiment: 0.5,
      });
      remember(p, `${firstOf(call.callerId)} talked sense into us both. ${firstOf(p === f.aId ? f.bId : f.aId)} and I have made it up.`, 0.6, 7, call.callerId);
    }
    remember(call.callerId, `I got ${firstOf(f.aId)} and ${firstOf(f.bId)} to make peace. It took some doing.`, 0.6, 7, f.aId);
    addLog(f, r.nowMin, `${m} made peace between them.`);
    onPeace(f, r.nowMin);
  },
  onMissed(call) {
    const f = feudOf(call);
    if (f) f.stances.set(call.callerId, 'neutral');
  },
};

/** Register the kind with the social calls; `peace` ends the feud (index.ts `finishFeud`). */
export function registerMediateKind(peace: (f: Feud, nowMin: number) => void): void {
  onPeace = peace;
  registerSocialCallKind(MEDIATE);
}

