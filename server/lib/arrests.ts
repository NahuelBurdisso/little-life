/**
 * What the constable can arrest someone for, and when.
 *
 * WHY: a 10-day soak at 32 residents made 29 arrests — the same few people, over and over.
 * The constable arrested anyone with 8+ "negative facts" (4+ with a crime they knew of), and
 *   - facts never expire, so a released resident walked out with the same record and was
 *     re-arrested the next time they shared a room with the constable;
 *   - the count included `arrest` facts, so every arrest made the next one likelier;
 *   - it included `seduction` — gossip about manipulation, not a crime — and `grudge`
 *     (someone holding a grudge is not an offence).
 * Now a sentence PAYS for the facts it was for (`shared_knowledge.paid_at`, the game minute
 * the sentence ends): the town still knows them and still gossips about them, but they no
 * longer count toward an arrest. A released resident also gets a cooldown before the
 * constable will look at them again, so a fresh arrest needs a fresh record AND some time.
 *
 * Pure except `markFactsPaid`.
 */
import { db } from '../db';
import { shared_knowledge } from '../db/schema';
import { inArray } from 'drizzle-orm';

/**
 * Fact types the constable acts on: the town's NEGATIVE_FACT_TYPES (gossip.ts) minus the ones
 * that are no crime — an earlier arrest, a seduction rumor, a grudge.
 */
export const ARRESTABLE_FACT_TYPES: ReadonlySet<string> = new Set([
  'theft', 'blackmail', 'gambling_loss', 'rumor', 'reputation', 'work_issue', 'drunk_incident', 'affair',
]);

/** Crimes that lower the bar when the constable knows of them first-hand. */
export const DIRECT_CRIME_TYPES: ReadonlySet<string> = new Set(['theft', 'blackmail']);

/** Game minutes after a sentence ends before the constable will arrest the same person again. */
export const POST_RELEASE_COOLDOWN_MINUTES = 3 * 1440;

interface FactLike {
  id: number;
  subject_id: number;
  type: string;
  is_active?: boolean | null;
  paid_at?: number | null;
}

/** Active, unpaid, arrestable facts per subject. */
export function arrestableFactsBySubject<F extends FactLike>(facts: readonly F[]): Map<number, F[]> {
  const out = new Map<number, F[]>();
  for (const f of facts) {
    if (f.is_active === false || f.paid_at != null || !ARRESTABLE_FACT_TYPES.has(f.type)) continue;
    const list = out.get(f.subject_id) ?? [];
    list.push(f);
    out.set(f.subject_id, list);
  }
  return out;
}

/** The game minute each subject's latest sentence ended (or ends), from the paid facts. */
export function lastSentenceEnds(facts: readonly FactLike[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const f of facts) {
    if (f.paid_at == null) continue;
    out.set(f.subject_id, Math.max(out.get(f.subject_id) ?? -Infinity, f.paid_at));
  }
  return out;
}

/** Whether `subjectId` is still inside the post-release cooldown at `nowMinutes`. */
export function inPostReleaseCooldown(lastEnds: ReadonlyMap<number, number>, subjectId: number, nowMinutes: number): boolean {
  const end = lastEnds.get(subjectId);
  return end != null && nowMinutes < end + POST_RELEASE_COOLDOWN_MINUTES;
}

/** The sentence for these facts ends at `releaseMinute`: they are paid for. */
export function markFactsPaid(factIds: readonly number[], releaseMinute: number): void {
  if (factIds.length === 0) return;
  db.update(shared_knowledge).set({ paid_at: releaseMinute }).where(inArray(shared_knowledge.id, [...factIds])).run();
}
