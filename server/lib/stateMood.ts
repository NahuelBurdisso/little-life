// server/lib/stateMood.ts
import type { StateType } from '../data/stateTypes';

/**
 * How much an active state weighs on (or lifts) the mood, in mood points,
 * applied by the needs phase every tick while the state lasts.
 *
 * Why this exists. The needs phase rebuilds mood from scratch each tick (needs,
 * modifiers, weather, momentum), so the states that "hurt" did it by writing
 * `needs.mood` directly — a grieving widow, a jilted lover, a man in a cell all
 * read as content as their needs allowed, because each direct write was gone by
 * the next tick. The states now feed the rebuild instead.
 *
 * Only the strongest negative and the strongest positive count (not the sum):
 * a heartbroken, jealous, indebted resident is miserable, but stacking every
 * state would crater them to zero and straight into the "terrible days → leave
 * town" loop (moodMomentum / populationFlow). Values stay well under the
 * bad-day margin on their own: a griever at baseline 64 with fair needs sits
 * around the high 40s, above the 44 bad-day bar, and only neglected needs on
 * top push them under.
 */
export const STATE_MOOD: Readonly<Partial<Record<StateType, number>>> = {
  grieving: -18,
  heartbroken: -15,
  arrested: -12,
  jealous: -8,
  in_debt: -8,
  angry: -6,
  euphoric: 8,
};

/** Net mood effect of `states`: the worst negative plus the best positive. */
export function stateMoodEffect(states: readonly string[]): number {
  let worst = 0;
  let best = 0;
  for (const s of states) {
    const v = STATE_MOOD[s as StateType];
    if (v === undefined) continue;
    if (v < worst) worst = v;
    if (v > best) best = v;
  }
  return worst + best;
}

/**
 * Stress a shock leaves behind fades by this much per game minute (~5 per game
 * hour). Stress was rebuilt from the needs every tick, so a breakdown's +25 or a
 * witnessed crime's +15 vanished on the next tick; now the needs-based value is
 * a floor and anything above it bleeds off over a few hours.
 */
export const STRESS_RECOVERY_PER_MIN = 5 / 60;

/** This tick's stress: the needs-based value, or what is left of an earlier shock. */
export function carriedStress(computed: number, prevStress: number, elapsedMinutes: number): number {
  return Math.max(computed, prevStress - STRESS_RECOVERY_PER_MIN * elapsedMinutes);
}
