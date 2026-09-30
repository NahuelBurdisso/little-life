// server/lib/stateDurations.ts
import type { StateType } from '../data/stateTypes';

/**
 * How long a fixed-length agent state lasts when something other than its own
 * native trigger creates it, in GAME MINUTES, as a [min, max) range rolled
 * uniformly.
 *
 * Two writers need this and used to disagree with the native triggers in
 * engine/systems/states.ts: the state-expiry cascades (drunk → hungover/angry)
 * had their own four-row switch, and the ripple engine gave EVERY cascade state
 * a flat 120 minutes. A heartbreak from a cascade (a partner's affair exposed)
 * then lasted two hours where a native one lasts days, and a cascade `angry`
 * expired long before the 480-minute mark at which a lasting anger turns into
 * a grudge — so the cascade's worst outcomes left no mark. One table keeps both
 * in line with what the native triggers roll.
 *
 * Pure (no DB) so the ripple engine and the states phase can share it without
 * an import cycle, and so tests can pin it without a world.
 *
 * Deliberately absent: the conditional-exit states whose native triggers use
 * the 999999 "until the condition clears" convention and that a cascade can
 * create with their condition intact (stressed, lonely, in_debt, infatuated
 * with a target). Their duration is never read (expiry skips conditionalExit
 * states), so callers keep their own fallback. `jealous` IS listed: a cascade
 * jealousy has no love triangle in its metadata, so its exit falls back to
 * `started_at + duration` (states.ts checkConditionalExits) and needs a real
 * length — ~1-1.5 game days, the same span as the native safety valve.
 */
const STATE_DURATION_RANGES: Partial<Record<StateType, readonly [number, number]>> = {
  drunk: [120, 240], //          2-4 hours (native drinking)
  hungover: [180, 360], //       3-6 hours
  sick: [360, 1080], //          6-18 hours
  angry: [180, 720], //          3-12 hours (native bad conversation)
  euphoric: [120, 360], //       2-6 hours
  confident: [480, 960], //      8-16 hours
  heartbroken: [2880, 7200], //  2-5 game days (native romance drop rolls 2-7)
  jealous: [1440, 2160], //      1-1.5 game days, see above
};

/** `depressed` has no fixed length: it lifts by condition (states.ts), never by clock. */
const OPEN_ENDED: ReadonlySet<StateType> = new Set<StateType>(['depressed']);
const OPEN_ENDED_DURATION = 999999;

/**
 * A rolled duration in game minutes for `type`, or `null` when the table has no
 * opinion (the caller's fallback applies). `random` is injectable for tests;
 * the default reads `Math.random` at call time so a spied `Math.random` works.
 */
export function rollStateDuration(type: string, random: () => number = Math.random): number | null {
  if (OPEN_ENDED.has(type as StateType)) return OPEN_ENDED_DURATION;
  const range = STATE_DURATION_RANGES[type as StateType];
  if (!range) return null;
  const [min, max] = range;
  return Math.floor(min + random() * (max - min));
}
