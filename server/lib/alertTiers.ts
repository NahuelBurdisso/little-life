/**
 * Which feed rows interrupt the player as a toast, and how loudly.
 *
 * Pure (no DB), so the rule is tested on its own and the client can share the
 * tier names. `activity.getAlerts` runs every new row through `alertTier`.
 *
 *   player — what the player's own meddling came to (lib/playerOutcomes.ts),
 *            and their challenges completing or failing (lib/challenges/).
 *            Always shown: they asked for it.
 *   major  — the town's big moments: heavy drama, world events, a changed life
 *            ambition, and the relationship statuses that rewrite a pair
 *            (partners, enemies, estranged).
 *   minor  — worth a quiet toast: a best friendship, a romance gone
 *            complicated, a goal reached — and, for the player's favourite
 *            residents only, anything social that clears a lower bar.
 *
 * A watched pair (the player follows two people's story, not each of them) adds
 * to that: every status change of the pair is major, a night together and any
 * other social moment between exactly those two is minor. A row that has only
 * one of them in it says nothing about the pair, so it does not count.
 *
 * Only drama/world_event/aspiration rows at ≥ 0.8 used to alert, so "X and Y
 * are now partners" (0.7) and every goal completion scrolled by unseen.
 */

export type AlertTier = 'player' | 'major' | 'minor';

export interface AlertCandidate {
  type: string;
  category: string;
  importance: number;
  agent_ids?: number[] | null;
  initiator_id?: number | null;
  target_id?: number | null;
  template_data?: Record<string, unknown> | null;
}

/** The old rule: categories whose ≥ 0.8 rows are headline material. */
const MAJOR_CATEGORIES = new Set(['drama', 'world_event', 'aspiration']);
export const MAJOR_IMPORTANCE = 0.8;

/**
 * Kisses (lib/intimacy/kiss.ts) never interrupt on their own account. A refusal
 * is registered as a drama row (importance 0.5), which would otherwise toast for
 * a favourite; it is a private embarrassment and reads better in the feed. A
 * first kiss is not listed: its 0.65 relationship row already earns the minor
 * toast for the player's favourites and nothing else.
 */
const QUIET_TYPES = new Set(['kiss', 'kiss_rebuffed']);

const PLAYER_TYPES = new Set(['player_outcome', 'player_nudge_expired', 'challenge_completed', 'challenge_failed']);

/** Status changes that rewrite a pair's story for everyone watching. */
const MAJOR_STATUSES = new Set(['partners', 'enemies', 'estranged']);
/** Status changes worth a quieter toast. */
const MINOR_STATUSES = new Set(['best_friends', 'complicated']);

/**
 * A favourite's row alerts from this importance up, in these categories:
 * their smaller dramas, friendships, goals and moments with others — not
 * their meals, wages or plans.
 */
export const FAVORITE_IMPORTANCE = 0.5;
const FAVORITE_CATEGORIES = new Set(['drama', 'relationship', 'goal', 'aspiration', 'social', 'interaction', 'world_event']);

/** Lowest importance any rule can accept; the router pre-filters on it in SQL. */
export const MIN_ALERT_IMPORTANCE = FAVORITE_IMPORTANCE;

function involves(row: AlertCandidate, ids: ReadonlySet<number>): boolean {
  if (ids.size === 0) return false;
  for (const id of row.agent_ids ?? []) if (ids.has(id)) return true;
  return (row.initiator_id != null && ids.has(row.initiator_id)) || (row.target_id != null && ids.has(row.target_id));
}

/**
 * True when both ids of one watched pair are in the row. `pairs` holds "lo-hi"
 * keys (lower id first), so (3,1) and (1,3) are the same pair; the ids are read
 * from the same fields `involves` reads.
 */
export function involvesPair(row: AlertCandidate, pairs: ReadonlySet<string>): boolean {
  if (pairs.size === 0) return false;
  const ids = new Set<number>(row.agent_ids ?? []);
  if (row.initiator_id != null) ids.add(row.initiator_id);
  if (row.target_id != null) ids.add(row.target_id);
  for (const key of pairs) {
    const [lo, hi] = key.split('-').map(Number);
    if (ids.has(lo) && ids.has(hi)) return true;
  }
  return false;
}

export function alertTier(
  row: AlertCandidate,
  favoriteIds: ReadonlySet<number> = new Set(),
  watchedPairs: ReadonlySet<string> = new Set(),
): AlertTier | null {
  if (PLAYER_TYPES.has(row.type)) return 'player';
  if (QUIET_TYPES.has(row.type)) return null;

  // The pair the player follows: their status changes are the story, whatever the
  // status; a night together is a quiet toast. Both come before the favourite
  // rules below, which would demote the first to a minor and silence the second.
  const watched = involvesPair(row, watchedPairs);
  if (watched && row.type === 'relationship_status_change') return 'major';
  if (watched && row.type === 'tryst') return 'minor';

  // The adult layer's rows (lib/intimacy/tryst.ts). A night together is nobody's
  // business but the couple's: quiet, a toast only for the player's favourites.
  // Being seen slipping out at dawn is the scandal: it interrupts for a favourite
  // (major) and is worth a quiet toast for anyone else.
  if (row.type === 'tryst') return involves(row, favoriteIds) ? 'minor' : null;
  if (row.type === 'caught') return involves(row, favoriteIds) ? 'major' : 'minor';
  // The town noticing an unwed pregnancy (lib/intimacy/pregnancy.ts): headline news.
  if (row.type === 'scandal') return 'major';

  if (row.type === 'relationship_status_change') {
    const status = String(row.template_data?.status ?? '');
    if (MAJOR_STATUSES.has(status)) return 'major';
    if (MINOR_STATUSES.has(status)) return 'minor';
    return involves(row, favoriteIds) ? 'minor' : null;
  }
  if (row.type === 'goal_completed') return 'minor';

  if (MAJOR_CATEGORIES.has(row.category) && row.importance >= MAJOR_IMPORTANCE) return 'major';

  if (
    FAVORITE_CATEGORIES.has(row.category) &&
    row.importance >= FAVORITE_IMPORTANCE &&
    involves(row, favoriteIds)
  ) return 'minor';

  // Last, so it can only raise a row nothing above wanted (a `caught` row of a
  // watched pair keeps its major for a favourite, a drama at 0.8 stays major).
  if (watched && FAVORITE_CATEGORIES.has(row.category) && row.importance >= FAVORITE_IMPORTANCE) return 'minor';

  return null;
}
