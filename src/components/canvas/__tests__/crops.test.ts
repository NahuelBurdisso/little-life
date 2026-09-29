import { describe, it, expect } from 'vitest';
import { CROP_STAGE_COUNT, SEASON_LENGTH_DAYS, STAGES_PER_SEASON, cropCell, seasonDayOf } from '../crops';

describe('cropCell', () => {
  it('walks the three growth stages of a season and lands on the next season', () => {
    expect([0, 9, 10, 18, 19, 27].map(d => cropCell('spring', d))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(cropCell('summer', 0)).toBe(3);
    expect(cropCell('autumn', 27)).toBe(8);
    expect(cropCell('winter', 0)).toBe(9);
    expect(cropCell('winter', 27)).toBe(11);
  });

  it('never leaves the strip, whatever the day', () => {
    for (const season of ['spring', 'summer', 'autumn', 'winter']) {
      for (const d of [-5, 0, 13, 27, 28, 500, NaN]) {
        const c = cropCell(season, d);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(CROP_STAGE_COUNT);
      }
    }
  });

  it('grows monotonically within a season', () => {
    for (let s = 0; s < 4; s++) {
      const season = ['spring', 'summer', 'autumn', 'winter'][s];
      let prev = -1;
      for (let d = 0; d < SEASON_LENGTH_DAYS; d++) {
        const c = cropCell(season, d);
        expect(c).toBeGreaterThanOrEqual(prev);
        expect(Math.floor(c / STAGES_PER_SEASON)).toBe(s);
        prev = c;
      }
    }
  });

  it('reads an unknown season as summer, mid-growth when the day is unknown', () => {
    expect(cropCell(undefined, undefined)).toBe(4);
    expect(cropCell('monsoon', 0)).toBe(3);
  });
});

describe('seasonDayOf', () => {
  it('prefers the stored season day', () => {
    expect(seasonDayOf({ seasonDay: 5, day: 90 })).toBe(5);
  });
  it('derives it from the absolute day otherwise', () => {
    expect(seasonDayOf({ day: 30 })).toBe(2);
    expect(seasonDayOf({ day: 56 })).toBe(0);
  });
  it('is undefined without a clock', () => {
    expect(seasonDayOf(null)).toBeUndefined();
    expect(seasonDayOf({})).toBeUndefined();
  });
});
