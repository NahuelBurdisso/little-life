import { describe, it, expect } from 'vitest';
import {
  dailyUpkeep, stipendFor, wagePayer, balancerMultipliers, startingTreasury, treasuryExcess,
  moneyTargetFor, savingsAllowance, upkeepRamp, lateStartTreasury, UPKEEP_RAMP_NIGHTS,
} from '../townTreasury';
import { CONFIG } from '../constants';

/**
 * E1/E5: salaries were minted from nothing and the only sink was a burned flat
 * living cost, so the money supply climbed ~10% a day while the lowest earners
 * still went broke. The treasury loop is: wages out of the treasury (or the
 * employer's till), upkeep and the stipend at day change.
 */
const P = { base: 4, allowance: 60, rate: 0.35 };

describe('dailyUpkeep', () => {
  it('is the base charge while savings are under the allowance', () => {
    expect(dailyUpkeep(20, P)).toBe(4);
    expect(dailyUpkeep(60, P)).toBe(4);
  });

  it('adds the lifestyle share of cash above the allowance', () => {
    expect(dailyUpkeep(160, P)).toBe(39); // 4 + 0.35 × 100
  });

  it('never takes more than the resident holds, and nothing from the broke', () => {
    expect(dailyUpkeep(2.5, P)).toBe(2.5);
    expect(dailyUpkeep(0, P)).toBe(0);
    expect(dailyUpkeep(-3, P)).toBe(0);
  });

  it('the money-supply multiplier moves only the lifestyle share, up to a cap', () => {
    expect(dailyUpkeep(160, { ...P, multiplier: 1.5 })).toBe(56.5); // 4 + 0.525 × 100
    expect(dailyUpkeep(160, { ...P, multiplier: 4 })).toBe(64); // rate capped at 0.6
    expect(dailyUpkeep(40, { ...P, multiplier: 4 })).toBe(4); // rent doesn't move
  });

  it('caps what a steady earner can hoard near allowance + surplus / rate', () => {
    // A doctor-like resident: $28 wage, spends $12 a day, pays upkeep nightly.
    let cash = 100;
    for (let day = 0; day < 60; day++) {
      cash += 28 - 12;
      cash -= dailyUpkeep(cash, P);
    }
    const cap = P.allowance + (28 - 12 - P.base) / P.rate;
    expect(cash).toBeLessThan(cap + 1);
    expect(cash).toBeGreaterThan(P.allowance);
  });

  it('with the shipped settings a low earner who eats three meals still keeps money', () => {
    const { UPKEEP } = CONFIG.ECONOMY;
    const allowance = savingsAllowance(CONFIG.ECONOMY.TARGET_PER_CAPITA_MONEY, UPKEEP.ALLOWANCE_OF_TARGET);
    const params = { base: UPKEEP.BASE, allowance, rate: UPKEEP.LIFESTYLE_RATE };
    // Lowest default wage ($20) minus three $5 meals (the shop and bakery menu
    // price; the tavern's is $6, spring takes 10% off).
    let cash = 20;
    for (let day = 0; day < 14; day++) {
      cash += 20 - 3 * 5;
      cash -= dailyUpkeep(cash, params);
    }
    expect(cash).toBeGreaterThanOrEqual(20);
  });
});

describe('late-start ramp', () => {
  it('eases the lifestyle share in over the first nights, then charges it all', () => {
    expect(UPKEEP_RAMP_NIGHTS).toBe(3);
    expect(upkeepRamp(3)).toBeCloseTo(1 / 3, 5);
    expect(upkeepRamp(2)).toBeCloseTo(2 / 3, 5);
    expect(upkeepRamp(1)).toBe(1);
    expect(upkeepRamp(0)).toBe(1);
    expect(upkeepRamp(-1)).toBe(1);
    expect(upkeepRamp(99)).toBeCloseTo(1 / 3, 5); // never below the first night's share
  });

  it('scales only the lifestyle share (rent is rent), after the rate cap', () => {
    // Inflated save: multiplier at its cap, so the rate is the 0.6 ceiling on $160 over a $60 allowance.
    const inflated = { ...P, multiplier: 4 };
    expect(dailyUpkeep(160, inflated)).toBe(64);                        // 4 + 0.6 x 100
    expect(dailyUpkeep(160, { ...inflated, ramp: upkeepRamp(3) })).toBe(24); // 4 + 0.2 x 100
    expect(dailyUpkeep(160, { ...inflated, ramp: upkeepRamp(2) })).toBe(44); // 4 + 0.4 x 100
    expect(dailyUpkeep(160, { ...inflated, ramp: upkeepRamp(1) })).toBe(64);
    expect(dailyUpkeep(40, { ...inflated, ramp: upkeepRamp(3) })).toBe(4);   // under the allowance: rent only
    expect(dailyUpkeep(160, { ...P, ramp: 5 })).toBe(dailyUpkeep(160, P));   // a ramp above 1 is ignored
    expect(dailyUpkeep(160, { ...P, ramp: -1 })).toBe(4);                    // ...and below 0 is 0
  });

  it('a late start opens with at least a new town reserve, never less than what is there', () => {
    expect(lateStartTreasury(-140, 13, 30)).toBe(390);
    expect(lateStartTreasury(0, 13, 30)).toBe(390);
    expect(lateStartTreasury(500, 13, 30)).toBe(500);
  });
});

