import { describe, it, expect } from 'vitest';
import { roadsStage, computeRoadPositions, deriveZones } from '../stages/roads';
import { forkRng } from '../rng';
import type { WorldContext } from '../types';

function ctxWith(width: number, height: number): WorldContext {
  return {
    dimensions: { width, height },
    terrainTiles: [], roads: null,
    publicBuildings: null, homes: null, interiors: null, names: null,
  };
}

const CFG = { seed: 'test', sizeTier: 'medium' as const, overrides: {} };

describe('road positions', () => {
  it('computes proportional positions for 60×45', () => {
    const r = computeRoadPositions(60, 45);
    expect(r.mainStreetY).toBe(Math.floor(45 * 0.33));
    expect(r.crossPathY).toBe(Math.floor(45 * 0.70));
    expect(r.vertWestX).toBe(Math.floor(60 * 0.27));
    expect(r.vertEastX).toBe(Math.floor(60 * 0.60));
  });

  it('computes proportional positions for 80×60', () => {
    const r = computeRoadPositions(80, 60);
    expect(r.mainStreetY).toBe(Math.floor(60 * 0.33));
    expect(r.crossPathY).toBe(Math.floor(60 * 0.70));
    expect(r.vertWestX).toBe(Math.floor(80 * 0.27));
    expect(r.vertEastX).toBe(Math.floor(80 * 0.60));
  });
});

describe('zone derivation', () => {
  it('produces exactly 9 zones', () => {
    const r = computeRoadPositions(60, 45);
    const zones = deriveZones(r, 60, 45);
    expect(zones).toHaveLength(9);
  });

  it('zone IDs are unique', () => {
    const r = computeRoadPositions(60, 45);
    const zones = deriveZones(r, 60, 45);
    const ids = zones.map((z) => z.id);
    expect(new Set(ids).size).toBe(9);
  });

  it('zones do not overlap', () => {
    const r = computeRoadPositions(60, 45);
    const zones = deriveZones(r, 60, 45);
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i].bounds, b = zones[j].bounds;
        const overlap = a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
        expect(overlap).toBe(false);
      }
    }
  });

  it('all zones have all 4 affinity keys', () => {
    const r = computeRoadPositions(60, 45);
    const zones = deriveZones(r, 60, 45);
    const keys = ['commercial', 'civic', 'residential', 'mainStreet'];
    for (const z of zones) {
      for (const k of keys) {
        expect(z.affinity[k]).toBeDefined();
        expect(z.affinity[k]).toBeGreaterThanOrEqual(0);
        expect(z.affinity[k]).toBeLessThanOrEqual(5);
      }
    }
  });

  it('se zone has highest mainStreet score', () => {
    const r = computeRoadPositions(60, 45);
    const zones = deriveZones(r, 60, 45);
    const se = zones.find((z) => z.id === 'se')!;
    expect(se.affinity.mainStreet).toBe(4);
  });

  it('nc zone has highest civic score', () => {
    const r = computeRoadPositions(60, 45);
    const zones = deriveZones(r, 60, 45);
    const nc = zones.find((z) => z.id === 'nc')!;
    expect(nc.affinity.civic).toBe(5);
  });
});

describe('roadsStage', () => {
  it('produces tiles and zones', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'roads');
    const result = roadsStage.run(ctx, rng, CFG, 10, {});
    expect(result.roads!.tiles.length).toBeGreaterThan(0);
    expect(result.roads!.zones).toHaveLength(9);
  });

  it('road tiles stay within map bounds', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'roads');
    const { roads } = roadsStage.run(ctx, rng, CFG, 10, {});
    for (const t of roads!.tiles) {
      expect(t.x).toBeGreaterThanOrEqual(1);
      expect(t.x).toBeLessThan(60 - 1);
      expect(t.y).toBeGreaterThanOrEqual(1);
      expect(t.y).toBeLessThan(45 - 1);
    }
  });

  it('road tiles do not overlap zone bounds', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'roads');
    const { roads } = roadsStage.run(ctx, rng, CFG, 10, {});
    const roadSet = new Set(roads!.tiles.map((t) => `${t.x},${t.y}`));
    for (const z of roads!.zones) {
      for (let y = z.bounds.y1; y <= z.bounds.y2; y++) {
        for (let x = z.bounds.x1; x <= z.bounds.x2; x++) {
          expect(roadSet.has(`${x},${y}`)).toBe(false);
        }
      }
    }
  });
});
