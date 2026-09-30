import { describe, it, expect } from 'vitest';
import { deriveTenure, isWidowed, selfFactsLine } from '../selfFacts';

const THOMAS_BIO = "Thomas is the town's mayor, a position he's held for twelve years. He's fair-minded and responsible. His wife passed years ago; his work is his life now.";

describe('deriveTenure', () => {
  it('takes the numbers the bio states', () => {
    expect(deriveTenure({ name: 'Thomas Park', age: 52, bio: THOMAS_BIO, job: 'mayor' }).jobYears).toBe(12);
    const marco = deriveTenure({
      name: 'Marco Rivera', age: 35, job: 'bartender',
      bio: 'He moved to town eight years ago under mysterious circumstances.',
    });
    expect(marco.yearsInTown).toBe(8);
    expect(marco.jobYears).toBeLessThanOrEqual(8);
    const james = deriveTenure({ name: 'James', age: 61, job: 'farmhand', bio: 'A fixture at Green Acres for over twenty years.' });
    expect(james.jobYears).toBe(20);
    const diego = deriveTenure({
      name: 'Diego', age: 28, job: 'musician',
      bio: 'I came to Little Life for a weekend gig and that was two years ago.',
    });
    expect(diego.yearsInTown).toBe(2);
  });

  it('is deterministic when the bio says nothing', () => {
    const p = { name: 'Ada Brook', age: 40, bio: '', job: 'baker' };
    expect(deriveTenure(p)).toEqual(deriveTenure(p));
    const t = deriveTenure(p);
    expect(t.yearsInTown).toBeGreaterThan(0);
    expect(t.yearsInTown).toBeLessThanOrEqual(40);
    expect(t.jobYears).toBeGreaterThanOrEqual(1);
    expect(t.jobYears).toBeLessThanOrEqual(22);
  });

  it('never makes an incomer a native, and a newcomer is new in town', () => {
    const omar = deriveTenure({ name: 'Omar', age: 39, job: 'medical_assistant', bio: 'He came to Little Life years ago as a refugee.' });
    expect(omar.yearsInTown).toBeLessThan(39);
    expect(deriveTenure({ name: 'X', age: 30, bio: 'Born and raised here.', job: 'farmer', newcomer: true }).yearsInTown).toBe(0);
  });

  it('gives no trade years to the retired', () => {
    expect(deriveTenure({ name: 'Yuki', age: 67, bio: 'I taught for forty years.', job: 'retired' }).jobYears).toBeNull();
  });
});

describe('selfFactsLine', () => {
  it('states tenure, roots and household compactly', () => {
    const line = selfFactsLine({
      jobTitle: 'Town Mayor', age: 52, tenure: { yearsInTown: 52, jobYears: 12 }, widowed: isWidowed(THOMAS_BIO),
    });
    expect(line).toBe('Facts about you (keep them straight): Town Mayor for 12 years; born and raised here; widowed.');
  });

  it('prefers a living partner to widowhood and handles job changes and newcomers', () => {
    expect(selfFactsLine({
      jobTitle: 'Baker', age: 30, tenure: { yearsInTown: 0, jobYears: 0 }, household: 'married to Rosa', widowed: true,
    })).toBe('Facts about you (keep them straight): recently took up work as Baker; new in town; married to Rosa.');
    expect(selfFactsLine({ jobTitle: 'Retired Teacher', age: 67, tenure: { yearsInTown: 20, jobYears: 5 } }))
      .toBe('Facts about you (keep them straight): came to town 20 years ago.');
  });
});
