/**
 * Goal wording shared by the feed (activityMessage.ts) and agents' memories
 * (MemoryObserver.ts).
 *
 * A goal's text comes from two authors that agree on nothing: trigger- and
 * cascade-made goals carry a GOAL_REGISTRY key ("revenge", "steal_from"),
 * LLM-made ones an imperative sentence ("Assess the situation with Marco.")
 * that may arrive with its own full stop or a run of dots where the model cut
 * itself off. Spliced raw, memories read "I've decided to Assess the situation
 * with Marco....." (G9).
 *
 * Pure: the client imports activityMessage.ts, which imports this.
 */

/** Registry keys in prose. */
const GOAL_PHRASES: Record<string, string> = {
  revenge: 'getting revenge',
  seduce: 'winning someone over',
  steal_from: 'stealing from someone',
  protect: 'looking after someone',
  investigate: 'digging up the truth',
  undermine: 'undermining a rival',
  pay_debt: 'paying off a debt',
  get_sober: 'getting sober',
  befriend: 'making a friend',
  comfort_grieving: 'comforting someone grieving',
  campaign: 'winning the election for mayor',
};

/** A bare registry-style key: lowercase words joined by underscores. */
const KEY = /^[a-z]+(?:_[a-z]+)*$/;

/**
 * The goal as a phrase to follow a colon ("…a new goal: <clause>"): a key
 * becomes prose; LLM text is trimmed and loses its trailing full stops — a
 * trailing run of dots or an ellipsis (a cut-off) is kept as one "…". A
 * question or exclamation mark stays. Capitalisation is left alone on purpose:
 * the callers put the clause after a colon, where an imperative's capital
 * reads fine, rather than after "decided to", which needed the first word
 * lowercased and can't tell a verb from a name ("Marco and I…").
 */
export function goalClause(raw: unknown): string {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return 'a goal';
  if (KEY.test(text)) return GOAL_PHRASES[text] ?? text.replace(/_/g, ' ');
  const tail = text.match(/[\s.…]+$/)?.[0] ?? '';
  const body = text.slice(0, text.length - tail.length);
  const cutOff = tail.includes('…') || /\.{2,}/.test(tail);
  return cutOff ? `${body}…` : body;
}
