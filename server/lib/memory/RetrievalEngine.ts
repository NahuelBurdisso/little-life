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
 * Partial sort for top-K candidates.
 * Uses selection with a Set to avoid O(n) splice, giving O(n*k) with O(k) space.
 */
export function partialSort<T>(
  items: T[],
  k: number,
  compareFn: (a: T, b: T) => number,
): T[] {
  if (items.length === 0) return [];
  if (items.length <= k) {
    return items.sort((a, b) => compareFn(b, a));
  }
  const result: T[] = [];
  const used = new Set<number>();
  for (let i = 0; i < k; i++) {
    let bestIdx = -1;
    for (let j = 0; j < items.length; j++) {
      if (used.has(j)) continue;
      if (bestIdx === -1 || compareFn(items[j], items[bestIdx]) > 0) {
        bestIdx = j;
      }
    }
    if (bestIdx === -1) break;
    result.push(items[bestIdx]);
    used.add(bestIdx);
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
