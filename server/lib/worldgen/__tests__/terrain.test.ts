import { describe, it, expect } from 'vitest';
import { terrainStage } from '../stages/terrain';
import { roadsStage } from '../stages/roads';
import { layoutStage } from '../stages/layout';
import { forkRng } from '../rng';
import type { WorldContext } from '../types';

const CFG = { seed: 'test', sizeTier: 'auto' as const, overrides: {} };

/** Terrain now runs after roads and layout so it can avoid decorating them. */
function ctxWith(width: number, height: number): WorldContext {
  const ctx: WorldContext = {
    dimensions: { width, height },
    terrainTiles: null, roads: null,
    publicBuildings: null, homes: null, interiors: null, names: null, warnings: null,
  };
  ctx.roads = roadsStage.run(ctx, forkRng('test', 'roads'), CFG, 10, {}).roads;
  ctx.publicBuildings = layoutStage.run(
    ctx, forkRng('test', 'layout'), CFG, 10, {},
  ).publicBuildings;
  return ctx;
}

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

  it('decorates roughly 13% of the tiles it is allowed to decorate', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'terrain');
    const result = terrainStage.run(ctx, rng, CFG, 10, {});

    // The stage rolls against 0.13 per *eligible* tile, so the denominator has
    // to exclude roads and footprints too. Dividing by the whole interior gave
    // ~0.09 and made the "13%" in the old name look wrong.
    const excluded = new Set(ctx.roads!.tiles.map((t) => `${t.x},${t.y}`));
    for (const loc of [...ctx.publicBuildings!, ...(ctx.homes ?? [])]) {
      if (loc.type === 'mainstreet') continue;
      const tx = loc.position.x / 32, ty = loc.position.y / 32;
      const tw = loc.position.width / 32, th = loc.position.height / 32;
      for (let y = ty; y < ty + th; y++) {
        for (let x = tx; x < tx + tw; x++) excluded.add(`${x},${y}`);
      }
    }
    let eligible = 0;
    for (let y = 1; y < 45 - 1; y++) {
      for (let x = 1; x < 60 - 1; x++) if (!excluded.has(`${x},${y}`)) eligible++;
    }

    const ratio = result.terrainTiles.length / eligible;
    expect(ratio).toBeGreaterThan(0.10);
    expect(ratio).toBeLessThan(0.16);
  });

  it('never decorates a road tile or a building footprint', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'terrain');
    const result = terrainStage.run(ctx, rng, CFG, 10, {});

    const roadSet = new Set(ctx.roads!.tiles.map((t) => `${t.x},${t.y}`));
    const footprintSet = new Set<string>();
    for (const loc of ctx.publicBuildings!) {
      if (loc.type === 'mainstreet') continue;
      const tx = loc.position.x / 32, ty = loc.position.y / 32;
      const tw = loc.position.width / 32, th = loc.position.height / 32;
      for (let y = ty; y < ty + th; y++)
        for (let x = tx; x < tx + tw; x++) footprintSet.add(`${x},${y}`);
    }

    for (const t of result.terrainTiles) {
      const k = `${t.x},${t.y}`;
      expect(roadSet.has(k), `${k} is a road tile`).toBe(false);
      expect(footprintSet.has(k), `${k} is inside a building`).toBe(false);
    }
  });

  it('throws when dimensions not populated', () => {
    const ctx: WorldContext = {
      dimensions: null,
      terrainTiles: null, roads: null,
      publicBuildings: null, homes: null, interiors: null, names: null, warnings: null,
    };
    const rng = forkRng('test', 'terrain');
    expect(() => terrainStage.run(ctx, rng, CFG, 10, {})).toThrow('terrain: dimensions not populated');
  });
});
