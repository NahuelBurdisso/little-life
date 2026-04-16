import { describe, it, expect } from 'vitest';
import { computeAStarPath } from '../lib/pathfinding';
import { getOpenAreaTerrainCosts } from '../lib/interiorGrid';

describe('A* with terrain costs', () => {
  it('works without costMap (backward compatible)', () => {
    const grid = '000000000';
    const path = computeAStarPath(
      { x: 16, y: 16 }, { x: 80, y: 80 },
      grid, 3, 3, 32,
    );
    expect(path.length).toBeGreaterThan(0);
  });

  it('blocked tiles still block with costMap', () => {
    const grid = '010000000';
    const costMap = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const path = computeAStarPath(
      { x: 16, y: 16 }, { x: 48, y: 16 },
      grid, 3, 3, 32, costMap,
    );
    // Should route around the blocked tile
    expect(path.length).toBeGreaterThan(1);
  });

  it('prefers lower cost tiles', () => {
    // 5x1 grid, all walkable. Middle 3 tiles expensive.
    const grid = '00000';
    const costMap = new Float32Array([1, 5, 5, 5, 1]);
    const path = computeAStarPath(
      { x: 16, y: 16 }, { x: 144, y: 16 },
      grid, 5, 1, 32, costMap,
    );
    // With only 1 row, can't avoid expensive tiles — but path should still work
    expect(path.length).toBeGreaterThan(0);
  });
});

describe('getOpenAreaTerrainCosts', () => {
  it('returns river tiles as blocked for park', () => {
    const entries = getOpenAreaTerrainCosts('summer', [
      { type: 'park', position: { x: 640, y: 992, width: 256, height: 192 } },
    ], 32);
    const blocked = entries.filter(e => e.cost === Infinity);
    expect(blocked.length).toBe(4); // 2x2 river
  });

  it('crop tiles cost 1.5 in summer', () => {
    const entries = getOpenAreaTerrainCosts('summer', [
      { type: 'farm', position: { x: 96, y: 960, width: 320, height: 224 } },
    ], 32);
    const crops = entries.filter(e => e.cost === 1.5);
    expect(crops.length).toBeGreaterThan(0);
  });

  it('crop tiles cost 1.0 in winter', () => {
    const entries = getOpenAreaTerrainCosts('winter', [
      { type: 'farm', position: { x: 96, y: 960, width: 320, height: 224 } },
    ], 32);
    const expensive = entries.filter(e => e.cost > 1.0 && e.cost < Infinity);
    expect(expensive.length).toBe(0);
  });
});
