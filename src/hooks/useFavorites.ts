import { useCallback, useEffect, useState } from "react";
import { loadFavorites, saveFavorites, toggleFavorite } from "../lib/favorites";

/**
 * Starred residents for the world with this seed. The set is re-read when the
 * seed changes (a new world), and written back on every toggle.
 */
export function useFavorites(seed: string) {
  // Keep the seed next to the set so a seed change can't paint the old world's
  // stars for one render, or worse, save them under the new key.
  const [state, setState] = useState(() => ({ seed, ids: loadFavorites(seed) }));

  useEffect(() => {
    setState((s) => (s.seed === seed ? s : { seed, ids: loadFavorites(seed) }));
  }, [seed]);

  const favorites = state.seed === seed ? state.ids : loadFavorites(seed);

  const toggle = useCallback(
    (agentId: string) => {
      setState((s) => {
        const base = s.seed === seed ? s.ids : loadFavorites(seed);
        const ids = toggleFavorite(base, agentId);
        saveFavorites(seed, ids);
        return { seed, ids };
      });
    },
    [seed],
  );

  return { favorites, toggleFavorite: toggle };
}
