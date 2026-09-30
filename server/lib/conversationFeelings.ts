/**
 * How a two-person LLM conversation left each side feeling, as the model judged it
 * (the `feelings` field of the summary call, lib/memory/conversationSummary.ts),
 * turned into a relationship event.
 *
 * Friendship after a conversation otherwise comes only from the word-list sentiment
 * scorer (ai/sentiment.ts via relationshipImpact.ts). Polite 1900-era dialogue scores
 * ~0 there, so a refusal, a slight or a sore topic said courteously moved nothing: a
 * 32-day playtest saw +432 friendship against -21. The model reads tone the word list
 * can't. Its verdict is small on purpose (FEELING_POINTS per step, so ±9 at most) — it
 * nudges the numbers the conversation already moved, it doesn't replace them.
 *
 * The verdict arrives after the conversation has ended (the summary call is queued
 * behind dialogue), so it is written as its own unprocessed relationship event for the
 * next relationships phase to apply, like every other late delta — never a direct write
 * to `relationships`.
 */
import { db } from '../db';
import { agents } from '../db/schema';
import { eq } from 'drizzle-orm';
import { insertPairEvent } from './conversationBeats';
import { logActivity } from './activityLogger';
import { isStaleWorldEpoch } from './worldEpoch';

/** Friendship per judged step, each way. */
export const FEELING_POINTS = 3;
/** Trust lost per negative step: a slight also makes one a little warier. Warmth doesn't buy trust. */
export const FEELING_TRUST_POINTS = 1;
/** At or below this, the talk soured: the event is a `quarrel` and the feed says so. */
export const SORE_FEELING = -2;

export const FEELINGS_EVENT = 'conversation_feelings';
export const SORE_FEELINGS_EVENT = 'quarrel';

/** One side's judged feeling, as the deltas it causes toward the other. */
export function feelingDelta(feeling: number): { friendship: number; trust: number } {
  return {
    friendship: feeling * FEELING_POINTS,
    trust: feeling < 0 ? feeling * FEELING_TRUST_POINTS : 0,
  };
}

/**
 * The event's sentiment, from both sides: their mean over the range. A -3 against a 0
 * reads -0.5, which makes the event pivotal (storyBeats.PIVOTAL_SENTIMENT) — kept by the
 * retention and seen by the chronicle, as a talk that left someone badly hurt should be.
 */
export function feelingSentiment(feelingA: number, feelingB: number): number {
  return Math.max(-1, Math.min(1, (feelingA + feelingB) / 6));
}

const HURT_WORDS: Record<number, string> = { [-3]: 'deeply hurt', [-2]: 'offended' };

/** The two people of a conversation, by id and by the name the summary keyed them with. */
export interface FeelingPair {
  aId: number;
  aName: string;
  bId: number;
  bName: string;
}

/**
 * Write the judged feelings of a finished two-person conversation as a relationship
 * event (plus a feed row when it soured). Returns whether anything was written.
 *
 * Drops the verdict when the world was replaced while the model answered
 * (`worldEpoch`; SQLite reuses ids, so it would land on the new town's residents) or
 * when either id no longer belongs to the name it was judged under. A 0/0 talk writes
 * nothing: an event would still bump familiarity and the interaction count.
 */
export function applyConversationFeelings(
  pair: FeelingPair,
  feelings: ReadonlyMap<string, number>,
  worldEpoch: number,
): boolean {
  if (isStaleWorldEpoch(worldEpoch)) return false;
  const fa = feelings.get(pair.aName) ?? 0;
  const fb = feelings.get(pair.bName) ?? 0;
  if (fa === 0 && fb === 0) return false;
  const nameOf = (id: number) => db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name;
  if (nameOf(pair.aId) !== pair.aName || nameOf(pair.bId) !== pair.bName) return false;

  const deltaA = feelingDelta(fa);
  const deltaB = feelingDelta(fb);
  const soreA = fa <= SORE_FEELING;
  const soreB = fb <= SORE_FEELING;
  const sore = soreA || soreB;
  const description = sore
    ? `${pair.aName} and ${pair.bName} parted on sore terms`
    : `How ${pair.aName} and ${pair.bName} felt after their talk`;

  db.transaction(() => {
    insertPairEvent(pair.aId, pair.bId, sore ? SORE_FEELINGS_EVENT : FEELINGS_EVENT, description, {
      friendshipFrom: deltaA.friendship, friendshipTo: deltaB.friendship,
      trustFrom: deltaA.trust, trustTo: deltaB.trust,
    }, feelingSentiment(fa, fb));

    if (!sore) return;
    // The feed row is the whole "beat": no state, no cascade. A talk that ends this
    // badly already feeds what reads it (friendship, the chronicle via the pivotal
    // sentiment, the confrontation engine once the pair sinks to a feud).
    const [hurt, other, feeling] = soreA && (!soreB || fa <= fb) ? [pair.aId, pair.bId, fa] : [pair.bId, pair.aId, fb];
    const hurtName = hurt === pair.aId ? pair.aName : pair.bName;
    const otherName = other === pair.aId ? pair.aName : pair.bName;
    logActivity({
      type: 'drama',
      initiator: hurt,
      target: other,
      templateData: {
        description: soreA && soreB
          ? `${pair.aName} and ${pair.bName} parted on bitter terms`
          : `${hurtName} came away from a talk with ${otherName} ${HURT_WORDS[feeling] ?? 'offended'}`,
      },
    });
  });
  return true;
}
