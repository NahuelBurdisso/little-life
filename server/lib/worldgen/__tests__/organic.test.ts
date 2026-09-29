import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateWorld } from '../pipeline';
import { roadsStage } from '../stages/roads';
import { layoutStage } from '../stages/layout';
import { generateOrganicRoads } from '../stages/organicRoads';
import { forkRng } from '../rng';
import { getTemplatesForAgentCount } from '../buildingTemplates';
import {
  BORDER_BUFFER, MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT, WorldGenConfigSchema,
  type WorldGenConfig,
} from '../config';
import type { GenResult, WorldContext } from '../types';
import type { SocialEdge } from '../social';

/**
 * Track C: `layoutStyle: 'organic'`. The grid's invariant suites (property,
 * layout, pipeline) re-run here against organic worlds, plus what is specific
 * to grown lanes — connectivity, the border frame, the main street hint — and
 * the guarantee that made the option safe to add: grid worlds are unchanged.
 *
 * Runtime matters: this file is on the `npm run check` path. So one shared
 * sample of worlds feeds every whole-world test, and invariant checks collect
 * violations into a list asserted once per world instead of issuing thousands
 * of `expect`s. `generateWorld` logs a line per world; that is silenced here.
 */

const TILE = 32;
const OUTDOOR = ['mainstreet', 'alley', 'market_square', 'farmyard'];

const organic = (seed: string, extra: Partial<WorldGenConfig> = {}): WorldGenConfig =>
  ({ sizeTier: 'auto', overrides: {}, seed, layoutStyle: 'organic', ...extra });

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

/**
 * The shared sample: 15 worlds at 5 agents, 45 at 13 and 30 at 30, generated
 * once, lazily. With the 20 one-agent worlds and 12 fixed-tier worlds below,
 * 122 worlds go through the full invariant check.
 */
const SAMPLE_SIZES: Record<number, number> = { 5: 15, 13: 45, 30: 30 };
const sampleCache = new Map<number, GenResult[]>();
function sample(n: number): GenResult[] {
  if (!sampleCache.has(n)) {
    sampleCache.set(n, Array.from({ length: SAMPLE_SIZES[n] }, (_, i) =>
      generateWorld(organic(`organic-${n}-${i}`), n)));
  }
  return sampleCache.get(n)!;
}

function tilesOf(r: { position: { x: number; y: number; width: number; height: number } }) {
  return {
    x: r.position.x / TILE, y: r.position.y / TILE,
    w: r.position.width / TILE, h: r.position.height / TILE,
  };
}

function ctxAt(width: number, height: number): WorldContext {
  return {
    dimensions: { width, height },
    terrainTiles: [], roads: null,
    publicBuildings: null, homes: null, interiors: null, names: null, warnings: null,
  };
}

/** Non-road tiles with road directly on both N&S or both E&W sides. */
function sandwichedTiles(roads: Array<{ x: number; y: number }>, width: number, height: number): string[] {
  const set = new Set(roads.map((t) => t.y * width + t.x));
  const road = (x: number, y: number) => set.has(y * width + x);
  const out: string[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (road(x, y)) continue;
      if ((road(x, y - 1) && road(x, y + 1)) || (road(x - 1, y) && road(x + 1, y))) out.push(`${x},${y}`);
    }
  }
  return out;
}

