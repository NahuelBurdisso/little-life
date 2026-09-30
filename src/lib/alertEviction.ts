import type { AlertTier } from '../../server/lib/alertTiers';

/** Lower number = evicted first. A minor toast is a glance; the player's own outcome is what they asked for. */
const EVICTION_RANK: Record<AlertTier, number> = { minor: 0, major: 1, player: 2 };

/**
 * Which toasts stay when more than `max` are up. The old rule was "keep the
 * newest three", so a burst of minor toasts (a favourite's small moments) pushed
 * a major headline or the player's own outcome off the screen before it could be
 * read. Now the lowest tier goes first (minor, then major, then player) and,
 * inside one tier, the oldest. The survivors keep their arrival order.
 *
 * Items are assumed to be in arrival order (oldest first), which is how the hook
 * appends them, so "oldest within a tier" is simply the lowest index.
 */
export function evictToasts<T extends { tier: AlertTier }>(items: readonly T[], max: number): T[] {
  const excess = items.length - max;
  if (excess <= 0) return [...items];
  const order = items
    .map((item, index) => ({ index, rank: EVICTION_RANK[item.tier] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const dropped = new Set(order.slice(0, excess).map((o) => o.index));
  return items.filter((_, index) => !dropped.has(index));
}
