/**
 * Who counts as new in town, for the people who talk to them.
 *
 * Why this exists: a town of a dozen households around 1900 has no strangers.
 * Everybody knows everybody by sight, by trade and by what the neighbours say,
 * even the pairs who have never had a real conversation — which after five game
 * days was still 54 of 78 (playtest #3). The dialogue prompt used to treat every
 * such pair as a first meeting ("Introduce yourself…"), and the model obliged:
 * "Well, I am Thomas Park, the Mayor", Diego to his old schoolteacher "Hey
 * there! I'm Diego." Only someone who actually arrived recently
 * (lib/residents.ts `createResident`, from population flow or the player's
 * New Resident) is met for the first time.
 *
 * Pure, no DB: callers pass `agents.created_at`, which is stamped on the TICK
 * clock (founders carry 0), and the world's `totalTicks`.
 */

/** Game days someone stays "new in town" — long enough for the town to meet them once. */
export const NEWCOMER_DAYS = 3;
const MINUTES_PER_DAY = 1440;

/**
 * Whether a resident created at `createdAtTick` is still new in town at
 * `nowTick`. Founders (created with the world, `created_at` 0) never are; a
 * stamp in the future (a restored save) is not trusted either.
 */
export function isNewcomer(createdAtTick: number | null | undefined, nowTick: number): boolean {
  if (createdAtTick == null || createdAtTick <= 0) return false;
  const age = nowTick - createdAtTick;
  return age >= 0 && age < NEWCOMER_DAYS * MINUTES_PER_DAY;
}