/** 4-connected components of the road tile set. */
function roadComponents(roads: Array<{ x: number; y: number }>, width: number): number {
  const set = new Set(roads.map((t) => t.y * width + t.x));
  const seen = new Set<number>();
  let components = 0;
  for (const t of roads) {
    const start = t.y * width + t.x;
    if (seen.has(start)) continue;
    components++;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const c = stack.pop()!;
      for (const n of [c - 1, c + 1, c - width, c + width]) {
        if (set.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
  }
  return components;
}

/**
 * Everything `property.test.ts` asserts of a grid world, plus the organic-only
 * road invariants, as a list of human-readable violations (empty = pass).
 */
function worldViolations(r: GenResult, n: number): string[] {
  const v: string[] = [];
  const { width: gw, height: gh } = r.dimensions;
  if (gw < MIN_WIDTH || gw > MAX_WIDTH || gh < MIN_HEIGHT || gh > MAX_HEIGHT) v.push(`size ${gw}×${gh}`);
  const homes = r.locations.filter((l) => l.type === 'home').length;
  if (homes < Math.ceil(n / 2)) v.push(`${homes} homes`);

  // No overlap between any pair of locations — mainstreet included.
  for (let a = 0; a < r.locations.length; a++) {
    for (let b = a + 1; b < r.locations.length; b++) {
      const la = r.locations[a].position, lb = r.locations[b].position;
      if (la.x < lb.x + lb.width && la.x + la.width > lb.x && la.y < lb.y + lb.height && la.y + la.height > lb.y) {
        v.push(`${r.locations[a].name} overlaps ${r.locations[b].name}`);
      }
    }
  }

  const names = r.locations.map((l) => l.name);
  if (new Set(names).size !== names.length) v.push('duplicate location name');

  // Entry rules, as in property.test.ts.
  for (const b of r.locations) {
    const e = b.entry_point, p = b.position;
    if (b.type === 'mainstreet' || b.type === 'alley') {
      if (e.x < p.x || e.x >= p.x + p.width || e.y < p.y || e.y >= p.y + p.height) v.push(`${b.name} entry outside`);
    } else if (b.type === 'market_square' || b.type === 'farmyard') {
      if (Math.floor(e.x / TILE) !== p.x / TILE + Math.floor(p.width / TILE / 2) || e.y !== p.y + p.height) {
        v.push(`${b.name} door not south-centre`);
      }
    } else if (e.x !== p.x + p.width / 2 || e.y !== p.y + p.height) {
      v.push(`${b.name} door not south-centre`);
    }
  }

  // Every entry tile is walkable, belongs to no other location, and all of them
  // are mutually reachable over the collision grid (4-connected flood fill).
  const walkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < gw && y < gh && r.collisionGrid[y * gw + x] === '0';
  const entries = r.locations.map((l) => ({
    name: l.name, x: Math.floor(l.entry_point.x / TILE), y: Math.floor(l.entry_point.y / TILE),
  }));
  for (const e of entries) {
    if (!walkable(e.x, e.y)) v.push(`${e.name} entry blocked`);
    for (const o of r.locations) {
      if (o.name === e.name) continue;
      const t = tilesOf(o);
      if (e.x >= t.x && e.x < t.x + t.w && e.y >= t.y && e.y < t.y + t.h) v.push(`${e.name} door inside ${o.name}`);
    }
  }
  const seen = new Uint8Array(gw * gh);
  const queue = [entries[0].y * gw + entries[0].x];
  seen[queue[0]] = 1;
  for (let i = 0; i < queue.length; i++) {
    const cx = queue[i] % gw, cy = (queue[i] - cx) / gw;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!walkable(nx, ny) || seen[ny * gw + nx]) continue;
      seen[ny * gw + nx] = 1;
      queue.push(ny * gw + nx);
    }
  }
  for (const e of entries) if (!seen[e.y * gw + e.x]) v.push(`${e.name} unreachable`);

  // Roads: non-empty, no duplicate tiles, inside the BORDER_BUFFER frame, one
  // 4-connected network, no grass sandwiched between two roads.
  const roadKeys = new Set(r.roads.map((t) => t.y * gw + t.x));
  if (r.roads.length === 0) v.push('no roads');
  if (roadKeys.size !== r.roads.length) v.push('duplicate road tiles');
  for (const t of r.roads) {
    if (t.x < BORDER_BUFFER || t.x >= gw - BORDER_BUFFER || t.y < BORDER_BUFFER || t.y >= gh - BORDER_BUFFER) {
      v.push(`road ${t.x},${t.y} in border frame`);
    }
  }
  if (roadComponents(r.roads, gw) !== 1) v.push('road network split');
  for (const s of sandwichedTiles(r.roads, gw, gh)) v.push(`grass sliver at ${s}`);

  // Main street: one axis-aligned 2-row rect made entirely of road.
  const ms = r.locations.filter((l) => l.type === 'mainstreet');
  if (ms.length !== 1 || !ms[0].name.includes('Main')) {
    v.push(`${ms.length} main streets`);
  } else {
    const m = tilesOf(ms[0]);
    if (m.h !== 2) v.push(`mainstreet ${m.h} rows`);
    for (let y = m.y; y < m.y + m.h; y++) {
      for (let x = m.x; x < m.x + m.w; x++) if (!roadKeys.has(y * gw + x)) v.push(`mainstreet ${x},${y} not road`);
    }
  }

  // No building footprint on a road.
  for (const l of r.locations) {
    if (OUTDOOR.includes(l.type)) continue;
    const t = tilesOf(l);
    for (let y = t.y; y < t.y + t.h; y++) {
      for (let x = t.x; x < t.x + t.w; x++) if (roadKeys.has(y * gw + x)) v.push(`${l.name} on road`);
    }
  }
  return v;
}

