import { describe, it, expect } from 'vitest';
import { shuffled } from '../utils';
import { makeRng } from '../worldgen/rng';

describe('shuffled', () => {
  it('returns a permutation of its input', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffled(items, makeRng(42).next);
    expect(out).toHaveLength(items.length);
    expect([...out].sort((a, b) => a - b)).toEqual(items);
  });

  it('does not mutate its input', () => {
    const items = [1, 2, 3, 4, 5];
    const frozen = Object.freeze([...items]);
    shuffled(frozen, makeRng(1).next);
    shuffled(items, makeRng(1).next);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });

  it('is deterministic for a seeded rng', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(shuffled(items, makeRng(7).next)).toEqual(shuffled(items, makeRng(7).next));
  });

  it('is uniform: every position is as likely for every element', () => {
    // `sort(() => Math.random() - 0.5)` fails this; Fisher-Yates does not.
    const rng = makeRng(123);
    const n = 4;
    const runs = 40_000;
    const counts = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let r = 0; r < runs; r++) {
      shuffled([0, 1, 2, 3], rng.next).forEach((item, pos) => { counts[item][pos]++; });
    }
    for (const row of counts) for (const c of row) expect(Math.abs(c / runs - 1 / n)).toBeLessThan(0.01);
  });

  it('uses Math.random by default and handles tiny inputs', () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled([9])).toEqual([9]);
  });
});
