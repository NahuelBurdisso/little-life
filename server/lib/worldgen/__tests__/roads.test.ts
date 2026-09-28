import { describe, it, expect } from 'vitest';
import { roadsStage, computeRoadPositions, deriveZones } from '../stages/roads';
import { forkRng } from '../rng';
import { BORDER_BUFFER, MIN_WIDTH, MIN_HEIGHT, MAX_WIDTH, MAX_HEIGHT } from '../config';
import type { WorldContext } from '../types';

function ctxWith(width: number, height: number): WorldContext {
  return {
    dimensions: { width, height },
    terrainTiles: [], roads: null,
    publicBuildings: null, homes: null, interiors: null, names: null, warnings: null,
  };
}

const CFG = { seed: 'test', sizeTier: 'medium' as const, overrides: {} };

/** Every map size the pipeline can legally produce, plus the two extremes. */
const SIZES: Array<[number, number]> = [
  [MIN_WIDTH, MIN_HEIGHT], [57, 44], [59, 45], [62, 48], [70, 55], [MAX_WIDTH, MAX_HEIGHT],
];

describe('road positions', () => {
  // These used to assert `mainStreetY === floor(h * 0.33)` and so on for all
  // four roads, which is a restatement of the implementation: it can only fail
  // when someone changes the constants, and it fails then whether or not the
  // change was an improvement. It duly went red on a change that halved zone
  // imbalance. Assert the properties the fractions were chosen for instead.

  it('orders the roads and leaves a buildable band between them', () => {
    for (const [w, h] of SIZES) {
      const r = computeRoadPositions(w, h);
      // Each road is 2 tiles wide and wants ROAD_BUFFER either side, so
      // consecutive roads must be at least 4 apart to leave anything between.
      expect(r.mainStreetY, `${w}×${h} mainStreetY`).toBeGreaterThanOrEqual(BORDER_BUFFER + 2);
      expect(r.crossPathY - r.mainStreetY, `${w}×${h} row gap`).toBeGreaterThanOrEqual(4);
      expect(h - 1 - BORDER_BUFFER - r.crossPathY, `${w}×${h} south band`).toBeGreaterThanOrEqual(4);
      expect(r.vertWestX, `${w}×${h} vertWestX`).toBeGreaterThanOrEqual(BORDER_BUFFER + 2);
      expect(r.vertEastX - r.vertWestX, `${w}×${h} col gap`).toBeGreaterThanOrEqual(4);
      expect(w - 1 - BORDER_BUFFER - r.vertEastX, `${w}×${h} east band`).toBeGreaterThanOrEqual(4);
    }
  });

  it('produces nine near-equal zones at every legal map size', () => {
    // This is the actual design goal of the fractions. Because the roads, their
    // buffers and the border frame come off the columns unequally, evenly spaced
    // fractions do *not* give evenly sized zones — the previous 0.27/0.60/0.70
    // set put the largest zone at 2.0-2.3× the smallest at every size, which
    // pushed the three biggest templates into the three smallest zones.
    for (const [w, h] of SIZES) {
      const zones = deriveZones(computeRoadPositions(w, h), w, h);
      const areas = zones.map(
        (z) => (z.bounds.x2 - z.bounds.x1 + 1) * (z.bounds.y2 - z.bounds.y1 + 1),
      );
      const ratio = Math.max(...areas) / Math.min(...areas);
      expect(ratio, `${w}×${h} max:min zone area`).toBeLessThan(1.3);
    }
  });

  it('keeps the largest template footprint inside every zone', () => {
    // farm is 10×7 and town_square 9×8, so no zone may be under 10 wide or
    // 8 tall or one of them has nowhere legal to go.
    for (const [w, h] of SIZES) {
      for (const z of deriveZones(computeRoadPositions(w, h), w, h)) {
        expect(z.bounds.x2 - z.bounds.x1 + 1, `${w}×${h} ${z.id} width`).toBeGreaterThanOrEqual(10);
        expect(z.bounds.y2 - z.bounds.y1 + 1, `${w}×${h} ${z.id} height`).toBeGreaterThanOrEqual(8);
      }
    }
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
