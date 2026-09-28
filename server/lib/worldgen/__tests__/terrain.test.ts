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
  seed: string;
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
  return { seed, ctx, width, height, tiles, occupied, doors, eligible };
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

  // Invariant checks collect every violation and assert once: an expect() per
  // tile over 40 worlds × ~400 tiles made this file take ~4.5 s, and a single
  // `toEqual([])` also prints every offender instead of stopping at the first.
  const tag = (w: World) => `${w.seed}@${w.width}x${w.height}`;

  it('emits only the six current kinds, never the legacy tall_grass', () => {
    const bad: string[] = [];
    for (const w of WORLDS) {
      for (const t of w.tiles) if (!EMITTED.has(t.kind)) bad.push(`${tag(w)} ${key(t)} ${t.kind}`);
    }
    // tall_grass is not in EMITTED, so this also covers the legacy kind.
    expect(EMITTED.has('tall_grass')).toBe(false);
    expect(bad).toEqual([]);
  });

  it('tiles stay within map bounds (excluding border)', () => {
    const bad: string[] = [];
    for (const w of WORLDS) {
      for (const t of w.tiles) {
        if (t.x < 1 || t.y < 1 || t.x >= w.width - 1 || t.y >= w.height - 1) bad.push(`${tag(w)} ${key(t)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives each tile at most one kind', () => {
    const bad: string[] = [];
    for (const w of WORLDS) {
      const n = new Set(w.tiles.map(key)).size;
      if (n !== w.tiles.length) bad.push(`${tag(w)}: ${w.tiles.length - n} duplicates`);
    }
    expect(bad).toEqual([]);
  });

  it('is deterministic', () => {
    const a = terrainStage.run(ctxWith(60, 45), forkRng('test', 'terrain'), CFG, AGENTS, {});
    const b = terrainStage.run(ctxWith(60, 45), forkRng('test', 'terrain'), CFG, AGENTS, {});
    expect(a.terrainTiles).toEqual(b.terrainTiles);
  });

  it('decorates 10-22% of the tiles it is allowed to decorate, in every world', () => {
    // The denominator excludes roads, footprints and doors: those can never be
    // decorated, so counting them made the share look lower than it is.
    const bad: string[] = [];
    for (const w of WORLDS) {
      const ratio = w.tiles.length / w.eligible;
      if (ratio < 0.10 || ratio > 0.22) bad.push(`${tag(w)}: ${ratio.toFixed(3)}`);
    }
    expect(bad).toEqual([]);
  });

  it('puts flowers, grass tufts, dirt, trees and bushes in every world', () => {
    const bad: string[] = [];
    for (const w of WORLDS) {
      const kinds = new Set(w.tiles.map((t) => t.kind));
      for (const k of REQUIRED) if (!kinds.has(k)) bad.push(`${tag(w)}: no ${k}`);
    }
    expect(bad).toEqual([]);
  });

  it('never decorates a road tile, a building footprint or a door', () => {
    const bad: string[] = [];
    for (const w of WORLDS) {
      for (const t of w.tiles) if (w.occupied.has(key(t))) bad.push(`${tag(w)} ${key(t)} ${t.kind}`);
    }
    expect(bad).toEqual([]);
  });

  it('never decorates a door tile (which sits one row below the footprint)', () => {
    const bad: string[] = [];
    for (const w of WORLDS) {
      if (w.doors.size === 0) bad.push(`${tag(w)}: no doors to check`);
      for (const t of w.tiles) if (w.doors.has(key(t))) bad.push(`${tag(w)} ${key(t)} ${t.kind}`);
    }
    expect(bad).toEqual([]);
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
    const bad: string[] = [];
    for (const w of WORLDS) {
      const trees = w.tiles.filter((t) => t.kind === 'tree');
      for (let i = 0; i < trees.length; i++) {
        for (let j = i + 1; j < trees.length; j++) {
          const d = Math.hypot(trees[i].x - trees[j].x, trees[i].y - trees[j].y);
          if (d < TREE_RADIUS) bad.push(`${tag(w)} ${key(trees[i])}-${key(trees[j])} ${d.toFixed(2)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it(`leaves ${TREE_CLEARANCE} clear tiles between a tree and any road, footprint or door`, () => {
    const bad: string[] = [];
    for (const w of WORLDS) {
      for (const t of w.tiles.filter((tt) => tt.kind === 'tree')) {
        for (let dy = -TREE_CLEARANCE; dy <= TREE_CLEARANCE; dy++) {
          for (let dx = -TREE_CLEARANCE; dx <= TREE_CLEARANCE; dx++) {
            const k = `${t.x + dx},${t.y + dy}`;
            if (w.occupied.has(k)) bad.push(`${tag(w)} tree ${key(t)} near ${k}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
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
