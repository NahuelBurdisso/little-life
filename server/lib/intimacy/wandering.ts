import { pairRelationship } from '../conversationBeats';
import { isAdultContent } from '../worldRules';
import { committedTo } from './committed';
import { isAdultAge } from './eligibility';
import { isNeglected } from './neglect';
import { getAgentIntimacy, getPairIntimacy } from './state';

/**
 * The DB-reading side of the wandering eye (the rules are pure, in neglect.ts).
 *
 * Callers are the conversation phase (which flags a chat's romance gain) and the
 * decisions phase (which scores the evening); both run once per agent or per
 * finished conversation, so the cheap in-memory checks come first and the
 * relationship reads only happen for someone who already aches.
 */

/**
 * Who `agent` is neglected BY: their committed partner's id when they are neglected
 * (`isNeglected`), else null. The time since the couple last spent a night together
 * is the later of the pair's `lastTrystAt` and when the relationship reached its
 * current status (`status_since_minute`), so a couple who never had a night is
 * measured from when they got together.
 */
export function neglectedPartnerOf(agent: { id: number; age: number }, nowMinute: number): number | null {
  const adultContent = isAdultContent();
  if (!adultContent || !isAdultAge(agent.age)) return null;
  const longing = getAgentIntimacy(agent.id)?.longing ?? 0;
  // Cheap exit before any relationship read: most agents are nowhere near aching.
  if (!(longing > 0)) return null;
  const partnerId = committedTo(agent.id);
  if (partnerId == null) return null;
  const since = pairRelationship(agent.id, partnerId)?.status_since_minute ?? null;
  const lastTryst = getPairIntimacy(agent.id, partnerId)?.lastTrystAt ?? null;
  const lastIntimateAt = since == null ? lastTryst : lastTryst == null ? since : Math.max(since, lastTryst);
  const neglected = isNeglected(agent, {
    adultContent, spokenFor: true, longing, now: nowMinute, lastIntimateAt,
  });
  return neglected ? partnerId : null;
}

/**
 * Whether a neglected `agent`'s feelings toward `other` are the wandering kind: they
 * are neglected, `other` is not that partner, and `other` is an adult. The loyalty
 * line and the attraction gate are applied where the gain is computed
 * (relationshipImpact.ts), so this only says "the eye is loose toward them".
 */
export function wandersToward(
  agent: { id: number; age: number },
  other: { id: number; age: number },
  nowMinute: number,
): boolean {
  if (!isAdultAge(other.age)) return false;
  const partnerId = neglectedPartnerOf(agent, nowMinute);
  return partnerId != null && partnerId !== other.id;
}
