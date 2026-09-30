/**
 * Goal overlap — the same wish written again.
 *
 * `isRedundantGoal` only compares type and target, and returns false for a goal
 * about no one, so the morning review could start "Find out who the hooded
 * figure is" for the fourth time the day after giving up on the third, and
 * half the town could chase it at once (playtest #4: 9 of ~30 active goals).
 * This compares what the goals SAY: their content words.
 */

import { and, eq, gte, ne, or } from 'drizzle-orm';
import { db } from '../../db';
import { goals } from '../../db/schema';

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'about', 'from', 'into', 'over',
  'my', 'me', 'i', 'his', 'her', 'their', 'them', 'him', 'she', 'he', 'they', 'it', 'its', 'this', 'that', 'what', 'who',
  'is', 'are', 'be', 'if', 'as', 'so', 'more', 'some', 'way', 'find', 'out', 'try', 'get', 'make', 'keep', 'see', 'learn',
  'someone', 'something', 'town', 'really', 'up', 'down', 'again', 'without',
]);

/** Content words, lightly stemmed ("strangers" → "stranger"). Pure. */
export function goalWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z']+/g) ?? []) {
    const w = raw.replace(/'s$/, '').replace(/(?<=[a-z]{3})s$/, '');
    if (w.length > 2 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/** Share of the smaller goal's words the other one also has. Pure. */
export function goalOverlap(a: string, b: string): number {
  const wa = goalWords(a);
  const wb = goalWords(b);
  const small = Math.min(wa.size, wb.size);
  if (small === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / small;
}

export const OVERLAP_SAME_GOAL = 0.5;
/** Active goals anyone in town may hold on one subject. */
export const MAX_TOWN_GOALS_PER_SUBJECT = 2;
/** How long a finished goal still counts as "already tried". */
const RECENT_MINUTES = 3 * 1440;

/**
 * Whether a new goal repeats one of the agent's own (active, or ended in the
 * last three days) or joins a subject that already has enough of the town
 * chasing it.
 */
export function repeatsExistingGoal(agentId: number, description: string, nowMinutes: number): boolean {
  const rows = db.select({ agent_id: goals.agent_id, status: goals.status, description: goals.description, strategy: goals.strategy })
    .from(goals)
    .where(or(eq(goals.status, 'active'), and(eq(goals.agent_id, agentId), ne(goals.status, 'active'), gte(goals.completed_at, nowMinutes - RECENT_MINUTES))))
    .all();
  let townWide = 0;
  for (const g of rows) {
    if (!g.description) continue;
    if (goalOverlap(description, g.description) < OVERLAP_SAME_GOAL) continue;
    if (g.agent_id === agentId) return true;
    if (g.status === 'active') townWide++;
  }
  return townWide >= MAX_TOWN_GOALS_PER_SUBJECT;
}
