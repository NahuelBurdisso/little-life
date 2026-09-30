/**
 * The adults-only rule at seed time.
 *
 * `mayRomanceGrow` (attraction.ts) guards every romance gain while the town runs,
 * but a town is born with relationships already written: the wizard lets the
 * player type any romance for any pair (and give any agent an age from 16),
 * the drama generator's romance threads and the default cast's authored crushes
 * all land in `relationships` without passing a tick. This module is the single
 * pass every seed path runs over its rows so no minor starts out as anyone's
 * crush, partner or affair. It is pure (no DB, no clock) so the tests can walk
 * it and seedWorld / seed.ts can share it.
 *
 * Only minors are sanitised here. A seeded romance that merely disagrees with
 * someone's orientation is fine: orientation assignment already adapts to the
 * seeded crushes (orientation.ts).
 */

import { isAdultAge } from './eligibility';

/** Tags that say "these two are romantically involved". Stripped from a minor's pair. */
const ROMANTIC_TAGS: ReadonlySet<string> = new Set([
  'crush', 'partner', 'romantic', 'engaged', 'married', 'kissed', 'lovers',
]);

/** Statuses that describe a romantic tie (derived ones and the wizard's freer wording). */
const ROMANTIC_STATUSES: ReadonlySet<string> = new Set([
  'romantic_interest', 'partners', 'complicated', 'lovers', 'romantic', 'engaged', 'married',
]);

/** Secret / fact types that are about an affair or a crush. */
const ROMANTIC_SECRET_TYPES: ReadonlySet<string> = new Set([
  'affair', 'secret_fling', 'forbidden', 'crush', 'romantic', 'seduction',
]);

/**
 * Secret templates whose text is romantic even though their category is not
 * ('witness' + "saw {target} sneaking out of someone else's home late at night").
 */
const ROMANTIC_SECRET_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  'witness_affair', 'witness_secret_meeting',
]);

/** The bits of an agent the sanitiser reads. Missing age reads as a minor. */
export interface SeedAgent {
  id: number;
  age: number;
}

/** The bits of a relationship row it reads and may rewrite. */
export interface SeedRelationshipRow {
  agent_a: number;
  agent_b: number;
  friendship_ab: number;
  friendship_ba: number;
  romance_ab: number;
  romance_ba: number;
  tags: string[];
  status: string;
}

/** Ids of the agents who are (fail-closed) adults; anyone not listed is not. */
export function adultIdSet(agents: ReadonlyArray<SeedAgent>): Set<number> {
  return new Set(agents.filter((a) => isAdultAge(a.age)).map((a) => a.id));
}

/** A friendship-derived stand-in for a romantic status. */
function friendshipStatus(row: SeedRelationshipRow): string {
  return (row.friendship_ab + row.friendship_ba) / 2 > 40 ? 'friends' : 'acquaintances';
}

/**
 * Rows with every minor-involving pair stripped of romance: both directions
 * capped at 0 (a seeded dislike stays), romantic tags removed and a romantic
 * status replaced by a friendship-derived one. Adult pairs and pairs naming an
 * unknown agent id are handled per the fail-closed rule (unknown = not adult).
 * Returns new row objects for changed pairs and the original object otherwise.
 */
export function sanitizeSeedRomance<R extends SeedRelationshipRow>(
  agents: ReadonlyArray<SeedAgent>,
  rows: ReadonlyArray<R>,
): R[] {
  const adults = adultIdSet(agents);
  return rows.map((row) => {
    if (adults.has(row.agent_a) && adults.has(row.agent_b)) return row;
    const tags = row.tags.filter((t) => !ROMANTIC_TAGS.has(t));
    const status = ROMANTIC_STATUSES.has(row.status) ? friendshipStatus(row) : row.status;
    const romance_ab = Math.min(row.romance_ab, 0);
    const romance_ba = Math.min(row.romance_ba, 0);
    if (
      tags.length === row.tags.length && status === row.status
      && romance_ab === row.romance_ab && romance_ba === row.romance_ba
    ) return row;
    return { ...row, tags, status, romance_ab, romance_ba };
  });
}

/** Is a secret of this type / template about romance or an affair? */
export function isRomanticSecret(secret: { type: string; template_id?: string | null }): boolean {
  return ROMANTIC_SECRET_TYPES.has(secret.type)
    || (secret.template_id != null && (
      secret.template_id.startsWith('romantic_') || ROMANTIC_SECRET_TEMPLATE_IDS.has(secret.template_id)
    ));
}

/**
 * May this seeded secret exist? A romantic one is dropped when its subject or
 * its target is not an adult; every other kind of secret always passes.
 */
export function mayKeepSeedSecret(
  adults: ReadonlySet<number>,
  secret: { type: string; template_id?: string | null; subjectId: number; targetId: number | null },
): boolean {
  if (!isRomanticSecret(secret)) return true;
  return adults.has(secret.subjectId) && (secret.targetId == null || adults.has(secret.targetId));
}
