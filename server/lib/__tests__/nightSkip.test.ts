import { describe, it, expect } from 'vitest';
import {
  NIGHT_SKIP, canSkipNight, decideSkipStep, describeSkipStop, everyoneAsleep, inSkipWindow, minutesUntilMorning, wakeStopThreshold,
  type SkipAgent, type SkipObservation, type SkipRun,
} from '../nightSkip';

const asleep: SkipAgent = { asleep: true, ignored: false };
const awake: SkipAgent = { asleep: false, ignored: false };

function can(over: Partial<Parameters<typeof canSkipNight>[0]> = {}) {
  return canSkipNight({ hour: 12, paused: false, active: false, agents: [awake, awake], ...over });
}

describe('inSkipWindow', () => {
  it('is 23:00 up to but not including 05:00', () => {
    expect([22, 23, 0, 3, 4, 5, 6].map(inSkipWindow)).toEqual([false, true, true, true, true, false, false]);
  });
});

describe('everyoneAsleep', () => {
  it('needs at least one townsperson and every counted one asleep', () => {
    expect(everyoneAsleep([])).toBe(false);
    expect(everyoneAsleep([asleep, asleep])).toBe(true);
    expect(everyoneAsleep([asleep, awake])).toBe(false);
  });

  it('does not count the dead or the jailed', () => {
    expect(everyoneAsleep([asleep, { asleep: false, ignored: true }])).toBe(true);
    expect(everyoneAsleep([{ asleep: false, ignored: true }])).toBe(false);
  });
});

describe('canSkipNight', () => {
  it('is offered in the 23:00-05:00 window even with people up', () => {
    expect(can({ hour: 23 }).ok).toBe(true);
    expect(can({ hour: 2 }).ok).toBe(true);
    expect(can({ hour: 4 }).ok).toBe(true);
  });

  it('is offered in the evening once everyone is asleep', () => {
    expect(can({ hour: 21, agents: [asleep, asleep] }).ok).toBe(true);
    expect(can({ hour: 22, agents: [asleep, awake] }).ok).toBe(false);
  });

  it('is offered just before dawn when everyone still sleeps, but not in daytime', () => {
    expect(can({ hour: 5, agents: [asleep, asleep] }).ok).toBe(true);
    expect(can({ hour: 5, agents: [asleep, awake] }).ok).toBe(false);
    // A town-wide siesta is not a night: 06:00 would be 16 hours away.
    expect(can({ hour: 14, agents: [asleep, asleep] }).ok).toBe(false);
    expect(can({ hour: 6, agents: [asleep, asleep] }).ok).toBe(false);
  });

  it('refuses while paused or already skipping, and says why', () => {
    const p = can({ hour: 1, paused: true });
    expect(p).toEqual({ ok: false, reason: expect.stringContaining('Resume') });
    const a = can({ hour: 1, active: true });
    expect(a).toEqual({ ok: false, reason: expect.stringContaining('Already') });
  });
});

describe('minutesUntilMorning', () => {
  it('counts to the next 06:00, across midnight', () => {
    expect(minutesUntilMorning(23, 0)).toBe(7 * 60);
    expect(minutesUntilMorning(0, 30)).toBe(5 * 60 + 30);
    expect(minutesUntilMorning(5, 59)).toBe(1);
  });

  it('is a whole day at exactly 06:00 (never zero)', () => {
    expect(minutesUntilMorning(6, 0)).toBe(1440);
    expect(minutesUntilMorning(12, 0)).toBe(18 * 60);
  });
});

