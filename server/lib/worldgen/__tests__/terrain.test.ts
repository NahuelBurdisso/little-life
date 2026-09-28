import { describe, it, expect } from 'vitest';
import { terrainStage, TREE_RADIUS, TREE_CLEARANCE } from '../stages/terrain';
import { roadsStage } from '../stages/roads';
import { layoutStage } from '../stages/layout';
import { homesStage } from '../stages/homes';
import { forkRng } from '../rng';
import type { TerrainTile, WorldContext } from '../types';

const AGENTS = 13;
const cfgFor = (seed: string) => ({ seed, sizeTier: 'auto' as const, overrides: {} });
const CFG = cfgFor('test');

const EMITTED = new Set(['flowers', 'grass_tuft', 'dirt_patch', 'tree', 'bush', 'rock']);
/** Kinds every world must contain. Rocks are deliberately sparse (~0.5%) and
 *  are not required. */
const REQUIRED = ['flowers', 'grass_tuft', 'dirt_patch', 'tree', 'bush'];

/** Terrain runs after roads, layout and homes so it can avoid decorating them;
 *  build the same context the pipeline would. */
function ctxWith(width: number, height: number, seed = 'test'): WorldContext {
  const cfg = cfgFor(seed);
  const ctx: WorldContext = {
    dimensions: { width, height },
    terrainTiles: null, roads: null,
    publicBuildings: null, homes: null, interiors: null, names: null, warnings: null,
  };
  ctx.roads = roadsStage.run(ctx, forkRng(seed, 'roads'), cfg, AGENTS, {}).roads;
  ctx.publicBuildings = layoutStage.run(ctx, forkRng(seed, 'layout'), cfg, AGENTS, {}).publicBuildings;
  ctx.homes = homesStage.run(ctx, forkRng(seed, 'homes'), cfg, AGENTS, {}).homes;
  return ctx;
}

interface World {
  ctx: WorldContext;
  width: number;
  height: number;
  tiles: TerrainTile[];
  /** Roads, every non-mainstreet footprint and every door tile. */
  occupied: Set<string>;
  doors: Set<string>;
  /** Interior tiles (border ring excluded) that are not occupied. */
  eligible: number;
}

function build(width: number, height: number, seed: string): World {
  const ctx = ctxWith(width, height, seed);
  const tiles = terrainStage.run(ctx, forkRng(seed, 'terrain'), cfgFor(seed), AGENTS, {}).terrainTiles;
  const occupied = new Set(ctx.roads!.tiles.map((t) => `${t.x},${t.y}`));
  const doors = new Set<string>();
  for (const loc of [...ctx.publicBuildings!, ...ctx.homes!]) {
    if (loc.type === 'mainstreet') continue;
    const tx = loc.position.x / 32, ty = loc.position.y / 32;
    const tw = loc.position.width / 32, th = loc.position.height / 32;
    for (let y = ty; y < ty + th; y++) for (let x = tx; x < tx + tw; x++) occupied.add(`${x},${y}`);
    const door = `${Math.floor(loc.entry_point.x / 32)},${Math.floor(loc.entry_point.y / 32)}`;
    doors.add(door);
    occupied.add(door);
  }
  let eligible = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) if (!occupied.has(`${x},${y}`)) eligible++;
  }
  return { ctx, width, height, tiles, occupied, doors, eligible };
}

// 20 seeds at each of the two tier sizes, built once and shared.
const SEEDS = Array.from({ length: 20 }, (_, i) => `terrain-${i}`);
const WORLDS: World[] = [];
for (const [w, h] of [[60, 45], [80, 60]] as const) {
  for (const seed of SEEDS) WORLDS.push(build(w, h, seed));
}

const key = (t: { x: number; y: number }) => `${t.x},${t.y}`;