describe('stipendFor', () => {
  it('tops a resident up to the floor', () => {
    expect(stipendFor(5, 18)).toBe(13);
    expect(stipendFor(0, 18)).toBe(18);
    expect(stipendFor(-4, 18)).toBe(18); // negative balances are not the treasury's to repay
  });

  it('pays nothing at or above the floor', () => {
    expect(stipendFor(18, 18)).toBe(0);
    expect(stipendFor(40, 18)).toBe(0);
  });
});

describe('wagePayer', () => {
  const base = { agentId: 2, workplaceOwner: 1, workplaceIsBusiness: true, employerCash: 200, wage: 20, employerFloor: 50 };

  it('staff of someone else\'s business are paid from the owner\'s till', () => {
    expect(wagePayer(base)).toEqual({ kind: 'employer', employerId: 1 });
  });

  it('falls back to the treasury when the till would drop under the floor', () => {
    expect(wagePayer({ ...base, employerCash: 69 })).toEqual({ kind: 'treasury' });
    expect(wagePayer({ ...base, employerCash: 70 })).toEqual({ kind: 'employer', employerId: 1 });
  });

  it('owners, public jobs and unowned workplaces are paid by the treasury', () => {
    expect(wagePayer({ ...base, workplaceOwner: 2 })).toEqual({ kind: 'treasury' }); // owns it
    expect(wagePayer({ ...base, workplaceIsBusiness: false })).toEqual({ kind: 'treasury' }); // town hall, farm
    expect(wagePayer({ ...base, workplaceOwner: null })).toEqual({ kind: 'treasury' });
    expect(wagePayer({ ...base, employerCash: undefined })).toEqual({ kind: 'treasury' }); // owner gone
  });
});

describe('balancerMultipliers', () => {
  it('pulls the lifestyle share toward the target continuously', () => {
    expect(balancerMultipliers(1.0)).toEqual({ upkeep: 1, tax: 1 });
    expect(balancerMultipliers(0.9).upkeep).toBeCloseTo(0.729);
    expect(balancerMultipliers(1.15).upkeep).toBeCloseTo(1.521);
    // Monotonic: more money, stiffer share.
    for (let r = 0.3; r < 2.5; r += 0.1) {
      expect(balancerMultipliers(r + 0.1).upkeep).toBeGreaterThanOrEqual(balancerMultipliers(r).upkeep);
    }
    expect(balancerMultipliers(3).upkeep).toBe(4);
    expect(balancerMultipliers(0.2).upkeep).toBe(0.25);
  });

  it('keeps the old sales-tax band', () => {
    expect(balancerMultipliers(1.5).tax).toBe(1);
    expect(balancerMultipliers(2.0).tax).toBeCloseTo(1.8);
    expect(balancerMultipliers(0.4).tax).toBe(0.5);
  });
});

describe('per-world money target', () => {
  const range = { MIN: 30, MAX: 300 };

  it('is the mean starting cash, rounded', () => {
    expect(moneyTargetFor([80, 40, 60, 120, 90, 100, 55, 150, 65, 25, 35, 20, 70], range)).toBe(70);
  });

  it('is clamped: a $10 start and a $500 start still get a workable target', () => {
    expect(moneyTargetFor([10, 10, 12], range)).toBe(30);
    expect(moneyTargetFor([500, 500], range)).toBe(300);
    expect(moneyTargetFor([], range)).toBe(30);
  });

  it('the savings allowance follows the target', () => {
    expect(savingsAllowance(75, 0.8)).toBe(60);
    expect(savingsAllowance(300, 0.8)).toBe(240);
  });
});

describe('treasury reserve and cap', () => {
  it('a new town starts with a reserve per resident', () => {
    expect(startingTreasury(13, 30)).toBe(390);
    expect(startingTreasury(0, 30)).toBe(0);
  });

  it('retires only what sits above the per-resident cap', () => {
    expect(treasuryExcess(600, 13, 50)).toBe(0);
    expect(treasuryExcess(700.5, 13, 50)).toBe(50.5);
    expect(treasuryExcess(-200, 13, 50)).toBe(0); // debt is never "retired"
  });
});