describe('organic layout: whole-world invariants', () => {
  for (const n of [5, 13, 30]) {
    it(`holds every invariant over the ${SAMPLE_SIZES[n]}-world sample (agents=${n})`, () => {
      const bad = sample(n)
        .map((r) => ({ seed: r.seed, v: worldViolations(r, n) }))
        .filter((e) => e.v.length > 0);
      expect(bad).toEqual([]);
    });
  }

  it('is deterministic', () => {
    for (const n of [5, 13, 30]) {
      for (const r of sample(n).slice(0, 3)) {
        expect(JSON.stringify(generateWorld(organic(r.seed), n)), r.seed).toBe(JSON.stringify(r));
      }
    }
  });

  it('holds on the fixed and custom size tiers', () => {
    const tiers: Array<[string, Partial<WorldGenConfig>]> = [
      ['medium', { sizeTier: 'medium' }],
      ['large', { sizeTier: 'large' }],
      ['custom56', { sizeTier: 'custom', customDimensions: { width: 56, height: 43 } }],
      ['custom90', { sizeTier: 'custom', customDimensions: { width: 90, height: 70 } }],
    ];
    const bad: Array<{ seed: string; v: string[] }> = [];
    for (const [label, extra] of tiers) {
      for (let i = 0; i < 3; i++) {
        const seed = `organic-tier-${label}-${i}`;
        const v = worldViolations(generateWorld(organic(seed, extra), 13), 13);
        if (v.length) bad.push({ seed, v });
      }
    }
    expect(bad).toEqual([]);
  });

  it('does not grow the map where the grid does not (auto size)', () => {
    // Organic lanes cut the map arbitrarily; a town whose buildings no longer
    // fit makes the pipeline grow the map by 20%. The lot guard in
    // organicRoads.ts exists for exactly this — measured over 800 seeds: 0
    // expansions at 1 and 13 agents, 1 at 5. The grid never expands at these
    // counts. At a 0.1% base rate a miss in these 110 worlds is a regression
    // of the guard, not sampling noise.
    const grown: string[] = [];
    const ones = Array.from({ length: 20 }, (_, i) => generateWorld(organic(`organic-size-1-${i}`), 1));
    // The one-agent worlds get the full invariant check too, while they're here.
    const bad = ones.map((r) => ({ seed: r.seed, v: worldViolations(r, 1) })).filter((e) => e.v.length > 0);
    expect(bad).toEqual([]);
    for (const r of [...ones, ...sample(5), ...sample(13)]) {
      if (r.dimensions.width !== MIN_WIDTH || r.dimensions.height !== MIN_HEIGHT) grown.push(r.seed);
    }
    // 30 agents start from 62×48 (see dimensions.ts), not the minimum.
    for (const r of sample(30)) {
      if (r.dimensions.width !== 62 || r.dimensions.height !== 48) grown.push(r.seed);
    }
    expect(grown).toEqual([]);
  });
});