describe('decideSkipStep', () => {
  // A skip that began at 23:00 on day 2 (minute 2*1440 + 1380) toward 06:00 on day 3.
  const start = 2 * 1440 + 23 * 60;
  const run: SkipRun = { targetMinute: 3 * 1440 + 6 * 60, startMinute: start, baseSpeed: 2, sleepersAtStart: [1, 2, 3], ticks: 0 };
  function obs(over: Partial<SkipObservation> = {}): SkipObservation {
    return { nowMinute: start, hour: 23, asleepIds: [1, 2, 3], liveIds: [1, 2, 3, 4], importantEvents: 0, llmBacklog: 0, ...over };
  }

  it('runs at full speed while nothing is going on', () => {
    expect(decideSkipStep(run, obs())).toEqual({ kind: 'continue', speed: NIGHT_SKIP.SPEED });
  });

  it('shortens the last step so the clock lands exactly on 06:00', () => {
    const near = obs({ nowMinute: run.targetMinute - 12, hour: 5 });
    expect(decideSkipStep(run, near)).toEqual({ kind: 'continue', speed: 12 });
  });

  it('stops at morning, including a clock already past it', () => {
    expect(decideSkipStep(run, obs({ nowMinute: run.targetMinute, hour: 6 }))).toEqual({ kind: 'stop', reason: 'morning' });
    expect(decideSkipStep(run, obs({ nowMinute: run.targetMinute + 20, hour: 6 }))).toEqual({ kind: 'stop', reason: 'morning' });
  });

  it('stops for an important event, before anything else but the morning', () => {
    expect(decideSkipStep(run, obs({ importantEvents: 1 }))).toEqual({ kind: 'stop', reason: 'event' });
  });

  it('stops when several sleepers are up in the small hours, and names them', () => {
    expect(decideSkipStep(run, obs({ hour: 2, asleepIds: [3] }))).toEqual({ kind: 'stop', reason: 'woke', agentIds: [1, 2] });
  });

  it('does not stop for a lone night walker (someone whose need bottoms out at 1 a.m.)', () => {
    expect(decideSkipStep(run, obs({ hour: 2, asleepIds: [1, 3] })).kind).toBe('continue');
  });

  it('wake threshold is a quarter of the sleepers, at least two', () => {
    expect([1, 2, 3, 8, 9, 13, 20].map(wakeStopThreshold)).toEqual([2, 2, 2, 2, 3, 4, 5]);
  });

  it('lets people wake on schedule from 04:00', () => {
    expect(decideSkipStep(run, obs({ hour: 4, asleepIds: [1, 3] })).kind).toBe('continue');
    expect(decideSkipStep(run, obs({ hour: 5, asleepIds: [] })).kind).toBe('continue');
  });

  it('ignores a sleeper who is no longer alive or jailed, and people who were up from the start', () => {
    expect(decideSkipStep(run, obs({ hour: 1, asleepIds: [1, 3], liveIds: [1, 3, 4] })).kind).toBe('continue');
    // 4 was awake at the start and still is.
    expect(decideSkipStep(run, obs({ hour: 1, asleepIds: [1, 2, 3], liveIds: [1, 2, 3, 4] })).kind).toBe('continue');
  });

  it('drops to the throttle speed while the LLM queue is backed up, and recovers', () => {
    expect(decideSkipStep(run, obs({ llmBacklog: NIGHT_SKIP.LLM_BACKLOG_LIMIT + 1 }))).toEqual({ kind: 'continue', speed: NIGHT_SKIP.THROTTLE_SPEED });
    expect(decideSkipStep(run, obs({ llmBacklog: NIGHT_SKIP.LLM_BACKLOG_LIMIT }))).toEqual({ kind: 'continue', speed: NIGHT_SKIP.SPEED });
  });

  it('gives up after the tick cap', () => {
    expect(decideSkipStep({ ...run, ticks: NIGHT_SKIP.MAX_TICKS }, obs())).toEqual({ kind: 'stop', reason: 'limit' });
  });

  it('never asks for less than one minute per tick', () => {
    const step = decideSkipStep(run, obs({ nowMinute: run.targetMinute - 1, hour: 5 }));
    expect(step).toEqual({ kind: 'continue', speed: 1 });
  });
});

describe('describeSkipStop', () => {
  it('has a sentence for every reason', () => {
    for (const r of ['morning', 'woke', 'event', 'cancelled', 'limit', 'world_replaced'] as const) {
      expect(describeSkipStop(r).length).toBeGreaterThan(3);
    }
  });
});
