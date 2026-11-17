/**
 * What a chat at a gathering is about, read in the same two places a social
 * call's topic is (../socialCalls/topics.ts):
 *
 *   - the LLM tier: `gatheringIntent` turns the topic into the opener's intent
 *     (ai/prompts.ts `topicIntent`), so two mourners at a funeral talk about the
 *     dead instead of "You want to talk about a funeral";
 *   - the template tier: the gathering scripts (data/gatheringScripts.ts) key on
 *     the queue entry's trigger (`gathering:<kind>`).
 *
 * Topics name the person where there is one ("remembering James at his
 * funeral"): the topic is also what the conversation row and the memories show.
 *
 * Pure: imported by ai/prompts.ts and the script data.
 */

/** The trigger_reason a gathering chat is queued with. */
export function gatheringTrigger(kind: string): string {
  return `gathering:${kind}`;
}

/** The gathering kind behind a trigger_reason, or null for any other conversation. */
export function gatheringKindOfTrigger(trigger: string | null | undefined): string | null {
  const m = /^gathering:([a-z_]+)/.exec(trigger ?? '');
  return m ? m[1] : null;
}

export const GATHERING_TOPIC = {
  funeral: (dead: string) => `remembering ${dead} at the funeral`,
  wake: (dead: string) => `drinking to ${dead} at the wake`,
  send_off: (leaver: string) => `seeing ${leaver} off`,
  market: 'market day: prices, wares and news',
  fire: (place: string) => `the fire at ${place}`,
  wedding: (couple: string) => `the wedding of ${couple}`,
  christening: (child: string) => `the christening of little ${child}`,
} as const;

/**
 * The opener's intent for a gathering topic, or null when the topic is not a
 * gathering's. Both people are at the same occasion; the opener starts on it.
 */
export function gatheringIntent(topic: string, other: string): string | null {
  const t = topic.trim();
  let m = /^remembering (.+) at the funeral$/i.exec(t);
  if (m) return `You and ${other} are at ${m[1]}'s funeral. Speak quietly about ${m[1]}: a memory of them, what they meant to you, how ${other} is bearing up.`;
  m = /^drinking to (.+) at the wake$/i.exec(t);
  if (m) return `You and ${other} are at the tavern after ${m[1]}'s funeral, drinking to their memory. Tell a story about ${m[1]} — a funny one if you have it.`;
  m = /^seeing (.+) off$/i.exec(t);
  if (m) return `${m[1]} is leaving town this morning for good and you have come to see them off with ${other}. Say what you'll miss, or wonder aloud why it came to this.`;
  if (/^market day: prices, wares and news$/i.test(t)) return `It is market day and you have run into ${other} among the stalls. Talk about what you are buying or selling, the prices, and any news going round.`;
  m = /^the fire at (.+)$/i.exec(t);
  if (m) return `A fire has broken out at ${m[1]} and you and ${other} are there with the buckets. Speak in short, urgent lines: the blaze, who is inside, what to do next.`;
  m = /^the wedding of (.+)$/i.exec(t);
  if (m) return `You and ${other} are guests at the wedding of ${m[1]}. Talk about the couple, the ceremony, the dancing.`;
  m = /^the christening of little (.+)$/i.exec(t);
  if (m) return `You and ${other} are at the christening of little ${m[1]}. Talk about the baby and the family.`;
  return null;
}
