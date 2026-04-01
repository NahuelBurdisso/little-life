import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingCache } from '../EmbeddingCache';

/** Build a 4-dimensional Float32Array from a plain array. */
function vec(values: number[]): Float32Array {
  return new Float32Array(values);
}

describe('EmbeddingCache', () => {
  let cache: EmbeddingCache;

  beforeEach(() => {
    // Small dims (4) for readability; unlimited capacity by default in this suite.
    cache = new EmbeddingCache(1000, 4);
  });

  // ── 1. Store & retrieve (exact match → similarity ≈ 1.0) ─────────────────
  it('returns similarity ≈ 1.0 for an exact match', () => {
    const v = vec([1, 0, 0, 0]);
    cache.add(1, 10, 5, 100, v);

    const results = cache.search(1, v, 1);
    expect(results).toHaveLength(1);
    expect(results[0].memoryId).toBe(10);
    expect(results[0].similarity).toBeCloseTo(1.0, 5);
  });

  // ── 2. Agent isolation ───────────────────────────────────────────────────
  it('agent 2 cannot see agent 1 vectors', () => {
    cache.add(1, 10, 5, 100, vec([1, 0, 0, 0]));

    const results = cache.search(2, vec([1, 0, 0, 0]), 5);
    expect(results).toHaveLength(0);
  });

  // ── 3. Top-K sorted by similarity descending ────────────────────────────
  it('returns top-K results sorted by similarity descending', () => {
    // Three orthogonal unit vectors: only the first matches the query well.
    cache.add(1, 1, 5, 100, vec([1, 0, 0, 0]));  // sim=1.0 with query
    cache.add(1, 2, 5, 100, vec([0, 1, 0, 0]));  // sim=0.0
    cache.add(1, 3, 5, 100, vec([0, 0, 1, 0]));  // sim=0.0

    const results = cache.search(1, vec([1, 0, 0, 0]), 2);
    expect(results).toHaveLength(2);
    expect(results[0].memoryId).toBe(1);
    expect(results[0].similarity).toBeCloseTo(1.0, 5);
    // Second result must have lower or equal similarity
    expect(results[1].similarity).toBeLessThanOrEqual(results[0].similarity);
  });

  // ── 4. LRU eviction when over capacity ──────────────────────────────────
  it('evicts the entry with the lowest lastAccessed when over capacity', () => {
    const small = new EmbeddingCache(2, 4);

    small.add(1, 1, 5, 10, vec([1, 0, 0, 0]));   // lastAccessed=10 (oldest)
    small.add(1, 2, 5, 20, vec([0, 1, 0, 0]));   // lastAccessed=20

    expect(small.getAgentSize(1)).toBe(2);

    // Adding a third entry should evict id=1 (lowest lastAccessed=10)
    small.add(1, 3, 5, 30, vec([0, 0, 1, 0]));   // lastAccessed=30

    expect(small.getAgentSize(1)).toBe(2);

    // id=1 should be gone
    const results = small.search(1, vec([1, 0, 0, 0]), 5);
    const ids = results.map((r) => r.memoryId);
    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  // ── 5. Pre-normalization (unnormalized input) ────────────────────────────
  it('unnormalized [3,4,0,0] queried with [6,8,0,0] gives similarity ≈ 1.0', () => {
    cache.add(1, 42, 5, 100, vec([3, 4, 0, 0]));

    const results = cache.search(1, vec([6, 8, 0, 0]), 1);
    expect(results).toHaveLength(1);
    expect(results[0].similarity).toBeCloseTo(1.0, 5);
  });

  // ── 6. clear() removes all entries ──────────────────────────────────────
  it('clear() removes all agents and entries', () => {
    cache.add(1, 1, 5, 100, vec([1, 0, 0, 0]));
    cache.add(2, 2, 5, 100, vec([0, 1, 0, 0]));

    cache.clear();

    expect(cache.getAgentSize(1)).toBe(0);
    expect(cache.getAgentSize(2)).toBe(0);
  });

  // ── 7. updateLastAccessed() ──────────────────────────────────────────────
  it('updateLastAccessed updates the tick for a stored entry', () => {
    cache.add(1, 10, 5, 50, vec([1, 0, 0, 0]));

    cache.updateLastAccessed(1, 10, 999);

    const results = cache.search(1, vec([1, 0, 0, 0]), 1);
    expect(results[0].lastAccessed).toBe(999);
  });

  // ── 8. Zero-vector handling ──────────────────────────────────────────────
  it('does not crash when a zero vector is inserted', () => {
    expect(() => {
      cache.add(1, 99, 5, 100, vec([0, 0, 0, 0]));
    }).not.toThrow();
  });

  it('does not crash when searching with a zero query vector', () => {
    cache.add(1, 10, 5, 100, vec([1, 0, 0, 0]));

    expect(() => {
      cache.search(1, vec([0, 0, 0, 0]), 1);
    }).not.toThrow();
  });

  // ── Additional: clearAgent() ─────────────────────────────────────────────
  it('clearAgent() removes only the specified agent', () => {
    cache.add(1, 1, 5, 100, vec([1, 0, 0, 0]));
    cache.add(2, 2, 5, 100, vec([0, 1, 0, 0]));

    cache.clearAgent(1);

    expect(cache.getAgentSize(1)).toBe(0);
    expect(cache.getAgentSize(2)).toBe(1);
  });
});