describe('terrain stage', () => {
  it('produces terrain tiles', () => {
    const ctx = ctxWith(60, 45);
    const result = terrainStage.run(ctx, forkRng('test', 'terrain'), CFG, AGENTS, {});
    expect(result.terrainTiles.length).toBeGreaterThan(0);
  });

  it('emits only the six current kinds, never the legacy tall_grass', () => {
    for (const w of WORLDS) {
      for (const t of w.tiles) {
        expect(EMITTED.has(t.kind), `unexpected kind ${t.kind}`).toBe(true);
        expect(t.kind).not.toBe('tall_grass');
      }
    }
  });

  it('tiles stay within map bounds (excluding border)', () => {
    for (const w of WORLDS) {
      for (const t of w.tiles) {
        expect(t.x).toBeGreaterThanOrEqual(1);
        expect(t.x).toBeLessThan(w.width - 1);
        expect(t.y).toBeGreaterThanOrEqual(1);
        expect(t.y).toBeLessThan(w.height - 1);
      }
    }
  });

  it('gives each tile at most one kind', () => {
    for (const w of WORLDS) {
      expect(new Set(w.tiles.map(key)).size).toBe(w.tiles.length);
    }
  });

  it('is deterministic', () => {
    const a = terrainStage.run(ctxWith(60, 45), forkRng('test', 'terrain'), CFG, AGENTS, {});
    const b = terrainStage.run(ctxWith(60, 45), forkRng('test', 'terrain'), CFG, AGENTS, {});
    expect(a.terrainTiles).toEqual(b.terrainTiles);
  });

  it('decorates 10-22% of the tiles it is allowed to decorate, in every world', () => {
    // The denominator excludes roads, footprints and doors: those can never be
    // decorated, so counting them made the share look lower than it is.
    for (const w of WORLDS) {
      const ratio = w.tiles.length / w.eligible;
      expect(ratio, `${w.width}x${w.height}`).toBeGreaterThanOrEqual(0.10);
      expect(ratio).toBeLessThanOrEqual(0.22);
    }
  });

  it('puts flowers, grass tufts, dirt, trees and bushes in every world', () => {
    for (const w of WORLDS) {
      const kinds = new Set(w.tiles.map((t) => t.kind));
      for (const k of REQUIRED) expect(kinds.has(k), `${k} missing`).toBe(true);
    }
  });

  it('never decorates a road tile, a building footprint or a door', () => {
    for (const w of WORLDS) {
      for (const t of w.tiles) {
        expect(w.occupied.has(key(t)), `${key(t)} is a road, footprint or door`).toBe(false);
      }
    }
  });

  it('never decorates a door tile (which sits one row below the footprint)', () => {
    for (const w of WORLDS) {
      expect(w.doors.size).toBeGreaterThan(0);
      for (const t of w.tiles) expect(w.doors.has(key(t))).toBe(false);
    }
  });

  it('clusters flowers and dirt into patches rather than salt', () => {
    // P(a tile has a same-kind 4-neighbour). The old uniform roll gave ~0.03
    // for flowers and ~0.05 for dirt; noise-thresholded patches give far more.
    for (const kind of ['flowers', 'dirt_patch']) {
      let sum = 0;
      for (const w of WORLDS) {
        const set = new Set(w.tiles.filter((t) => t.kind === kind).map(key));
        let withNeighbour = 0;
        for (const k of set) {
          const [x, y] = k.split(',').map(Number);
          if (set.has(`${x + 1},${y}`) || set.has(`${x - 1},${y}`)
            || set.has(`${x},${y + 1}`) || set.has(`${x},${y - 1}`)) withNeighbour++;
        }
        sum += withNeighbour / set.size;
      }
      expect(sum / WORLDS.length, kind).toBeGreaterThanOrEqual(0.35);
    }
  });

  it('spaces trees at least the Poisson radius apart', () => {
    for (const w of WORLDS) {
      const trees = w.tiles.filter((t) => t.kind === 'tree');
      for (let i = 0; i < trees.length; i++) {
        for (let j = i + 1; j < trees.length; j++) {
          const d = Math.hypot(trees[i].x - trees[j].x, trees[i].y - trees[j].y);
          expect(d).toBeGreaterThanOrEqual(TREE_RADIUS);
        }
      }
    }
  });

  it(`keeps trees at least ${TREE_CLEARANCE} tiles from roads, footprints and doors`, () => {
    for (const w of WORLDS) {
      for (const t of w.tiles.filter((tt) => tt.kind === 'tree')) {
        for (let dy = -TREE_CLEARANCE; dy <= TREE_CLEARANCE; dy++) {
          for (let dx = -TREE_CLEARANCE; dx <= TREE_CLEARANCE; dx++) {
            const k = `${t.x + dx},${t.y + dy}`;
            expect(w.occupied.has(k), `tree at ${key(t)} is next to ${k}`).toBe(false);
          }
        }
      }
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
