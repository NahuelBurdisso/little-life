import { describe, expect, it } from 'vitest';
import { effectiveSleepWindow, inSleepWindow } from '../sleepSchedule';

// A bedtime after midnight ("sleepTime": 1 is the wizard's bartender and musician, 0 the baker's
// neighbour in the seed cast) is a LATE bedtime. It used to be clamped into the 19..26 range as the
// literal hour 1, which landed on the floor of the range: a night owl went to bed at 19:00, asleep
// through the evening the townsfolk spend together.
describe('effectiveSleepWindow: bedtimes after midnight', () => {
  const owl = { wakeTime: 10, workStart: 17 };

  it('reads 1 as 01:00, not 19:00', () => {
    expect(effectiveSleepWindow({ ...owl, sleepTime: 1 }, null, true)).toEqual({ sleepHour: 1, wakeHour: 10 });
  });

  it('reads 0 as midnight and 2 as 02:00', () => {
    expect(effectiveSleepWindow({ ...owl, sleepTime: 0 }, null, true).sleepHour).toBe(24);
    expect(effectiveSleepWindow({ ...owl, sleepTime: 2 }, null, true).sleepHour).toBe(2);
  });

  it('a night owl is awake at 20:00 and asleep at 03:00', () => {
    const w = effectiveSleepWindow({ ...owl, sleepTime: 1 }, null, true);
    expect(inSleepWindow(w, 20)).toBe(false);
    expect(inSleepWindow(w, 23)).toBe(false);
    expect(inSleepWindow(w, 3)).toBe(true);
  });

  it('leaves ordinary evening bedtimes alone', () => {
    expect(effectiveSleepWindow({ wakeTime: 7, sleepTime: 23, workStart: 8 }, null, true)).toEqual({ sleepHour: 23, wakeHour: 7 });
    expect(effectiveSleepWindow({ wakeTime: 5, sleepTime: 20, workStart: 6 }, null, true).sleepHour).toBe(20);
  });

  it('still clamps the personality shift to 19..02', () => {
    const early = { impulsiveness: 0, sensuality: 0, morality: 100, neuroticism: 0 };
    expect(effectiveSleepWindow({ wakeTime: 6, sleepTime: 20 }, early).sleepHour).toBe(19);
    const late = { impulsiveness: 100, sensuality: 100, morality: 0, neuroticism: 0 };
    expect(effectiveSleepWindow({ wakeTime: 10, sleepTime: 1 }, late).sleepHour).toBe(2);
  });
});
