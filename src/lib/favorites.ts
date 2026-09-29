/**
 * Favourite residents for the cast bar, remembered per world.
 *
 * Agent ids restart at 1 in every world, so the ids are only meaningful next to
 * the world they came from: the store is keyed by the world's seed. A restart
 * replays the same seed and rebuilds the same town, which is exactly when the
 * player expects their stars to still be there; a new seed starts clean.
 *
 * Everything that touches `localStorage` is wrapped: it throws in private
 * windows and with blocked site data, and favourites are a convenience, not
 * something worth breaking the UI over.
 */

const KEY_PREFIX = "little-life:favorites:";

/** Seed to file favourites under when a world carries none (very old saves). */
const FALLBACK_SEED = "default";

/**
 * The seed a world was built from. `initialize` writes the resolved worldgen seed
 * back into `setup_config`; the scenario seed is the fallback for configs saved
 * before that write-back existed.
 */
export function worldSeedOf(setupConfig: unknown): string {
  if (setupConfig && typeof setupConfig === "object") {
    const c = setupConfig as { worldgen?: { seed?: unknown }; scenario?: { seed?: unknown } };
    for (const s of [c.worldgen?.seed, c.scenario?.seed]) {
      if (typeof s === "string" && s.trim()) return s.trim();
    }
  }
  return FALLBACK_SEED;
}

export function favoritesKey(seed: string): string {
  return KEY_PREFIX + seed;
}

/** Tolerant parse of the stored value: anything that isn't a list of ids is "no favourites". */
export function parseFavorites(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const ids = v.filter((x): x is string => typeof x === "string");
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/** Immutable toggle, so React state can hold the result directly. */
export function toggleFavorite(favorites: ReadonlySet<string>, agentId: string): Set<string> {
  const next = new Set(favorites);
  if (!next.delete(agentId)) next.add(agentId);
  return next;
}

export function loadFavorites(seed: string): Set<string> {
  try {
    return new Set(parseFavorites(localStorage.getItem(favoritesKey(seed))));
  } catch {
    return new Set();
  }
}

export function saveFavorites(seed: string, favorites: ReadonlySet<string>): void {
  try {
    localStorage.setItem(favoritesKey(seed), JSON.stringify([...favorites]));
  } catch {
    // Storage unavailable: the stars last for this session only.
  }
}

/**
 * Cast order: favourites first, everyone else after, each group keeping the order
 * the server sent (id order), so the bar and Tab cycling never reshuffle when
 * an unrelated resident changes activity.
 */
export function orderCast<T extends { id: number | string }>(
  agents: readonly T[],
  favorites: ReadonlySet<string>,
): T[] {
  const stars: T[] = [];
  const rest: T[] = [];
  for (const a of agents) (favorites.has(String(a.id)) ? stars : rest).push(a);
  return [...stars, ...rest];
}

/**
 * The next id when stepping through `order` (forward or back, wrapping). With
 * nothing selected — or a selection no longer in the list — forward lands on the
 * first resident and backward on the last. Empty list → null.
 */
export function cycleAgentId(
  order: readonly string[],
  current: string | null,
  direction: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  const i = current == null ? -1 : order.indexOf(current);
  if (i === -1) return direction === 1 ? order[0] : order[order.length - 1];
  return order[(i + direction + order.length) % order.length];
}
