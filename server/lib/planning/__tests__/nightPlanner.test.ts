import { describe, it, expect, vi } from 'vitest';
import { NightPlanner, NIGHT_PLANNING, nightSlotMinute, type NightPlannerAgent } from '../nightPlanner';
import type { ClockTime } from '../../gameClock';

/** `planned`: agents that already hold a plan for `plannedDay`. */
function setup(agents: NightPlannerAgent[], planned: Set<number> = new Set(), plannedDay = 0) {
  const queuePlan = vi.fn((_id: number, _t: ClockTime) => true);
  const refreshSelfDescription = vi.fn();
  const planner = new NightPlanner({
    listAgents: () => agents.map((a) => ({ ...a })),
    hasPlanFor: (id, day) => planned.has(id) && day <= plannedDay,
    queuePlan,
    refreshSelfDescription,
  });
  return { planner, queuePlan, refreshSelfDescription };
}

const at = (day: number, hour: number, minute = 0): ClockTime => ({ day, hour, minute });

/** Run the planner every `step` game minutes from `from` to `to` (minute of day). */
function run(planner: NightPlanner, day: number, from: number, to: number, step: number) {
  for (let m = from; m <= to; m += step) planner.tick(at(day, Math.floor(m / 60), m % 60));
}

describe('NightPlanner', () => {
  const town: NightPlannerAgent[] = Array.from({ length: 13 }, (_, i) => ({
    id: i + 1,
    wakeTime: i === 4 ? 5 : 7, // one early riser (the baker)
  }));

  it('asks for every plan once, staggered, long before anyone wakes', () => {
    const { planner, queuePlan } = setup(town);
    run(planner, 4, 0, 23 * 60, 1);
    expect(queuePlan).toHaveBeenCalledTimes(13);
    // The earliest riser goes first.
    expect(queuePlan.mock.calls[0][0]).toBe(5);
    const times = queuePlan.mock.calls.map(([, t]) => t.hour * 60 + t.minute);
    expect(times[0]).toBe(NIGHT_PLANNING.PLAN_START_MINUTE);
    // Staggered, not a burst...
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBe(NIGHT_PLANNING.STAGGER_MINUTES);
    // ...and the last one is asked well before the earliest wake-up (05:00):
    // hours of night to answer even at 4x with a queue.
    expect(times[times.length - 1]).toBeLessThanOrEqual(2 * 60);
    expect(queuePlan.mock.calls.every(([, t]) => t.day === 4)).toBe(true);
  });

  it('catches up when the clock jumps (night skip steps 30 minutes a tick)', () => {
    const { planner, queuePlan } = setup(town);
    run(planner, 2, 0, 5 * 60, 30);
    expect(new Set(queuePlan.mock.calls.map(([id]) => id)).size).toBe(13);
  });

  it('skips agents already planned for the day and never re-asks the same night', () => {
    const { planner, queuePlan } = setup(town, new Set([1, 2, 3]), 3);
    run(planner, 3, 0, 4 * 60, 1);
    run(planner, 3, 0, 4 * 60, 1);
    expect(queuePlan).toHaveBeenCalledTimes(10);
    expect(queuePlan.mock.calls.map(([id]) => id)).not.toContain(1);
    // Next night asks again.
    run(planner, 4, 0, 4 * 60, 1);
    expect(queuePlan).toHaveBeenCalledTimes(23);
  });

  it('leaves an agent to the wake-up path once their wake hour has passed', () => {
    // A server started at 05:30: the baker (wake 5) is up; the rest are not.
    const { planner, queuePlan } = setup(town);
    planner.tick(at(1, 5, 30));
    // 05:30 is past NIGHT_END (05:00): nothing is started in the morning.
    expect(queuePlan).not.toHaveBeenCalled();
    planner.tick(at(1, 4, 50));
    expect(queuePlan.mock.calls.map(([id]) => id)).toContain(5);
  });

  it('moves self-descriptions off the midnight burst to after the plans', () => {
    const { planner, queuePlan, refreshSelfDescription } = setup(town);
    run(planner, 5, 0, 23 * 60, 1);
    expect(refreshSelfDescription).toHaveBeenCalledTimes(13);
    const firstSelf = nightSlotMinute(NIGHT_PLANNING.SELF_DESCRIPTION_START_MINUTE, 0);
    const lastPlan = nightSlotMinute(NIGHT_PLANNING.PLAN_START_MINUTE, town.length - 1);
    expect(firstSelf).toBeGreaterThan(lastPlan);
    expect(queuePlan).toHaveBeenCalledTimes(13);
  });

  it('starts nothing in the daytime (a server started mid-afternoon)', () => {
    const { planner, queuePlan, refreshSelfDescription } = setup(town);
    run(planner, 1, 12 * 60, 23 * 60 + 59, 1);
    expect(queuePlan).not.toHaveBeenCalled();
    expect(refreshSelfDescription).not.toHaveBeenCalled();
  });
});
