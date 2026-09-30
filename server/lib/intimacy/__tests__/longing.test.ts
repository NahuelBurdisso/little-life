import { describe, it, expect, beforeEach } from 'vitest';
import {
  INFATUATED_LONGING_FACTOR, LONGING_MAX, LONGING_PER_HOUR, applyLonging, longingGrowth, relieveLonging,
  type LongingParty,
} from '../longing';
import { clearIntimacy, ensureAgentIntimacy, getAgentIntimacy } from '../state';
import { clearPerWorldCaches } from '../../../engine/worldCaches';

beforeEach(() => clearIntimacy());

const on = { infatuated: false, adultContent: true };
const adult = (over: Partial<LongingParty> = {}): LongingParty => ({
  id: 1, age: 30, sensuality: 50, infatuated: false, ...over,
});
const longingOf = (id: number) => getAgentIntimacy(id)?.longing ?? 0;

describe('longingGrowth', () => {
  it('is hours * 0.9 for an average adult', () => {
    expect(longingGrowth({ age: 30, sensuality: 50 }, 1, on)).toBeCloseTo(LONGING_PER_HOUR);
    expect(longingGrowth({ age: 30, sensuality: 50 }, 10, on)).toBeCloseTo(9);
  });

  it('scales with sensuality', () => {
    const cold = longingGrowth({ age: 30, sensuality: 10 }, 5, on);
    const mid = longingGrowth({ age: 30, sensuality: 50 }, 5, on);
    const hot = longingGrowth({ age: 30, sensuality: 100 }, 5, on);
    expect(cold).toBeLessThan(mid);
    expect(hot).toBeCloseTo(mid * 2);
  });

  it('is 1.5x when infatuated', () => {
    const base = longingGrowth({ age: 30, sensuality: 70 }, 4, on);
    expect(longingGrowth({ age: 30, sensuality: 70 }, 4, { ...on, infatuated: true }))
      .toBeCloseTo(base * INFATUATED_LONGING_FACTOR);
  });

  it('is 0 when the adult layer is off', () => {
    expect(longingGrowth({ age: 30, sensuality: 100 }, 10, { infatuated: true, adultContent: false })).toBe(0);
  });

  it('is 0 for a minor however sensual, and fails closed on a missing age', () => {
    expect(longingGrowth({ age: 17, sensuality: 100 }, 10, { infatuated: true, adultContent: true })).toBe(0);
    expect(longingGrowth({ age: 0, sensuality: 100 }, 10, on)).toBe(0);
    expect(longingGrowth({ age: undefined as unknown as number, sensuality: 100 }, 10, on)).toBe(0);
    expect(longingGrowth({ age: '30' as unknown as number, sensuality: 100 }, 10, on)).toBe(0);
    expect(longingGrowth({ age: 18, sensuality: 100 }, 10, on)).toBeGreaterThan(0);
  });

  it('ignores non-positive or non-finite hours', () => {
    expect(longingGrowth({ age: 30, sensuality: 50 }, 0, on)).toBe(0);
    expect(longingGrowth({ age: 30, sensuality: 50 }, -3, on)).toBe(0);
    expect(longingGrowth({ age: 30, sensuality: 50 }, Number.NaN, on)).toBe(0);
  });
});

describe('applyLonging (game-time pass)', () => {
  it('only anchors the clock on the first call', () => {
    applyLonging(1000, [adult()], true);
    expect(longingOf(1)).toBe(0);
  });

  it('bills elapsed game hours, not the number of calls', () => {
    applyLonging(1000, [adult()], true);
    // Six calls of ten minutes and one call of a single hour end up equal.
    for (let t = 1010; t <= 1060; t += 10) applyLonging(t, [adult()], true);
    expect(longingOf(1)).toBeCloseTo(LONGING_PER_HOUR);
    clearIntimacy();
    applyLonging(1000, [adult()], true);
    applyLonging(1060, [adult()], true);
    expect(longingOf(1)).toBeCloseTo(LONGING_PER_HOUR);
  });

  it('is idempotent within the same minute', () => {
    applyLonging(1000, [adult()], true);
    applyLonging(1120, [adult()], true);
    const once = longingOf(1);
    expect(once).toBeCloseTo(2 * LONGING_PER_HOUR);
    applyLonging(1120, [adult()], true);
    applyLonging(1120, [adult()], true);
    expect(longingOf(1)).toBe(once);
  });

  it('re-anchors when the clock goes backwards (world replace) instead of billing or going negative', () => {
    applyLonging(5000, [adult()], true);
    applyLonging(5060, [adult()], true);
    const before = longingOf(1);
    applyLonging(100, [adult()], true);
    expect(longingOf(1)).toBe(before);
    applyLonging(160, [adult()], true);
    expect(longingOf(1)).toBeCloseTo(before + LONGING_PER_HOUR);
  });

  it('caps at 100 and infatuation speeds it up', () => {
    applyLonging(0, [adult({ id: 1 }), adult({ id: 2, infatuated: true })], true);
    applyLonging(60, [adult({ id: 1 }), adult({ id: 2, infatuated: true })], true);
    expect(longingOf(2)).toBeCloseTo(longingOf(1) * INFATUATED_LONGING_FACTOR);
    applyLonging(60 * 500, [adult({ id: 1 })], true);
    expect(longingOf(1)).toBe(LONGING_MAX);
  });

  it('forces every stored longing to 0 when the rule is off, and stays 0', () => {
    applyLonging(0, [adult()], true);
    applyLonging(600, [adult()], true);
    expect(longingOf(1)).toBeGreaterThan(0);
    applyLonging(660, [adult()], false);
    expect(longingOf(1)).toBe(0);
    applyLonging(1200, [adult()], false);
    expect(longingOf(1)).toBe(0);
    // Turning it back on resumes from zero, not from a backlog of the off period.
    applyLonging(1260, [adult()], true);
    expect(longingOf(1)).toBeCloseTo(LONGING_PER_HOUR);
  });

  it('never grows a minor and wipes a minor value found in the state', () => {
    ensureAgentIntimacy(7).longing = 60;
    applyLonging(0, [adult({ id: 7, age: 16, sensuality: 100 })], true);
    applyLonging(600, [adult({ id: 7, age: 16, sensuality: 100 })], true);
    expect(longingOf(7)).toBe(0);
  });
});

describe('relieveLonging', () => {
  it('spends longing and floors at 0', () => {
    ensureAgentIntimacy(1).longing = 40;
    relieveLonging(1, 15);
    expect(longingOf(1)).toBe(25);
    relieveLonging(1, 999);
    expect(longingOf(1)).toBe(0);
  });

  it('does not create state for someone with none, and ignores bad amounts', () => {
    relieveLonging(3, 10);
    expect(getAgentIntimacy(3)).toBeUndefined();
    ensureAgentIntimacy(1).longing = 40;
    relieveLonging(1, -5);
    relieveLonging(1, Number.NaN);
    expect(longingOf(1)).toBe(40);
  });
});

describe('world replace', () => {
  it('clearPerWorldCaches clears longing and the processed-minute anchor', () => {
    applyLonging(0, [adult()], true);
    applyLonging(600, [adult()], true);
    expect(longingOf(1)).toBeGreaterThan(0);
    clearPerWorldCaches();
    expect(getAgentIntimacy(1)).toBeUndefined();
    // A fresh clock starting earlier does not bill the gap from the old world.
    applyLonging(10, [adult()], true);
    expect(longingOf(1)).toBe(0);
  });
});
