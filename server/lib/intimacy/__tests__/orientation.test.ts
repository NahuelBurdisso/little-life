import { describe, it, expect } from 'vitest';
import { makeRng } from '../../worldgen/rng';
import { assignOrientations, rollOrientation, type OrientationRelationship } from '../orientation';

const agent = (id: number, gender: 'male' | 'female') => ({ id, gender });
const crush = (a: number, b: number, ab: number, ba: number): OrientationRelationship => ({
  agent_a: a, agent_b: b, romance_ab: ab, romance_ba: ba,
});

const town = () => [
  agent(1, 'male'), agent(2, 'male'), agent(3, 'female'), agent(4, 'female'),
  agent(5, 'male'), agent(6, 'female'), agent(7, 'male'), agent(8, 'female'),
];

describe('assignOrientations', () => {
  it('gives every agent exactly one orientation', () => {
    const out = assignOrientations(town(), [], makeRng(1));
    expect([...out.keys()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const o of out.values()) expect(['straight', 'gay', 'bi']).toContain(o);
  });

  it('same seed -> same assignment; different seeds can differ', () => {
    const rels = [crush(1, 2, 50, 50)];
    const a = assignOrientations(town(), rels, makeRng(42));
    const b = assignOrientations(town(), rels, makeRng(42));
    expect([...a.entries()]).toEqual([...b.entries()]);
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) seen.add(JSON.stringify([...assignOrientations(town(), rels, makeRng(s)).entries()]));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('does not depend on the order agents are passed in', () => {
    const a = assignOrientations(town(), [], makeRng(9));
    const b = assignOrientations(town().reverse(), [], makeRng(9));
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it('a seeded same-gender crush pair keeps both non-straight', () => {
    // 1 and 2 are both men and both carry romance > 30 for each other.
    for (let seed = 0; seed < 200; seed++) {
      const out = assignOrientations(town(), [crush(1, 2, 45, 60)], makeRng(seed));
      expect(out.get(1)).toBe('gay');
      expect(out.get(2)).toBe('gay');
    }
  });

  it('a one-sided same-gender crush pins only the one who feels it', () => {
    for (let seed = 0; seed < 100; seed++) {
      const out = assignOrientations(town(), [crush(3, 4, 40, 5)], makeRng(seed));
      expect(out.get(3)).toBe('gay');
    }
  });

  it('reads the crush from either column, whichever way the pair is stored', () => {
    // agent_a = 2, agent_b = 1: romance_ba is agent 1's feeling for agent 2.
    for (let seed = 0; seed < 50; seed++) {
      const out = assignOrientations(town(), [crush(2, 1, 0, 80)], makeRng(seed));
      expect(out.get(1)).toBe('gay');
    }
  });

  it('bi when the >30 targets mix genders', () => {
    for (let seed = 0; seed < 100; seed++) {
      const out = assignOrientations(town(), [crush(1, 2, 50, 0), crush(1, 3, 50, 0)], makeRng(seed));
      expect(out.get(1)).toBe('bi');
    }
  });

  it('a crush on the opposite gender alone does not pin the roll', () => {
    const outcomes = new Set<string>();
    for (let seed = 0; seed < 400; seed++) {
      outcomes.add(assignOrientations(town(), [crush(1, 3, 90, 90)], makeRng(seed)).get(1)!);
    }
    // Free to roll straight, but also the rare bi / gay.
    expect(outcomes.has('straight')).toBe(true);
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it('romance of exactly 30 is not a crush (strictly above)', () => {
    const outcomes = new Set<string>();
    for (let seed = 0; seed < 400; seed++) {
      outcomes.add(assignOrientations(town(), [crush(1, 2, 30, 30)], makeRng(seed)).get(1)!);
    }
    expect(outcomes.has('straight')).toBe(true);
  });

  it('ignores relationships that point at agents outside the list', () => {
    expect(() => assignOrientations(town(), [crush(1, 99, 90, 90)], makeRng(3))).not.toThrow();
  });

  it('roughly 88 / 7 / 5 over a big free town', () => {
    const many = Array.from({ length: 4000 }, (_, i) => agent(i + 1, i % 2 ? 'male' : 'female'));
    const counts = { straight: 0, bi: 0, gay: 0 };
    for (const o of assignOrientations(many, [], makeRng(7)).values()) counts[o]++;
    expect(counts.straight / 4000).toBeGreaterThan(0.85);
    expect(counts.straight / 4000).toBeLessThan(0.91);
    expect(counts.bi / 4000).toBeGreaterThan(0.05);
    expect(counts.bi / 4000).toBeLessThan(0.09);
    expect(counts.gay / 4000).toBeGreaterThan(0.03);
    expect(counts.gay / 4000).toBeLessThan(0.07);
  });
});

describe('rollOrientation', () => {
  it('is deterministic per rng state and stays in the vocabulary', () => {
    expect(rollOrientation(makeRng(5))).toBe(rollOrientation(makeRng(5)));
    for (let s = 0; s < 50; s++) expect(['straight', 'gay', 'bi']).toContain(rollOrientation(makeRng(s)));
  });
});
