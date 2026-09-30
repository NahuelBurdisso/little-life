/**
 * The budget for conversation-sourced mood modifiers.
 *
 * Why this exists. Every chat appended a fresh `conversation` modifier (+5 x sentiment, two
 * game hours; a template chat 3 x sentiment) with no de-duplication, and the needs phase adds up
 * every active modifier (engine/systems/needs.ts step 11). The other writers (`addMoodModifier`
 * in dailyLife.ts, family, milestones...) replace by source, so a source can only ever weigh in
 * once; conversations were the exception. Late in a run, friendships are warm and chats frequent,
 * and a busy afternoon stacked a dozen +4s: a likely cause of the late-run mood creep.
 *
 * The rule: all ACTIVE conversation-sourced modifiers together stay within +/-6 (a bit more than
 * one glowing chat). When a new chat would break that, the oldest chats are forgotten first, so
 * the newest always counts. Pure so the arithmetic is testable without a database.
 */

export interface MoodModifier {
  source: string;
  value: number;
  expiresAt: number;
}

/** Sources that come from talking to someone (LLM chats and template chats). */
const CONVERSATION_MOOD_SOURCES: ReadonlySet<string> = new Set(['conversation', 'template_conversation']);

/** Largest combined pull, up or down, that chats may have on the mood at once. */
export const CONVERSATION_MOOD_CAP = 6;

/**
 * `mods` plus one new conversation modifier, with the conversation-sourced ones trimmed to the
 * budget. Other sources are returned untouched (the needs phase expires them); conversation
 * modifiers that have already expired are dropped, since they no longer weigh in. Oldest
 * (earliest in the array) go first; a lone modifier larger than the cap is clamped to it.
 * `nowMinutes` is the game minute the chat happened at. The input array is not mutated.
 */
export function addConversationModifier(
  mods: readonly MoodModifier[],
  entry: MoodModifier,
  nowMinutes: number,
  cap: number = CONVERSATION_MOOD_CAP,
): MoodModifier[] {
  const others = mods.filter((m) => !CONVERSATION_MOOD_SOURCES.has(m.source));
  const chats = mods.filter((m) => CONVERSATION_MOOD_SOURCES.has(m.source) && m.expiresAt > nowMinutes);
  chats.push({ ...entry, value: Math.max(-cap, Math.min(cap, entry.value)) });
  const total = () => chats.reduce((s, m) => s + m.value, 0);
  // Never drops the newest (the last one): it is the chat that just happened.
  while (chats.length > 1 && Math.abs(total()) > cap) chats.shift();
  return [...others, ...chats];
}
