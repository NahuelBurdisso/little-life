import { describe, it, expect } from 'vitest';
import {
  ARM_IN_ARM_PX, FACING_PX, GLANCE_PX, HEART_GAP_MS, GLANCE_HOLD_MS,
  isAdultAge, isOpenCouple, openCouplePairs, sameHeading, armInArmNow, idleTogetherNow,
  nudgeFor, facingToward, heartDue, nextHeartAt, glanceGapMs, coupleKey,
} from '../couplePairs';
import { invalid } from '../../__tests__/kit';

describe('isOpenCouple', () => {
  it('accepts married, engaged and partner tags', () => {
    expect(isOpenCouple(['married'])).toBe(true);
    expect(isOpenCouple(['kissed', 'engaged'])).toBe(true);
    expect(isOpenCouple(['partner'])).toBe(true);
  });
  it('never treats lovers or a kiss alone as public (the client cannot know secrecy)', () => {
    expect(isOpenCouple(['lovers'])).toBe(false);
    expect(isOpenCouple(['lovers', 'kissed'])).toBe(false);
    expect(isOpenCouple([])).toBe(false);
  });
  it('tolerates junk and skips estranged couples', () => {
    expect(isOpenCouple(undefined)).toBe(false);
    expect(isOpenCouple(null)).toBe(false);
    expect(isOpenCouple('married')).toBe(false);
    expect(isOpenCouple(['married', 'estranged'])).toBe(false);
  });
});

describe('isAdultAge', () => {
  it('fails closed on minors, missing and non-finite ages', () => {
    expect(isAdultAge(18)).toBe(true);
    expect(isAdultAge(17)).toBe(false);
    expect(isAdultAge(undefined)).toBe(false);
    expect(isAdultAge(invalid(null))).toBe(false);
    expect(isAdultAge(NaN)).toBe(false);
    expect(isAdultAge(invalid('30'))).toBe(false);
  });
});

describe('openCouplePairs', () => {
  const ages = new Map<number, number | undefined>([[1, 30], [2, 28], [3, 16], [4, undefined], [5, 40]]);
  const adult = (id: number) => isAdultAge(ages.get(id));
  it('keeps open adult couples in a stable order and skips everything else', () => {
    const out = openCouplePairs(invalid([
      { agent_a: 2, agent_b: 1, tags: ['married'] },
      { agent_a: 1, agent_b: 5, tags: ['lovers'] },
      { agent_a: 1, agent_b: 3, tags: ['partner'] },
      { agent_a: 4, agent_b: 5, tags: ['engaged'] },
      { agent_a: 5, agent_b: 5, tags: ['married'] },
      { agent_a: 'x', agent_b: 1, tags: ['married'] },
      null,
    ]), adult);
    expect(out).toEqual([{ a: 1, b: 2, key: '1-2' }]);
  });
  it('reuses the given output array', () => {
    const buf: NonNullable<Parameters<typeof openCouplePairs>[2]> = invalid([{ stale: true }]);
    const out = openCouplePairs([], adult, buf);
    expect(out).toBe(buf);
    expect(out).toHaveLength(0);
  });
});

describe('sameHeading', () => {
  it('needs both to be moving and roughly parallel', () => {
    expect(sameHeading(10, 0, 12, 1)).toBe(true);
    expect(sameHeading(10, 0, -10, 0)).toBe(false);
    expect(sameHeading(10, 0, 0, 10)).toBe(false);
    expect(sameHeading(10, 0, 0, 0)).toBe(false);
  });
});

describe('armInArmNow / idleTogetherNow', () => {
  it('enters inside 48 px while walking the same way', () => {
    expect(armInArmNow(false, ARM_IN_ARM_PX - 1, 20, 0, 22, 2)).toBe(true);
    expect(armInArmNow(false, ARM_IN_ARM_PX + 1, 20, 0, 22, 2)).toBe(false);
  });
  it('holds a little past the enter distance so it does not flicker', () => {
    expect(armInArmNow(true, ARM_IN_ARM_PX + 6, 20, 0, 22, 2)).toBe(true);
    expect(armInArmNow(true, ARM_IN_ARM_PX + 30, 20, 0, 22, 2)).toBe(false);
  });
  it('is off when either stands still or they head apart', () => {
    expect(armInArmNow(false, 20, 20, 0, 0, 0)).toBe(false);
    expect(armInArmNow(false, 20, 20, 0, -20, 0)).toBe(false);
  });
  it('idle together is close and neither walking', () => {
    expect(idleTogetherNow(FACING_PX - 1, 0, 0, 0, 0)).toBe(true);
    expect(idleTogetherNow(FACING_PX + 1, 0, 0, 0, 0)).toBe(false);
    expect(idleTogetherNow(20, 20, 0, 0, 0)).toBe(false);
  });
});

describe('nudgeFor', () => {
  it('pulls 3 px each (6 px closer) but never overlaps them', () => {
    expect(nudgeFor(40)).toBe(3);
    expect(nudgeFor(14)).toBeCloseTo(2, 5);
    expect(nudgeFor(8)).toBe(0);
    expect(nudgeFor(0)).toBe(0);
  });
});

describe('facingToward', () => {
  it('turns toward the other and holds still inside the dead zone', () => {
    expect(facingToward(10)).toBe(1);
    expect(facingToward(-10)).toBe(-1);
    expect(facingToward(2)).toBe(0);
  });
});

describe('heart throttle', () => {
  it('is due only once its time has come, and reschedules at least HEART_GAP_MS out', () => {
    expect(heartDue(1000, 2000)).toBe(false);
    expect(heartDue(2000, 2000)).toBe(true);
    expect(nextHeartAt(10_000, 0.0)).toBeGreaterThanOrEqual(10_000 + HEART_GAP_MS);
    expect(nextHeartAt(10_000, 0.99)).toBeGreaterThanOrEqual(10_000 + HEART_GAP_MS);
  });
});

describe('glances', () => {
  it('come every 4 to 6 seconds and are shorter than the gap', () => {
    expect(glanceGapMs(0)).toBe(4000);
    expect(glanceGapMs(1)).toBe(6000);
    expect(GLANCE_HOLD_MS).toBeLessThan(4000);
    expect(GLANCE_PX).toBe(80);
  });
});

describe('coupleKey', () => {
  it('is order independent', () => {
    expect(coupleKey(7, 3)).toBe('3-7');
    expect(coupleKey(3, 7)).toBe('3-7');
  });
});
