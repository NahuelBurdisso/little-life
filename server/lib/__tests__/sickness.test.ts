import { describe, expect, it } from 'vitest';
import {
  SICKNESS_TURN, graveDeathChancePerMinute, isGravelyIll, recentlyTreated, turnsForTheWorse, worsen, worsenChancePerMinute,
} from '../sickness';

const fresh = { severity: 0.45, duration: 600, metadata: null };

describe('sickness turning for the worse', () => {
  it('never worsens while treated or with the rule off', () => {
    expect(worsenChancePerMinute({ treated: true, age: 80, rateMultiplier: 1 })).toBe(0);
    expect(worsenChancePerMinute({ treated: false, age: 30, rateMultiplier: 0 })).toBe(0);
  });

  it('the old worsen more readily, and the rule scales it', () => {
    const young = worsenChancePerMinute({ treated: false, age: 30, rateMultiplier: 1 });
    expect(young).toBe(SICKNESS_TURN.WORSEN_PER_MINUTE);
    expect(worsenChancePerMinute({ treated: false, age: 70, rateMultiplier: 1 })).toBe(young * 2);
    expect(worsenChancePerMinute({ treated: false, age: 30, rateMultiplier: 3 })).toBeCloseTo(young * 3);
  });

  it('a turn raises severity, extends the illness and counts itself, keeping other metadata', () => {
    const once = worsen({ ...fresh, metadata: { coloc_7: 12 } });
    expect(once.severity).toBeCloseTo(0.65);
    expect(once.duration).toBe(600 + SICKNESS_TURN.EXTEND_MINUTES);
    expect(once.metadata).toEqual({ coloc_7: 12, worsened: 1 });
    expect(turnsForTheWorse(worsen(once))).toBe(2);
    expect(worsen({ severity: 0.95, duration: 1, metadata: null }).severity).toBe(1);
  });

  it('is grave only after two turns and at high severity', () => {
    const once = worsen(fresh);
    const twice = worsen(once);
    expect(isGravelyIll(fresh)).toBe(false);
    expect(isGravelyIll(once)).toBe(false);
    expect(isGravelyIll(twice)).toBe(true);
    // A healer brought the fever down: two turns behind them, but no longer grave.
    expect(isGravelyIll({ ...twice, severity: 0.4 })).toBe(false);
  });

  it('kills only the grave and untreated', () => {
    const grave = worsen(worsen(fresh));
    expect(graveDeathChancePerMinute(fresh, 1000)).toBe(0);
    expect(graveDeathChancePerMinute(grave, 1000)).toBe(SICKNESS_TURN.GRAVE_DEATH_PER_MINUTE);
    const treated = { ...grave, metadata: { ...grave.metadata, treatedAt: 950 } };
    expect(recentlyTreated(treated, 1000)).toBe(true);
    expect(graveDeathChancePerMinute(treated, 1000)).toBe(0);
    expect(graveDeathChancePerMinute(treated, 950 + SICKNESS_TURN.TREATED_GRACE_MINUTES + 1)).toBe(SICKNESS_TURN.GRAVE_DEATH_PER_MINUTE);
  });
});
