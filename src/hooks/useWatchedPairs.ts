import { useCallback, useEffect, useState } from "react";
import { loadWatchedPairs, pairKey, saveWatchedPairs, toggleWatchedPair } from "../lib/favorites";

/**
 * Watched pairs for the world with this seed, as "lo-hi" keys. Same shape as
 * useFavorites: re-read when the seed changes, written back on every toggle.
 */
export function useWatchedPairs(seed: string) {
  // Seed kept next to the set so a seed change can't paint (or save) the old
  // world's pairs under the new key for a render.
  const [state, setState] = useState(() => ({ seed, pairs: loadWatchedPairs(seed) }));

  useEffect(() => {
    setState((s) => (s.seed === seed ? s : { seed, pairs: loadWatchedPairs(seed) }));
  }, [seed]);

  const watchedPairs = state.seed === seed ? state.pairs : loadWatchedPairs(seed);

  const toggle = useCallback(
    (a: number, b: number) => {
      setState((s) => {
        const base = s.seed === seed ? s.pairs : loadWatchedPairs(seed);
        const pairs = toggleWatchedPair(base, a, b);
        saveWatchedPairs(seed, pairs);
        return { seed, pairs };
      });
    },
    [seed],
  );

  const isWatched = useCallback((a: number, b: number) => watchedPairs.has(pairKey(a, b)), [watchedPairs]);

  return { watchedPairs, toggleWatchedPair: toggle, isWatched };
}
