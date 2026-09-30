/**
 * Everyone's "usual self": the mood a resident drifts back to when nothing much is happening.
 *
 * WHY: a 30-day soak watched the town's mean mood climb from 71 to 91 and stay there, every
 * resident alike. Two things did it:
 *   1. Mood was the needs average plus modifiers, and in a working town the needs sit around
 *      75-85 all day — fed, rested, chatted-to — so contentment read as bliss.
 *   2. Mood momentum (moodMomentum.ts) gave a "good day" (average above 65, i.e. almost any
 *      day) up to +15 the next day, which made the next day good too: a positive feedback loop
 *      with nothing pulling back.
 * People adapt to comfort; they do not adapt nearly as fast to hunger or exhaustion (hedonic
 * adaptation, and a negativity bias). So the needs now count at half strength ABOVE the
 * resident's baseline and almost full strength below it, and momentum is measured against
 * the baseline with a loop gain under 1 (moodMomentum.ts). A cheerful, steady soul sits in
 * the low 70s on an ordinary good day, an anxious one in the high 50s, and the day's small
 * events (lib/dailyLife.ts, conversations, goals) move them from there.
 *
 * Pure; the client may import it.
 */
import type { PersonalityProfile } from './personality';

/** A neutral personality's baseline. */
export const MOOD_BASELINE_NEUTRAL = 64;
export const MOOD_BASELINE_MIN = 48;
export const MOOD_BASELINE_MAX = 76;

/** Share of the needs' surplus above baseline that reaches mood (adaptation to comfort). */
export const NEEDS_GAIN_ABOVE = 0.5;
/** Share of the needs' shortfall below baseline that reaches mood (want bites). */
export const NEEDS_GAIN_BELOW = 0.9;

/**
 * Temperament's set point: warmth and a clear conscience lift it, neuroticism weighs on it
 * most, impulsive people ride a little higher. Clamped to [48, 76].
 */
export function moodBaseline(p: PersonalityProfile | null | undefined): number {
  if (!p) return MOOD_BASELINE_NEUTRAL;
  const raw = MOOD_BASELINE_NEUTRAL
    + (p.warmth - 50) * 0.12
    - (p.neuroticism - 50) * 0.22
    + (p.impulsiveness - 50) * 0.05
    + (p.morality - 50) * 0.04;
  return Math.min(MOOD_BASELINE_MAX, Math.max(MOOD_BASELINE_MIN, raw));
}

/** The needs' contribution to mood, adapted around the baseline (see the header). */
export function adaptNeedsMood(needsComposite: number, baseline: number): number {
  const diff = needsComposite - baseline;
  return baseline + diff * (diff >= 0 ? NEEDS_GAIN_ABOVE : NEEDS_GAIN_BELOW);
}