describe('organic layout: town quality', () => {
  it('every templated venue type generates', () => {
    const required = [
      'town_square', 'mainstreet', 'farm', 'park', 'town_hall', 'shop', 'tavern', 'home',
      'clinic', 'bakery', 'workshop', 'prison', 'pawnshop', 'divebar',
    ];
    const missing: string[] = [];
    for (const w of sample(13).slice(0, 12)) {
      const types = new Set(w.locations.map((l) => l.type));
      for (const t of required) if (!types.has(t)) missing.push(`${w.seed}: ${t}`);
    }
    expect(missing).toEqual([]);
  });

  it('public buildings front onto the lanes', () => {
    // Same measure as layout.test.ts's grid version. Measured over five
    // disjoint 60-seed windows:
    //   13 agents: near 0.483-0.528, far 0.150-0.167   (grid: ~0.53 / ~0.09)
    //   30 agents: near 0.572-0.583, far 0.122-0.142   (grid: ~0.54 / ~0.08)
    // Near matches the grid; far is higher because a lane network leaves more
    // of the map away from any road than a full-span grid does — the farm
    // alone is ~40% of the far doors. The samples here are 45 and 30 worlds,
    // smaller than the measuring windows, hence bars well below the worst one.
    const bars: Record<number, { near: number; far: number }> = {
      13: { near: 0.45, far: 0.21 },
      30: { near: 0.5, far: 0.21 },
    };
    for (const agents of [13, 30]) {
      let doors = 0, near = 0, far = 0;
      for (const w of sample(agents)) {
        const { width } = w.dimensions;
        const roads = new Set(w.roads.map((t) => t.y * width + t.x));
        for (const l of w.locations) {
          if (OUTDOOR.includes(l.type) || l.type === 'home') continue;
          const dx = Math.floor(l.entry_point.x / TILE), dy = Math.floor(l.entry_point.y / TILE);
          // Manhattan distance to the nearest road tile, capped at 7.
          let best = 7;
          for (let d = 0; d < best; d++) {
            let hit = false;
            for (let ox = -d; ox <= d && !hit; ox++) {
              const oy = d - Math.abs(ox);
              if (roads.has((dy + oy) * width + dx + ox) || roads.has((dy - oy) * width + dx + ox)) hit = true;
            }
            if (hit) { best = d; break; }
          }
          doors++;
          if (best <= 2) near++;
          if (best > 6) far++;
        }
      }
      expect(near / doors, `${agents} agents: doors within 2 tiles of a road`).toBeGreaterThan(bars[agents].near);
      expect(far / doors, `${agents} agents: doors more than 6 tiles from a road`).toBeLessThan(bars[agents].far);
    }
  });

  it('derived plots generate for most seeds', () => {
    // Measured over five 60-seed windows at 13 agents: market square 0.85-0.98,
    // farmyard 0.92-0.97, alley 0.50-0.77 (grid: ~1.0 / ~0.9 / ~0.95). The alley
    // is lower by design, not by accident: it needs two commercial buildings
    // aligned within ALLEY_MAX_SPAN, and the grid's straight blocks line them
    // up where organic zones do not. The sample is 45 worlds (the windows
    // were 60), so the alley bar sits two standard errors under its worst window.
    const ws = sample(13);
    const rate = (type: string) => ws.filter((w) => w.locations.some((l) => l.type === type)).length / ws.length;
    expect(rate('market_square'), 'market_square rate').toBeGreaterThan(0.75);
    expect(rate('farmyard'), 'farmyard rate').toBeGreaterThan(0.75);
    expect(rate('alley'), 'alley rate').toBeGreaterThan(0.35);
  });
});

