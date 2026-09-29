import { CONFIG } from './constants';

export interface StartingNeeds {
  hunger: number;
  energy: number;
  social: number;
  comfort: number;
  fun: number;
}

/**
 * Opening need values for a freshly seeded agent (E7). Integers drawn uniformly
 * from `CONFIG.NEEDS.STARTING_RANGES` — see there for why the social and fun
 * floors sit at 50. Mood and stress are not here: the scenario sliders own them.
 *
 * `rand` is injectable so tests can pin the draw.
 */
export function startingNeeds(rand: () => number = Math.random): StartingNeeds {
  const r = CONFIG.NEEDS.STARTING_RANGES;
  const draw = ([min, max]: readonly [number, number]) => min + Math.floor(rand() * (max - min));
  return {
    hunger: draw(r.hunger),
    energy: draw(r.energy),
    social: draw(r.social),
    comfort: draw(r.comfort),
    fun: draw(r.fun),
  };
}
