import type { PersonalityProfile } from './personality';

/**
 * The one definition of when an agent sleeps. decisions.ts (checkSchedule,
 * sleep length, the social-crisis check) and conversationPacing.ts (a talk
 * ends at bedtime) both read it; they used to carry copies of the same block,
 * and when one copy learned to wake workers before their shift the other kept
 * cutting those workers' conversations short "past bedtime" at work.
 *
 * Pure: no DB, safe for the client to import.
 */

export interface SleepScheduleInput {
  wakeTime: number;
  sleepTime: number;
  /** Only read when the agent has a workplace. */
  workStart?: number;
}

export type Chronotype = Pick<PersonalityProfile, 'impulsiveness' | 'sensuality' | 'morality' | 'neuroticism'>;

/**
 * The agent's personality-shifted sleep window, in whole hours: asleep from
 * `sleepHour` until `wakeHour` (wrapping midnight when sleepHour > wakeHour).
 *
 * Night owls (high impulsiveness, high sensuality) stay up later and wake
 * later; early birds (high morality, low impulsiveness) sleep earlier and wake
 * earlier; neurotic agents shift half as far.
 *
 * A worker never sleeps into the shift: the wake hour is pulled to an hour
 * before `workStart` (the commute is ~1 h in a mid-sized town), or to the
 * schedule's own wake time if that is later. A +2 h owl on an 8:00 shift slept
 * through the first two hours of it every day.
 */
export function effectiveSleepWindow(
  schedule: SleepScheduleInput,
  personality: Chronotype | null,
  hasWorkplace = false,
): { sleepHour: number; wakeHour: number } {
  let sleepShift = 0; // hours; positive = later
  if (personality) {
    sleepShift += (personality.impulsiveness - 50) * 0.02;
    sleepShift += (personality.sensuality - 50) * 0.01;
    sleepShift -= (personality.morality - 50) * 0.015;
    if (personality.neuroticism > 60) sleepShift *= 0.5;
    sleepShift = Math.max(-2, Math.min(3, Math.round(sleepShift)));
  }
  // A bedtime after midnight (0, 1, 2) is the END of the 19..26 range, not its start: read as the
  // literal hour 1 the clamp below floored it to 19:00, so the wizard's night owls (sleepTime 1) went
  // to bed at 19:00 and slept through the evening.
  const baseSleepTime = schedule.sleepTime < 12 ? schedule.sleepTime + 24 : schedule.sleepTime;
  const sleepHour = Math.max(19, Math.min(26, baseSleepTime + sleepShift)) % 24 || 24;
  let wakeHour = Math.max(4, Math.min(12, schedule.wakeTime + sleepShift));
  const start = schedule.workStart;
  if (hasWorkplace && start !== undefined && start > schedule.wakeTime) {
    wakeHour = Math.min(wakeHour, Math.max(schedule.wakeTime, start - 1));
  }
  return { sleepHour, wakeHour };
}

/** Is `hour` inside the window (see `effectiveSleepWindow`)? */
export function inSleepWindow(window: { sleepHour: number; wakeHour: number }, hour: number): boolean {
  const { sleepHour, wakeHour } = window;
  return sleepHour > wakeHour ? hour >= sleepHour || hour < wakeHour : hour >= sleepHour && hour < wakeHour;
}

/**
 * How long a sleep started now lasts: the usual night, but never past the
 * wake-up time. Sleep is one fixed-length action (360 minutes), so a second
 * sleep started in the small hours — after a night-time errand, or when a
 * 22:00 bedtime ended at 04:00 still inside the window — ran six more hours,
 * to 10:00 and into the shift. An energy emergency keeps the full length: that
 * sleep is about the tank, not the clock. At least an hour.
 */
export function sleepDurationMinutes(
  nowHour: number,
  nowMinute: number,
  wakeHour: number,
  fullLength: number,
  emergency: boolean,
): number {
  if (emergency) return fullLength;
  const untilWake = (wakeHour * 60 - (nowHour * 60 + nowMinute) + 1440) % 1440;
  return Math.max(60, Math.min(fullLength, untilWake));
}
