import { describe, it, expect } from 'vitest';
import {
  INTIMACY_MIN_AGE,
  canBeAttractedTo,
  isIntimacyEligible,
  type IntimacyParty,
} from '../eligibility';

const person = (over: Partial<IntimacyParty> & { id: number }): IntimacyParty => ({
  age: 30,
  gender: 'male',
  orientation: 'straight',
  is_active: true,
  ...over,
});

describe('INTIMACY_MIN_AGE', () => {
  it('is 18', () => expect(INTIMACY_MIN_AGE).toBe(18));
});

describe('isIntimacyEligible: the adults-only boundary', () => {
  // A compatible pair (man + woman, both straight) so age is the only thing under test.
  const adultWoman = person({ id: 1, age: 30, gender: 'female' });
  const teenMan = person({ id: 2, age: 17, gender: 'male' });

  it('17 + 30 is never eligible, in either argument order', () => {
    expect(isIntimacyEligible(teenMan, adultWoman)).toBe(false);
    expect(isIntimacyEligible(adultWoman, teenMan)).toBe(false);
  });

  it('holds for every age below 18 against every adult age', () => {
    for (let minor = 0; minor < INTIMACY_MIN_AGE; minor++) {
      for (const adult of [18, 25, 40, 90]) {
        const a = person({ id: 1, age: minor, gender: 'male' });
        const b = person({ id: 2, age: adult, gender: 'female' });
        expect(isIntimacyEligible(a, b)).toBe(false);
        expect(isIntimacyEligible(b, a)).toBe(false);
      }
    }
  });

  it('fails closed on a missing or non-numeric age', () => {
    const adult = person({ id: 1, gender: 'male' });
    for (const age of [undefined, null, NaN, '30']) {
      const unknown = { ...person({ id: 2, gender: 'female' }), age } as unknown as IntimacyParty;
      expect(isIntimacyEligible(adult, unknown)).toBe(false);
      expect(isIntimacyEligible(unknown, adult)).toBe(false);
    }
  });

  it('two minors are not eligible either', () => {
    expect(isIntimacyEligible(person({ id: 1, age: 16, gender: 'male' }), person({ id: 2, age: 16, gender: 'female' }))).toBe(false);
  });

  it('18 + 18 compatible is eligible, in either order', () => {
    const a = person({ id: 1, age: 18, gender: 'male' });
    const b = person({ id: 2, age: 18, gender: 'female' });
    expect(isIntimacyEligible(a, b)).toBe(true);
    expect(isIntimacyEligible(b, a)).toBe(true);
  });

  it('rejects the same person twice', () => {
    const a = person({ id: 1, orientation: 'bi' });
    expect(isIntimacyEligible(a, a)).toBe(false);
    expect(isIntimacyEligible(a, { ...a })).toBe(false);
  });

  it('rejects an inactive party (left town or died)', () => {
    const a = person({ id: 1, gender: 'male' });
    const b = person({ id: 2, gender: 'female', is_active: false });
    expect(isIntimacyEligible(a, b)).toBe(false);
    expect(isIntimacyEligible(b, a)).toBe(false);
  });

  it('treats a missing is_active as active', () => {
    const a = person({ id: 1, gender: 'male' });
    const b = { id: 2, age: 25, gender: 'female', orientation: 'straight' };
    expect(isIntimacyEligible(a, b)).toBe(true);
  });

  it('needs attraction from BOTH sides', () => {
    // A gay man and a straight woman: she would, he would not.
    const gayMan = person({ id: 1, gender: 'male', orientation: 'gay' });
    const straightWoman = person({ id: 2, gender: 'female', orientation: 'straight' });
    expect(canBeAttractedTo(straightWoman, gayMan)).toBe(true);
    expect(canBeAttractedTo(gayMan, straightWoman)).toBe(false);
    expect(isIntimacyEligible(gayMan, straightWoman)).toBe(false);
    expect(isIntimacyEligible(straightWoman, gayMan)).toBe(false);
  });
});

describe('canBeAttractedTo: orientation x gender truth table', () => {
  const genders = ['male', 'female'] as const;
  const expected = (orientation: string, self: string, other: string): boolean => {
    if (orientation === 'bi') return true;
    if (orientation === 'gay') return self === other;
    return self !== other; // straight
  };

  for (const orientation of ['straight', 'gay', 'bi'] as const) {
    for (const self of genders) {
      for (const other of genders) {
        it(`${orientation} ${self} -> ${other}: ${expected(orientation, self, other)}`, () => {
          expect(canBeAttractedTo({ gender: self, orientation }, { gender: other })).toBe(expected(orientation, self, other));
        });
      }
    }
  }

  it('null / undefined / unknown orientation reads as straight (legacy rows before the backfill)', () => {
    for (const orientation of [null, undefined, 'unheard-of']) {
      expect(canBeAttractedTo({ gender: 'male', orientation }, { gender: 'female' })).toBe(true);
      expect(canBeAttractedTo({ gender: 'male', orientation }, { gender: 'male' })).toBe(false);
      expect(canBeAttractedTo({ gender: 'female', orientation }, { gender: 'female' })).toBe(false);
    }
  });
});