describe('organic layout: shape', () => {
  it('differs from the grid for the same seed', () => {
    for (const o of sample(13).slice(0, 5)) {
      const g = generateWorld({ sizeTier: 'auto', overrides: {}, seed: o.seed }, 13);
      expect(JSON.stringify(o.roads)).not.toBe(JSON.stringify(g.roads));
    }
  });

  it('gives every seed a different road network', () => {
    const keys = new Set(sample(13).map((r) => r.roads.map((t) => `${t.x},${t.y}`).sort().join(';')));
    expect(keys.size).toBe(sample(13).length);
  });

  it('grows lanes, usually closes a loop, and leaves no grass slivers', () => {
    // A single main street would pass every invariant above; this pins that the
    // settlement seeds actually turn into lanes. Plus the sliver check at the
    // sizes the pipeline samples least (the shared sample is 56×43 and 62×48).
    let lanes = 0, loops = 0, runs = 0;
    const slivers: string[] = [];
    for (const [w, h] of [[56, 43], [73, 58], [90, 70]]) {
      for (let i = 0; i < 8; i++) {
        const r = generateOrganicRoads(w, h, forkRng(`organic-lanes-${w}-${i}`, 'roads'), [], (d) => {
          lanes += d.lanes.length;
          loops += d.loops.length;
          runs++;
        });
        for (const s of sandwichedTiles(r.tiles, w, h)) slivers.push(`${w}×${h} #${i}: ${s}`);
      }
    }
    expect(slivers).toEqual([]);
    expect(lanes / runs).toBeGreaterThan(5);
    expect(loops / runs).toBeGreaterThan(0.5);
  });

  it('emits zones the layout stage understands', () => {
    for (const [w, h] of [[56, 43], [73, 58], [90, 70]]) {
      const { zones, mainStreet } = generateOrganicRoads(w, h, forkRng(`organic-zones-${w}`, 'roads'));
      expect(mainStreet).toBeDefined();
      const ids = zones.map((z) => z.id);
      expect(new Set(ids).size).toBe(ids.length);
      const problems: string[] = [];
      for (const z of zones) {
        const b = z.bounds;
        if (b.x1 < BORDER_BUFFER || b.y1 < BORDER_BUFFER || b.x2 > w - 1 - BORDER_BUFFER || b.y2 > h - 1 - BORDER_BUFFER) {
          problems.push(`${z.id} outside the inner map`);
        }
        for (const key of ['residential', 'commercial', 'mainStreet', 'civic']) {
          if (!(z.affinity[key] >= 0 && z.affinity[key] <= 5)) problems.push(`${z.id}.${key} = ${z.affinity[key]}`);
        }
      }
      // Exactly one fallback zone, last — layout tries it last and homes'
      // `zones.find` must never reach it.
      expect(zones.filter((z) => z.fallback).map((z) => z.id)).toEqual([zones[zones.length - 1].id]);
      // The cells tile the inner map exactly once, which `zones.find` relies on.
      const cover = new Uint8Array(w * h);
      for (const z of zones.slice(0, -1)) {
        for (let y = z.bounds.y1; y <= z.bounds.y2; y++) {
          for (let x = z.bounds.x1; x <= z.bounds.x2; x++) cover[y * w + x]++;
        }
      }
      for (let y = BORDER_BUFFER; y <= h - 1 - BORDER_BUFFER; y++) {
        for (let x = BORDER_BUFFER; x <= w - 1 - BORDER_BUFFER; x++) {
          if (cover[y * w + x] !== 1) problems.push(`${w}×${h} tile ${x},${y} covered ${cover[y * w + x]}×`);
        }
      }
      expect(problems).toEqual([]);
    }
  });
});

describe('organic layout: layout stage at fixed sizes', () => {
  const CFG: WorldGenConfig = { seed: 'test', sizeTier: 'medium', overrides: {}, layoutStyle: 'organic' };

  const placedTypes = (seed: string, w: number, h: number, n: number) => {
    const ctx = ctxAt(w, h);
    ctx.roads = roadsStage.run(ctx, forkRng(seed, 'roads'), CFG, n, {}).roads;
    return new Set(layoutStage.run(ctx, forkRng(seed, 'layout'), CFG, n, {}).publicBuildings.map((b) => b.type));
  };

  it('places all core buildings on a 60×45 map with 5 agents', () => {
    const core = getTemplatesForAgentCount(5).filter((t) => t.category === 'core');
    for (let i = 0; i < 6; i++) {
      const types = placedTypes(`organic-core-${i}`, 60, 45, 5);
      expect(core.filter((t) => !types.has(t.type)).map((t) => t.type), `organic-core-${i}`).toEqual([]);
    }
  });

  it('places every template on an 80×60 map with 12 agents', () => {
    const all = getTemplatesForAgentCount(12);
    for (let i = 0; i < 3; i++) {
      const types = placedTypes(`organic-all-${i}`, 80, 60, 12);
      expect(all.filter((t) => !types.has(t.type)).map((t) => t.type), `organic-all-${i}`).toEqual([]);
    }
  });
});

