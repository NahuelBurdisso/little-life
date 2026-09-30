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

/** A scenario mood below this is a "troubled start" worth carrying into the first day. */
const TROUBLED_START_MOOD = 50;
/** The mood a troubled start is measured down from, and the deepest pull allowed. */
const START_MOOD_NEUTRAL = 60;
const START_MOOD_MAX_PULL = 20;
/** One game day: long enough to colour the opening, short of a bad-day streak. */
const START_MOOD_MINUTES = 1440;

/**
 * The opening mood modifiers for a resident the scenario starts low (the drama
 * slider's low-mood residents, setupGenerator: mood 30-45).
 *
 * Why: the needs phase rebuilds `needs.mood` from the needs every tick, so the
 * scenario's seeded mood lasted exactly one tick and every resident opened the
 * game in the same fair spirits. A modifier (which that phase sums) keeps the
 * troubled start for the first game day. Capped at -20 and one day so that one
 * bad day cannot turn into the three-day streak that makes someone leave town
 * (moodMomentum / populationFlow). Moods at or above 50 get nothing: the
 * default spread is left to the needs, as before. Stress needs no such help:
 * the needs phase now carries seeded stress over and lets it fade.
 */
export function startingMoodModifiers(
  scenarioMood: number | undefined,
  startMinute: number,
): { source: string; value: number; expiresAt: number }[] {
  if (scenarioMood === undefined || scenarioMood >= TROUBLED_START_MOOD) return [];
  const value = Math.max(-START_MOOD_MAX_PULL, scenarioMood - START_MOOD_NEUTRAL);
  return [{ source: 'troubled_start', value, expiresAt: startMinute + START_MOOD_MINUTES }];
}
