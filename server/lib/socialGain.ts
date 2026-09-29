import { clamp } from './utils';

// ─── Social payoff of a conversation ──────────────────────────────────────────
// How much a finished chat refills each participant's `social` need. Pure, so
// the two conversation paths (LLM and template) can share one place to tune and
// one test file to pin the relation between them.

/**
 * What a full LLM conversation pays: 8 at neutral sentiment, 1 for a screaming
 * match and 15 for a great one, ×1.3 for a warm person who enjoyed it.
 */
export function llmSocialGain(sentiment: number, warmth: number | null): number {
  let gain = clamp(8 + sentiment * 7, 1, 15);
  if (warmth != null && warmth > 60 && sentiment > 0) gain *= 1.3;
  return gain;
}

/** The template payoff never exceeds this, so a full LLM chat stays the better conversation. */
export const TEMPLATE_SOCIAL_MAX = 10;
/** ...and never falls below this for a chat that at least happened. */
export const TEMPLATE_SOCIAL_MIN = 2;

/**
 * What a canned small-talk exchange pays (E10). It used to be a flat +3 against
 * 8–15 for an LLM chat. At tick_speed 4 most chats are templates (the LLM slots
 * are busy or the model is skipped), and one template chat filled a third of
 * what one LLM chat did, so a 4x town stayed short on social: the soak's first
 * two days sat around "lonely ~6". A template is 2–3 short lines and no
 * follow-up, so it should pay a little less than the LLM chat — but the same
 * order of magnitude, and it should read the same signals:
 *
 * - turns: an opener + reply (+ farewell) — the longer exchange lands more;
 * - sentiment: warm small talk refills more than a snide remark, and a cold
 *   exchange pays much less (scaled harder on the negative side, like the LLM
 *   formula's floor of 1);
 * - the speaker's friendship for the other: talking to a friend fills you up
 *   more than talking to a stranger.
 *
 * A typical friendly exchange lands at 6–10. It is capped at TEMPLATE_SOCIAL_MAX
 * (10), below a warm LLM chat's 11–15, so real conversations keep a reason to
 * exist.
 */
export function templateSocialGain(params: {
  sentiment: number;
  turns: number;
  /** The receiving agent's friendship toward the other speaker (-100..100). */
  friendship: number;
}): number {
  const { sentiment, turns, friendship } = params;
  const turnPart = 1.2 * clamp(turns, 1, 4);
  const sentimentPart = sentiment >= 0 ? sentiment * 4 : sentiment * 6;
  const bondPart = clamp(friendship, 0, 100) / 100 * 1.5;
  return clamp(3.5 + turnPart + sentimentPart + bondPart, TEMPLATE_SOCIAL_MIN, TEMPLATE_SOCIAL_MAX);
}