describe('mainstreet derivation', () => {
  const CFG: WorldGenConfig = { seed: 'test', sizeTier: 'large', overrides: {} };

  function layoutWith(tiles: Array<{ x: number; y: number }>, mainStreet?: { x: number; y: number; width: number; height: number }) {
    const ctx = ctxAt(80, 60);
    ctx.roads = {
      tiles,
      zones: [{
        id: 'all', bounds: { x1: 2, y1: 2, x2: 77, y2: 57 },
        affinity: { residential: 1, commercial: 1, mainStreet: 1, civic: 1 },
      }],
      mainStreet,
    };
    const result = layoutStage.run(ctx, forkRng('ms', 'layout'), CFG, 5, {});
    return tilesOf(result.publicBuildings.find((l) => l.type === 'mainstreet')!);
  }

  const row = (y: number, x1: number, x2: number) =>
    Array.from({ length: x2 - x1 + 1 }, (_, i) => [{ x: x1 + i, y }, { x: x1 + i, y: y + 1 }]).flat();

  it('without a hint, spans only the longest contiguous run of the busiest row', () => {
    // Two unrelated stretches on the same rows. The old min..max span covered
    // the 12 tiles of open ground between them.
    const ms = layoutWith([...row(30, 5, 15), ...row(30, 28, 60)]);
    expect(ms).toEqual({ x: 28, y: 30, w: 33, h: 2 });
  });

  it('uses the road generator\'s main street when it gives one', () => {
    const ms = layoutWith([...row(30, 5, 15), ...row(30, 28, 60), ...row(40, 10, 70)],
      { x: 5, y: 30, width: 11, height: 2 });
    expect(ms).toEqual({ x: 5, y: 30, w: 11, h: 2 });
  });
});

describe('grid layout is unchanged by track C', () => {
  /**
   * sha256 (first 16 hex) of `JSON.stringify(generateWorld(...))`, recorded on
   * the base commit before `layoutStyle` existed (3144ead), i.e. with no
   * `layoutStyle` key at all. A default-grid world must stay byte-identical so
   * a restarted legacy world rebuilds the town its player knows. 640 worlds
   * (these plus 38 more seeds per cell) were compared when the option landed;
   * these 32 are the pinned sample.
   *
   * If a later change *intends* to alter grid worlds, recompute these — but
   * that is a deliberate break of every saved grid world's restart, and should
   * say so in its commit.
   */
  const GOLDEN: Record<string, string> = {
    'gold-1-auto-0': 'cfc558e7883080c0',
    'gold-1-auto-1': 'd33ef1ea0f43a080',
    'gold-1-medium-0': '06a36847d0271804',
    'gold-1-medium-1': 'af342b4f43ee1bc6',
    'gold-1-large-0': '360c4bfe260b7c52',
    'gold-1-large-1': '41eb68fa34a5a3fc',
    'gold-1-custom-0': 'bdca14c9d0d921de',
    'gold-1-custom-1': 'e7ad2f4fe22945bf',
    'gold-5-auto-0': '84b820fa48f5daa4',
    'gold-5-auto-1': '998618144fd7e2cb',
    'gold-5-medium-0': 'b073e67343d28558',
    'gold-5-medium-1': '6648684b3bc62f23',
    'gold-5-large-0': 'cd396e5edb888ccb',
    'gold-5-large-1': '4b907fef14fa3cc7',
    'gold-5-custom-0': 'e56db0f76f27e79d',
    'gold-5-custom-1': '5823046c72c182d1',
    'gold-13-auto-0': '83206dd7370c4388',
    'gold-13-auto-1': '471e528fd7211522',
    'gold-13-medium-0': '5a135e6e19d4e742',
    'gold-13-medium-1': '35eda06fba2cccad',
    'gold-13-large-0': '5d2d03b91f61a70d',
    'gold-13-large-1': '3bf81f1b236ad2ed',
    'gold-13-custom-0': '0761b49d6835a5b3',
    'gold-13-custom-1': 'b0ec32ece92d95b8',
    'gold-30-auto-0': '960e4f8b7263140b',
    'gold-30-auto-1': '725843a462b368d1',
    'gold-30-medium-0': 'dcefb7eff2ec6e00',
    'gold-30-medium-1': '70390c5be15243f1',
    'gold-30-large-0': '1fb1d3caeb7ee8fb',
    'gold-30-large-1': '73cfb65ef4918fb8',
    'gold-30-custom-0': 'b0027a4d87f0cc0c',
    'gold-30-custom-1': 'f2ebe7bdba89d733',
  };

  const cfgFor = (key: string): WorldGenConfig => {
    const [, , tier] = key.split('-');
    const cfg: WorldGenConfig = { sizeTier: tier as WorldGenConfig['sizeTier'], overrides: {}, seed: key };
    if (tier === 'custom') cfg.customDimensions = { width: 70, height: 52 };
    return cfg;
  };
  const hash = (r: GenResult) => createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16);

  it('matches the pre-track-C output with layoutStyle omitted', () => {
    const got = Object.fromEntries(Object.keys(GOLDEN).map((key) =>
      [key, hash(generateWorld(cfgFor(key), Number(key.split('-')[1])))]));
    expect(got).toEqual(GOLDEN);
  });

  it('matches it with layoutStyle: grid spelled out', () => {
    // One seed per (agents, tier) cell — the 640-world comparison covered both
    // spellings in full when the option landed.
    const keys = Object.keys(GOLDEN).filter((k) => k.endsWith('-0'));
    const got = Object.fromEntries(keys.map((key) =>
      [key, hash(generateWorld({ ...cfgFor(key), layoutStyle: 'grid' }, Number(key.split('-')[1])))]));
    expect(got).toEqual(Object.fromEntries(keys.map((k) => [k, GOLDEN[k]])));
  });

  it('matches it with agents and social edges passed', () => {
    // Also recorded on 3144ead. The seed is one where the edges actually
    // relabel the homes (its no-social hash is e169c09bf1aea996), so this pins
    // the homes stage's social path, not just the plot selection.
    const agents = [
      { name: 'Ada', homeName: 'Home 1', workplaceName: 'The Rusty Tankard' },
      { name: 'Ben', homeName: 'Home 2', workplaceName: null },
      { name: 'Cleo', homeName: 'Home 3', workplaceName: null },
      { name: 'Dev', homeName: 'Home 4', workplaceName: null },
      { name: 'Eli', homeName: 'Home 5', workplaceName: null },
      { name: 'Fay', homeName: 'Home 6', workplaceName: null },
    ];
    const edges: SocialEdge[] = [
      { a: 'Ada', b: 'Fay', kind: 'rival' },
      { a: 'Ben', b: 'Eli', kind: 'secret_lovers' },
      { a: 'Cleo', b: 'Dev', kind: 'friends' },
    ];
    const cfg: WorldGenConfig = { sizeTier: 'auto', overrides: {}, seed: 'gold-social-1' };
    expect(hash(generateWorld(cfg, 12, { agents: agents as never, social: { edges } }))).toBe('69898bd108d27b30');
    expect(hash(generateWorld(cfg, 12, { agents: agents as never }))).toBe('e169c09bf1aea996');
  });

  it('defaults a parsed config without the key to grid', () => {
    const parsed = WorldGenConfigSchema.parse({ sizeTier: 'auto', overrides: {} });
    expect(parsed.layoutStyle).toBe('grid');
  });
});

