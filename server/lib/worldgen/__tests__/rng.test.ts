import { describe, it, expect } from 'vitest';
import { stringToSeed, makeRng, forkRng, randomBase62 } from '../rng';

describe('stringToSeed', () => {
  it('is stable across calls for the same input', () => {
    expect(stringToSeed('hello')).toBe(stringToSeed('hello'));
  });

  it('produces different seeds for different inputs', () => {
    expect(stringToSeed('hello')).not.toBe(stringToSeed('world'));
  });

  it('returns a 32-bit unsigned integer', () => {
    const seed = stringToSeed('abc');
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 32);
  });
});

describe('makeRng / mulberry32', () => {
  it('produces deterministic sequences from the same seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('int(min, max) returns inclusive integers', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 100; i++) {
      const n = rng.int(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('shuffle preserves elements', () => {
    const rng = makeRng(1);
    const src = [1, 2, 3, 4, 5];
    const shuffled = rng.shuffle(src);
    expect([...shuffled].sort()).toEqual(src);
    expect(src).toEqual([1, 2, 3, 4, 5]); // original untouched
  });

  it('pick selects an element of the input', () => {
    const rng = makeRng(1);
    const choices = ['a', 'b', 'c'];
    const picked = rng.pick(choices);
    expect(choices).toContain(picked);
  });
});

describe('forkRng', () => {
  it('produces identical streams for the same (seed, label)', () => {
    const a = forkRng('master', 'homes');
    const b = forkRng('master', 'homes');
    expect(a.next()).toBe(b.next());
    expect(a.next()).toBe(b.next());
  });

  it('produces different streams for different labels', () => {
    const a = forkRng('master', 'homes');
    const b = forkRng('master', 'roads');
    expect(a.next()).not.toBe(b.next());
  });

  it('produces different streams for different master seeds', () => {
    const a = forkRng('alpha', 'homes');
    const b = forkRng('beta', 'homes');
    expect(a.next()).not.toBe(b.next());
  });
});

describe('randomBase62', () => {
  it('returns a string of the requested length', () => {
    expect(randomBase62(8)).toHaveLength(8);
    expect(randomBase62(16)).toHaveLength(16);
  });

  it('uses only base62 chars [0-9A-Za-z]', () => {
    expect(randomBase62(64)).toMatch(/^[0-9A-Za-z]+$/);
  });
});
