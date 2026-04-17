import { describe, it, expect } from 'vitest';
import { terrainStage } from '../stages/terrain';
import { forkRng } from '../rng';
import type { WorldContext } from '../types';

function ctxWith(width: number, height: number): WorldContext {
  return {
    dimensions: { width, height },
    terrainTiles: null, roads: null,
    publicBuildings: null, homes: null, interiors: null, names: null,
  };
}

const CFG = { seed: 'test', sizeTier: 'auto' as const, overrides: {} };

describe('terrain stage', () => {
  it('produces terrain tiles', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'terrain');
    const result = terrainStage.run(ctx, rng, CFG, 10, {});
    expect(result.terrainTiles.length).toBeGreaterThan(0);
  });

  it('all tiles have valid kind', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'terrain');
    const result = terrainStage.run(ctx, rng, CFG, 10, {});
    const validKinds = new Set(['dirt_patch', 'flowers', 'tall_grass']);
    for (const t of result.terrainTiles) {
      expect(validKinds.has(t.kind)).toBe(true);
    }
  });

  it('tiles stay within map bounds (excluding border)', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'terrain');
    const result = terrainStage.run(ctx, rng, CFG, 10, {});
    for (const t of result.terrainTiles) {
      expect(t.x).toBeGreaterThanOrEqual(1);
      expect(t.x).toBeLessThan(60 - 1);
      expect(t.y).toBeGreaterThanOrEqual(1);
      expect(t.y).toBeLessThan(45 - 1);
    }
  });

  it('is deterministic', () => {
    const ctxA = ctxWith(60, 45);
    const ctxB = ctxWith(60, 45);
    const rngA = forkRng('test', 'terrain');
    const rngB = forkRng('test', 'terrain');
    const a = terrainStage.run(ctxA, rngA, CFG, 10, {});
    const b = terrainStage.run(ctxB, rngB, CFG, 10, {});
    expect(a.terrainTiles).toEqual(b.terrainTiles);
  });

  it('roughly 13% of interior tiles are decorated', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'terrain');
    const result = terrainStage.run(ctx, rng, CFG, 10, {});
    const interiorTileCount = (60 - 2) * (45 - 2); // excluding border
    const ratio = result.terrainTiles.length / interiorTileCount;
    expect(ratio).toBeGreaterThan(0.05);
    expect(ratio).toBeLessThan(0.25);
  });

  it('throws when dimensions not populated', () => {
    const ctx: WorldContext = {
      dimensions: null,
      terrainTiles: null, roads: null,
      publicBuildings: null, homes: null, interiors: null, names: null,
    };
    const rng = forkRng('test', 'terrain');
    expect(() => terrainStage.run(ctx, rng, CFG, 10, {})).toThrow('terrain: dimensions not populated');
  });
});
