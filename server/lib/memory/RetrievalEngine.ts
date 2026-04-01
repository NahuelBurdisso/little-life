import { DECAY_RATE, SCORE_WEIGHTS } from './constants';
import type { ScoredCandidate } from './types';

export interface ScoreWeights {
  recency: number;
  importance: number;
  relevance: number;
}

/**
 * Recency score: exponential decay based on ticks elapsed since last access.
 * Formula: DECAY_RATE ^ (currentTick - lastAccessed)
 */
export function recencyScore(lastAccessed: number, currentTick: number): number {
  const elapsed = Math.max(0, currentTick - lastAccessed);
  return Math.pow(DECAY_RATE, elapsed);
}

/**
 * Importance score: normalise [0,10] importance value to [0,1].
 * Clamped to ensure it stays within bounds.
 */
export function importanceScore(importance: number): number {
  return Math.min(1, Math.max(0, importance / 10));
}

/**
 * Combined weighted score from all three dimensions.
 */
export function combinedScore(
  recency: number,
  importance: number,
  relevance: number,
  weights: ScoreWeights = SCORE_WEIGHTS,
): number {
  return (
    weights.recency * recency +
    weights.importance * importance +
    weights.relevance * relevance
  );
}

/**
 * Partial sort (selection sort variant) for top-K candidates.
 * O(n * k) — more efficient than a full sort when k << n.
 */
export function partialSort<T>(
  items: T[],
  k: number,
  compareFn: (a: T, b: T) => number,
): T[] {
  if (items.length === 0) return [];
  const limit = Math.min(k, items.length);
  const result: T[] = [];
  const remaining = items.slice();

  for (let i = 0; i < limit; i++) {
    let bestIdx = 0;
    for (let j = 1; j < remaining.length; j++) {
      if (compareFn(remaining[j], remaining[bestIdx]) > 0) {
        bestIdx = j;
      }
    }
    result.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return result;
}

/**
 * Rank a list of ScoredCandidates and return the top-K by combined score.
 */
export function rankCandidates(
  candidates: ScoredCandidate[],
  currentTick: number,
  topK: number,
  weights: ScoreWeights = SCORE_WEIGHTS,
): Array<ScoredCandidate & { score: number }> {
  const scored = candidates.map((c) => ({
    ...c,
    score: combinedScore(
      recencyScore(c.lastAccessed, currentTick),
      importanceScore(c.importance),
      c.similarity,
      weights,
    ),
  }));

  return partialSort(scored, topK, (a, b) => a.score - b.score);
}
