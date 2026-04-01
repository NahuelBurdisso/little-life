import { describe, it, expect } from 'vitest';
import {
  recencyScore,
  importanceScore,
  combinedScore,
  rankCandidates,
  partialSort,
} from '../RetrievalEngine';
import type { ScoredCandidate } from '../types';

describe('recencyScore', () => {
  it('returns 1.0 when currentTick equals lastAccessed', () => {
    expect(recencyScore(100, 100)).toBe(1.0);
  });

  it('returns ~0.61 after 100 ticks of decay', () => {
    const score = recencyScore(0, 100);
    expect(score).toBeCloseTo(0.61, 1);
  });

  it('returns less than 0.01 after 1000 ticks of decay', () => {
    const score = recencyScore(0, 1000);
    expect(score).toBeLessThan(0.01);
  });

  it('clamps to 1.0 when elapsed is negative (currentTick < lastAccessed)', () => {
    expect(recencyScore(200, 100)).toBe(1.0);
  });
});

describe('importanceScore', () => {
  it('normalises importance 10 to 1.0', () => {
    expect(importanceScore(10)).toBe(1.0);
  });

  it('normalises importance 5 to 0.5', () => {
    expect(importanceScore(5)).toBe(0.5);
  });

  it('normalises importance 0 to 0.0', () => {
    expect(importanceScore(0)).toBe(0.0);
  });

  it('clamps values above 10 to 1.0', () => {
    expect(importanceScore(20)).toBe(1.0);
  });

  it('clamps negative values to 0.0', () => {
    expect(importanceScore(-5)).toBe(0.0);
  });
});

describe('combinedScore', () => {
  it('sums the three weighted dimensions', () => {
    const score = combinedScore(0.5, 0.5, 0.5, { recency: 1, importance: 1, relevance: 1 });
    expect(score).toBeCloseTo(1.5);
  });

  it('respects custom weights', () => {
    const score = combinedScore(1, 0, 0, { recency: 2, importance: 1, relevance: 1 });
    expect(score).toBeCloseTo(2);
  });
});

describe('rankCandidates', () => {
  const candidates: ScoredCandidate[] = [
    { memoryId: 1, lastAccessed: 0, importance: 5, similarity: 0.5 },
    { memoryId: 2, lastAccessed: 990, importance: 9, similarity: 0.9 },
    { memoryId: 3, lastAccessed: 500, importance: 3, similarity: 0.1 },
    { memoryId: 4, lastAccessed: 995, importance: 8, similarity: 0.8 },
  ];

  it('returns results in descending score order', () => {
    const ranked = rankCandidates(candidates, 1000, 4);
    const scores = ranked.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it('respects topK limit', () => {
    const ranked = rankCandidates(candidates, 1000, 2);
    expect(ranked).toHaveLength(2);
  });

  it('attaches a score to each result', () => {
    const ranked = rankCandidates(candidates, 1000, 4);
    for (const r of ranked) {
      expect(typeof r.score).toBe('number');
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('partialSort', () => {
  it('returns the top-K items in descending order', () => {
    const items = [3, 1, 4, 1, 5, 9, 2, 6];
    const result = partialSort(items, 3, (a, b) => a - b);
    expect(result).toEqual([9, 6, 5]);
  });

  it('handles k greater than the array length', () => {
    const items = [2, 1, 3];
    const result = partialSort(items, 10, (a, b) => a - b);
    expect(result).toHaveLength(3);
    expect(result).toEqual([3, 2, 1]);
  });

  it('returns empty array for empty input', () => {
    expect(partialSort([], 5, (a, b) => (a as number) - (b as number))).toEqual([]);
  });

  it('returns a single item when k=1', () => {
    const items = [7, 2, 9, 4];
    const result = partialSort(items, 1, (a, b) => a - b);
    expect(result).toEqual([9]);
  });
});