describe('organic output is pinned', () => {
  /**
   * Organic worlds are saved in setup_config and rebuilt from their seed on
   * restart, so an accidental change to lane growth, sliver paving or zone
   * cutting silently reshapes every saved organic town. Recorded on the merge
   * of track C. As with the grid goldens: recompute only for a deliberate
   * change, and say so in the commit.
   */
  const ORGANIC_GOLDEN: Record<string, string> = {
    'organic-1-auto': '7a18b9db99901421',
    'organic-1-large': '52ee52f95bc3d06c',
    'organic-1-custom': 'b98902477a9ff1c3',
    'organic-5-auto': 'ee4aac5f42dd9460',
    'organic-5-large': '7ba03f3dd016e5b4',
    'organic-5-custom': '5a58d73c7ee55e1d',
    'organic-13-auto': '40b1708d7d963978',
    'organic-13-large': '7b1a01552d5446af',
    'organic-13-custom': '4738f965d977093c',
    'organic-30-auto': 'e781815e2d424656',
    'organic-30-large': '21d086b729a3eaf1',
    'organic-30-custom': '2fb7ce0a35eca0df',
  };
  const hash = (r: GenResult) => createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16);

  it('matches the recorded organic worlds', () => {
    const got = Object.fromEntries(Object.keys(ORGANIC_GOLDEN).map((key) => {
      const [, n, tier] = key.split('-');
      const cfg: WorldGenConfig = {
        sizeTier: tier as WorldGenConfig['sizeTier'], overrides: {}, seed: key, layoutStyle: 'organic',
      };
      if (tier === 'custom') cfg.customDimensions = { width: 70, height: 52 };
      return [key, hash(generateWorld(cfg, Number(n)))];
    }));
    expect(got).toEqual(ORGANIC_GOLDEN);
  });
});
