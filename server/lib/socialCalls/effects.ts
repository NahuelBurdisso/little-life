/**
 * The building blocks a call's consequence is made of: mood, memories, the
 * relationship event, the favour, a gift, the one feed row. Each goes through
 * the path the rest of the sim uses for the same thing, so nothing downstream
 * (status logic, the memory stream, jealousy, the favour ledger) is bypassed.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { agents, relationshipEvents } from '../../db/schema';
import type { DramaBeat } from '../../data/dramaBeats';
import { firstName } from '../../ai/names';
import { itemPhrase } from '../../data/economyData';
import { logActivity } from '../activityLogger';
import { addMoodModifier } from '../dailyLife';
import { recordFavorGiven } from '../favorEngine';
import { giveCallGift, type CallGift } from '../giftEngine';
import { simEvents } from '../simEvents';
import type { SocialCall } from './types';

export function nameOf(id: number): string {
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? 'someone';
}

/** First name, for memories ("Ana came to see me"). */
export function firstOf(id: number): string {
  return firstName(nameOf(id));
}

/** A mood modifier (replaces one of the same source). */
export function mood(agentId: number, value: number, source: string, minutes: number, nowMin: number): void {
  addMoodModifier(agentId, value, source, minutes, nowMin);
}

/** A memory, through the stream's `life:milestone` (written as given, no replan). */
export function remember(agentId: number, description: string, valence: number, importance: number, relatedAgentId: number): void {
  simEvents.emit('life:milestone', { agentId, description, valence, importance, relatedAgentId });
}

/**
 * Feelings moved by the visit, as a relationship event the relationships phase
 * applies (so status changes stay its business). `fromCaller` is what the
 * caller comes to feel toward the target, `fromTarget` the other way.
 */
export function feel(callerId: number, targetId: number, eventType: string, description: string, d: {
  fromCaller: { friendship?: number; trust?: number };
  fromTarget: { friendship?: number; trust?: number };
  sentiment: number;
}): void {
  const callerIsA = callerId < targetId;
  const a = callerIsA ? d.fromCaller : d.fromTarget;
  const b = callerIsA ? d.fromTarget : d.fromCaller;
  db.insert(relationshipEvents).values({
    agent_a: Math.min(callerId, targetId),
    agent_b: Math.max(callerId, targetId),
    event_type: eventType,
    description,
    friendship_delta_ab: a.friendship ?? 0,
    friendship_delta_ba: b.friendship ?? 0,
    romance_delta_ab: 0,
    romance_delta_ba: 0,
    trust_delta_ab: a.trust ?? 0,
    trust_delta_ba: b.trust ?? 0,
    sentiment: d.sentiment,
    processed: false,
    timestamp: Date.now(),
  }).run();
}

export function favour(giverId: number, receiverId: number, magnitude: number): void {
  recordFavorGiven(giverId, receiverId, magnitude);
}

/** Food (or, with `allowMoney`, a little money) the caller can spare; null when they can spare nothing. */
export function bring(call: SocialCall, opts: { foodOnly?: boolean; allowMoney?: boolean; maxMoney?: number }): CallGift | null {
  return giveCallGift(call.callerId, call.targetId, { ...opts, reason: call.kind });
}

/** " and brought her some bread" — the gift, as a clause of the feed line. */
export function giftClause(gift: CallGift | null): string {
  if (!gift) return '';
  return gift.item ? ` and brought ${itemPhrase(gift.item)}` : ` and pressed $${gift.amount} on them`;
}

/**
 * The call's one feed row. `severity` lifts it from the `social_call` base of 0.5
 * by 0.3 per unit (see data/activityRegistry.ts).
 */
export function feed(call: SocialCall, beat: DramaBeat, description: string, severity: number, location?: number | null): void {
  logActivity({
    type: 'social_call',
    initiator: call.callerId,
    target: call.targetId,
    ...(location != null ? { location } : {}),
    severity,
    templateData: { description },
    metadata: { beat, callKind: call.kind },
  });
}

/** Where the caller is now (the feed row's place). */
export function whereIs(id: number): number | null {
  return db.select({ loc: agents.current_location }).from(agents).where(eq(agents.id, id)).get()?.loc ?? null;
}
