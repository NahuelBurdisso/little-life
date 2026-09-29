import { describe, it, expect } from 'vitest';
import { advanceClock, computeDayPhase, detectTransitions } from '../../engine/tick';
import { crossedBoundary, dayChanged, gameMinutes, hourChanged } from '../gameClock';

type Time = Parameters<typeof advanceClock>[0];

function at(day: number, hour: number, minute: number): Time {
  return { day, hour, minute, totalTicks: 0, seasonDay: day, season: 'spring' };
}

/**
 * Drive the real clock for `ticks` ticks at `speed` and count how often each
 * gate fires, exactly the way tick.ts feeds them (transitions for the phases,
 * old/new game minutes for the post-phase cadences).
 */
function run(start: Time, speed: number, ticks: number) {
  let time = start;
  const fired = { hour: 0, day: 0, tenMinutes: 0 };
  for (let i = 0; i < ticks; i++) {
    const next = advanceClock(time, speed);
    const transitions = detectTransitions(time, computeDayPhase(time.hour), next, computeDayPhase(next.hour));
    if (hourChanged(transitions)) fired.hour++;
    if (dayChanged(transitions)) fired.day++;
    if (crossedBoundary(gameMinutes(time), gameMinutes(next), 10)) fired.tenMinutes++;
    time = next;
  }
  return fired;
}

describe('gameMinutes', () => {
  it('is absolute minutes since day 0', () => {
    expect(gameMinutes(at(0, 0, 0))).toBe(0);
    expect(gameMinutes(at(2, 6, 15))).toBe(2 * 1440 + 6 * 60 + 15);
  });
});

describe('crossedBoundary', () => {
  it('counts a boundary that is landed on, but not twice', () => {
    expect(crossedBoundary(56, 60, 60)).toBe(true);
    expect(crossedBoundary(60, 64, 60)).toBe(false);
  });

  it('counts a boundary stepped over', () => {
    // 4x from minute 59: 59 -> 63 never lands on 0.
    expect(crossedBoundary(59, 63, 60)).toBe(true);
  });

  it('never fires on a frozen clock', () => {
    expect(crossedBoundary(60, 60, 60)).toBe(false);
  });

  it('honours an offset inside the period', () => {
    const six = 6 * 60;
    expect(crossedBoundary(six - 2, six + 2, 1440, six)).toBe(true);
    expect(crossedBoundary(six + 2, six + 6, 1440, six)).toBe(false);
  });
});

describe('hourly and daily gates', () => {
  // 12 game hours of ticks at each speed, from starting minutes that the old
  // `minute === 0` gate could never reach at 2x (odd) or 4x (not a multiple of 4).
  for (const speed of [1, 2, 4]) {
    for (const startMinute of [0, 15, 33, 59]) {
      it(`fires once per game hour at ${speed}x starting at :${startMinute}`, () => {
        const ticks = (12 * 60) / speed;
        const fired = run(at(1, 8, startMinute), speed, ticks);
        expect(fired.hour).toBe(12);
        expect(fired.tenMinutes).toBe(72);
      });
    }
  }

  it('stays whole and fires once per game hour at 0.5x', () => {
    // 0.5x makes `minute` fractional; the stamps land in INTEGER columns.
    let time = at(1, 8, 15);
    for (let i = 0; i < 7; i++) {
      time = advanceClock(time, 0.5);
      expect(Number.isInteger(gameMinutes(time))).toBe(true);
    }
    expect(run(at(1, 8, 15), 0.5, (3 * 60) / 0.5)).toMatchObject({ hour: 3, tenMinutes: 18 });
  });

  it('fires once per game day at 4x', () => {
    // `currentTick % 1440 < 2` fired twice per 1440 TICKS — every 4 game days at 4x.
    const fired = run(at(1, 7, 15), 4, (3 * 1440) / 4);
    expect(fired.day).toBe(3);
  });
});
