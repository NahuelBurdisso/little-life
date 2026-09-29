import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
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

/**
 * Track C: `layoutStyle: 'organic'`. The grid's invariant suites (property,
 * layout, pipeline) re-run here against organic worlds, plus what is specific
 * to grown lanes — connectivity, the border frame, the main street hint — and
 * the guarantee that made the option safe to add: grid worlds are unchanged.
 */

const TILE = 32;
const OUTDOOR = ['mainstreet', 'alley', 'market_square', 'farmyard'];

const organic = (seed: string, extra: Partial<WorldGenConfig> = {}): WorldGenConfig =>
  ({ sizeTier: 'auto', overrides: {}, seed, layoutStyle: 'organic', ...extra });

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

/** 4-connected components of the road tile set. */
function roadComponents(roads: Array<{ x: number; y: number }>): number {
  const key = (x: number, y: number) => `${x},${y}`;
  const set = new Set(roads.map((t) => key(t.x, t.y)));
  const seen = new Set<string>();
  let components = 0;
  for (const t of roads) {
    if (seen.has(key(t.x, t.y))) continue;
    components++;
    const stack = [t];
    seen.add(key(t.x, t.y));
    while (stack.length) {
      const c = stack.pop()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = key(c.x + dx, c.y + dy);
        if (set.has(k) && !seen.has(k)) { seen.add(k); stack.push({ x: c.x + dx, y: c.y + dy }); }
      }
    }
  }
  return components;
}

/** Everything `property.test.ts` asserts of a grid world, plus the organic-only
 *  road invariants. */
function assertWorldInvariants(r: GenResult, n: number, label: string) {
  const { width: gw, height: gh } = r.dimensions;
  expect(gw).toBeGreaterThanOrEqual(MIN_WIDTH);
  expect(gw).toBeLessThanOrEqual(MAX_WIDTH);
  expect(gh).toBeGreaterThanOrEqual(MIN_HEIGHT);
  expect(gh).toBeLessThanOrEqual(MAX_HEIGHT);
  expect(r.locations.filter((l) => l.type === 'home').length).toBeGreaterThanOrEqual(Math.ceil(n / 2));

  // No overlap between any pair of locations — mainstreet included.
  for (let a = 0; a < r.locations.length; a++) {
    for (let b = a + 1; b < r.locations.length; b++) {
      const la = r.locations[a].position, lb = r.locations[b].position;
      const overlap = la.x < lb.x + lb.width && la.x + la.width > lb.x &&
                      la.y < lb.y + lb.height && la.y + la.height > lb.y;
      expect(overlap, `${label}: ${r.locations[a].name} overlaps ${r.locations[b].name}`).toBe(false);
    }
  }

  const names = r.locations.map((l) => l.name);
  expect(new Set(names).size, `${label}: duplicate location name`).toBe(names.length);

  // Entry rules, as in property.test.ts.
  for (const b of r.locations) {
    if (b.type === 'mainstreet' || b.type === 'alley') {
      expect(b.entry_point.x).toBeGreaterThanOrEqual(b.position.x);
      expect(b.entry_point.x).toBeLessThan(b.position.x + b.position.width);
      expect(b.entry_point.y).toBeGreaterThanOrEqual(b.position.y);
      expect(b.entry_point.y).toBeLessThan(b.position.y + b.position.height);
    } else if (b.type === 'market_square' || b.type === 'farmyard') {
      expect(Math.floor(b.entry_point.x / TILE))
        .toBe(b.position.x / TILE + Math.floor(b.position.width / TILE / 2));
      expect(b.entry_point.y).toBe(b.position.y + b.position.height);
    } else {
      expect(b.entry_point.x).toBe(b.position.x + b.position.width / 2);
      expect(b.entry_point.y).toBe(b.position.y + b.position.height);
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
    expect(walkable(e.x, e.y), `${label}: ${e.name} entry is blocked`).toBe(true);
    for (const o of r.locations) {
      if (o.name === e.name) continue;
      const t = tilesOf(o);
      const inside = e.x >= t.x && e.x < t.x + t.w && e.y >= t.y && e.y < t.y + t.h;
      expect(inside, `${label}: ${e.name} doorway sits inside ${o.name}`).toBe(false);
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
  for (const e of entries) {
    expect(seen[e.y * gw + e.x], `${label}: ${e.name} entry is unreachable`).toBe(1);
  }

  // Roads: non-empty, no duplicate tiles, inside the BORDER_BUFFER frame, one
  // 4-connected network.
  expect(r.roads.length).toBeGreaterThan(0);
  const roadKeys = new Set(r.roads.map((t) => `${t.x},${t.y}`));
  expect(roadKeys.size, `${label}: duplicate road tiles`).toBe(r.roads.length);
  for (const t of r.roads) {
    expect(t.x >= BORDER_BUFFER && t.x < gw - BORDER_BUFFER, `${label}: road x ${t.x}`).toBe(true);
    expect(t.y >= BORDER_BUFFER && t.y < gh - BORDER_BUFFER, `${label}: road y ${t.y}`).toBe(true);
  }
  expect(roadComponents(r.roads), `${label}: road network is split`).toBe(1);

  // Main street: an axis-aligned rect made entirely of road.
  const ms = r.locations.filter((l) => l.type === 'mainstreet');
  expect(ms).toHaveLength(1);
  expect(ms[0].name).toContain('Main');
  const m = tilesOf(ms[0]);
  expect(m.h).toBe(2);
  for (let y = m.y; y < m.y + m.h; y++) {
    for (let x = m.x; x < m.x + m.w; x++) {
      expect(roadKeys.has(`${x},${y}`), `${label}: mainstreet tile ${x},${y} is not road`).toBe(true);
    }
  }

  // No building footprint on a road.
  for (const l of r.locations) {
    if (OUTDOOR.includes(l.type)) continue;
    const t = tilesOf(l);
    for (let y = t.y; y < t.y + t.h; y++) {
      for (let x = t.x; x < t.x + t.w; x++) {
        expect(roadKeys.has(`${x},${y}`), `${label}: ${l.name} sits on road`).toBe(false);
      }
    }
  }
}

describe('organic layout: whole-world invariants', () => {
  // 3 × 40 = 120 worlds. Every one is also regenerated for determinism on a
  // quarter of them — generation is ~12-18 ms, and the suite is on the
  // `npm run check` path.
  for (const n of [5, 13, 30]) {
    it(`holds every invariant over 40 seeds (agents=${n})`, () => {
      for (let i = 0; i < 40; i++) {
        const seed = `organic-prop-${n}-${i}`;
        const r = generateWorld(organic(seed), n);
        assertWorldInvariants(r, n, seed);
        if (i % 4 === 0) {
          expect(JSON.stringify(generateWorld(organic(seed), n)), `${seed} not deterministic`)
            .toBe(JSON.stringify(r));
        }
      }
    });
  }

  it('holds on the fixed size tiers too', () => {
    for (const sizeTier of ['medium', 'large'] as const) {
      for (let i = 0; i < 6; i++) {
        const seed = `organic-tier-${sizeTier}-${i}`;
        assertWorldInvariants(generateWorld(organic(seed, { sizeTier }), 13), 13, seed);
      }
    }
  });

  it('does not grow the map where the grid does not (auto size)', () => {
    // Organic lanes cut the map arbitrarily; a town whose buildings no longer
    // fit makes the pipeline grow the map by 20%. The lot guard in
    // organicRoads.ts exists for exactly this — measured over 800 seeds: 0
    // expansions at 1 and 13 agents, 1 at 5. The grid never expands at these
    // counts. (These 90 seeds are all clean; a new miss here is a regression
    // of the guard, not sampling noise, at a 0.1% base rate.)
    for (const n of [1, 5, 13]) {
      for (let i = 0; i < 30; i++) {
        const r = generateWorld(organic(`organic-size-${n}-${i}`), n);
        expect(r.dimensions, `organic-size-${n}-${i}`).toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT });
      }
    }
  });
});

describe('organic layout: town quality', () => {
  // Memoised: three tests read the same 13-agent sample.
  const cache = new Map<number, GenResult[]>();
  const worlds = (agents: number, count = 60) => {
    if (!cache.has(agents)) {
      cache.set(agents, Array.from({ length: 60 }, (_, i) =>
        generateWorld(organic(`organic-frontage-${i}`), agents)));
    }
    return cache.get(agents)!.slice(0, count);
  };

  it('every templated venue type generates', () => {
    const required = [
      'town_square', 'mainstreet', 'farm', 'park', 'town_hall', 'shop', 'tavern', 'home',
      'clinic', 'bakery', 'workshop', 'prison', 'pawnshop', 'divebar',
    ];
    for (const w of worlds(13, 12)) {
      const types = new Set(w.locations.map((l) => l.type));
      for (const t of required) expect(types).toContain(t);
    }
  });

  it('public buildings front onto the lanes', () => {
    // Same measure and seeds-per-window as layout.test.ts's grid version.
    // Measured over five disjoint 60-seed windows (these seeds are the first):
    //   13 agents: near 0.483-0.528, far 0.150-0.167   (grid: ~0.53 / ~0.09)
    //   30 agents: near 0.572-0.583, far 0.122-0.142   (grid: ~0.54 / ~0.08)
    // Near matches the grid; far is higher because a lane network leaves more
    // of the map away from any road than a full-span grid does — the farm
    // alone is ~40% of the far doors. Bars sit below the worst window.
    for (const agents of [13, 30]) {
      let doors = 0, near = 0, far = 0;
      for (const w of worlds(agents)) {
        for (const l of w.locations) {
          if (OUTDOOR.includes(l.type) || l.type === 'home') continue;
          const dx = Math.floor(l.entry_point.x / TILE), dy = Math.floor(l.entry_point.y / TILE);
          let best = Infinity;
          for (const t of w.roads) best = Math.min(best, Math.abs(t.x - dx) + Math.abs(t.y - dy));
          doors++;
          if (best <= 2) near++;
          if (best > 6) far++;
        }
      }
      expect(near / doors, `${agents} agents: doors within 2 tiles of a road`).toBeGreaterThan(0.46);
      expect(far / doors, `${agents} agents: doors more than 6 tiles from a road`).toBeLessThan(0.2);
    }
  });

  it('derived plots generate for most seeds', () => {
    // Measured over five 60-seed windows at 13 agents: market square 0.85-0.98,
    // farmyard 0.92-0.97, alley 0.50-0.77 (grid: ~1.0 / ~0.9 / ~0.95). The alley
    // is lower by design, not by accident: it needs two commercial buildings
    // aligned within ALLEY_MAX_SPAN, and the grid's straight blocks line them
    // up where organic zones do not.
    const ws = worlds(13);
    const rate = (type: string) => ws.filter((w) => w.locations.some((l) => l.type === type)).length / ws.length;
    expect(rate('market_square'), 'market_square rate').toBeGreaterThan(0.75);
    expect(rate('farmyard'), 'farmyard rate').toBeGreaterThan(0.75);
    expect(rate('alley'), 'alley rate').toBeGreaterThan(0.4);
  });
});

describe('organic layout: shape', () => {
  it('differs from the grid for the same seed', () => {
    for (let i = 0; i < 5; i++) {
      const seed = `organic-vs-grid-${i}`;
      const g = generateWorld({ sizeTier: 'auto', overrides: {}, seed }, 13);
      const o = generateWorld(organic(seed), 13);
      expect(JSON.stringify(o.roads)).not.toBe(JSON.stringify(g.roads));
    }
  });

  it('gives every seed a different road network', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const r = generateWorld(organic(`organic-shape-${i}`), 13);
      keys.add(r.roads.map((t) => `${t.x},${t.y}`).sort().join(';'));
    }
    expect(keys.size).toBe(30);
  });

  it('grows lanes and usually closes a loop', () => {
    // A single main street would pass every invariant above; this pins that the
    // settlement seeds actually turn into lanes.
    let lanes = 0, loops = 0;
    for (let i = 0; i < 20; i++) {
      generateOrganicRoads(56, 43, forkRng(`organic-lanes-${i}`, 'roads'), [], (d) => {
        lanes += d.lanes.length;
        loops += d.loops.length;
        expect(d.seeds.length).toBeGreaterThanOrEqual(4);
      });
    }
    expect(lanes / 20).toBeGreaterThan(5);
    expect(loops / 20).toBeGreaterThan(0.5);
  });

  it('emits zones the layout stage understands', () => {
    const { zones, mainStreet } = generateOrganicRoads(56, 43, forkRng('organic-zones', 'roads'));
    expect(mainStreet).toBeDefined();
    const ids = zones.map((z) => z.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const z of zones) {
      expect(z.bounds.x1).toBeGreaterThanOrEqual(BORDER_BUFFER);
      expect(z.bounds.y1).toBeGreaterThanOrEqual(BORDER_BUFFER);
      expect(z.bounds.x2).toBeLessThanOrEqual(56 - 1 - BORDER_BUFFER);
      expect(z.bounds.y2).toBeLessThanOrEqual(43 - 1 - BORDER_BUFFER);
      for (const key of ['residential', 'commercial', 'mainStreet', 'civic']) {
        expect(z.affinity[key], `${z.id}.${key}`).toBeGreaterThanOrEqual(0);
        expect(z.affinity[key], `${z.id}.${key}`).toBeLessThanOrEqual(5);
      }
    }
    // The cells (all but the last-resort zone) tile the inner map exactly once,
    // which `homes.ts`'s `zones.find` relies on.
    const cells = zones.slice(0, -1);
    for (let y = BORDER_BUFFER; y <= 43 - 1 - BORDER_BUFFER; y++) {
      for (let x = BORDER_BUFFER; x <= 56 - 1 - BORDER_BUFFER; x++) {
        const hits = cells.filter((z) =>
          x >= z.bounds.x1 && x <= z.bounds.x2 && y >= z.bounds.y1 && y <= z.bounds.y2).length;
        expect(hits, `tile ${x},${y}`).toBe(1);
      }
    }
  });
});

describe('organic layout: layout stage at fixed sizes', () => {
  const CFG: WorldGenConfig = { seed: 'test', sizeTier: 'medium', overrides: {}, layoutStyle: 'organic' };

  it('places all core buildings on a 60×45 map with 5 agents', () => {
    const core = getTemplatesForAgentCount(5).filter((t) => t.category === 'core');
    for (let i = 0; i < 10; i++) {
      const seed = `organic-core-${i}`;
      const ctx = ctxAt(60, 45);
      ctx.roads = roadsStage.run(ctx, forkRng(seed, 'roads'), CFG, 5, {}).roads;
      const result = layoutStage.run(ctx, forkRng(seed, 'layout'), CFG, 5, {});
      for (const t of core) {
        expect(result.publicBuildings.find((b) => b.type === t.type), `${seed}: ${t.type}`).toBeDefined();
      }
    }
  });

  it('places every template on an 80×60 map with 12 agents', () => {
    const all = getTemplatesForAgentCount(12);
    for (let i = 0; i < 5; i++) {
      const seed = `organic-all-${i}`;
      const ctx = ctxAt(80, 60);
      ctx.roads = roadsStage.run(ctx, forkRng(seed, 'roads'), CFG, 12, {}).roads;
      const result = layoutStage.run(ctx, forkRng(seed, 'layout'), CFG, 12, {});
      for (const t of all) {
        expect(result.publicBuildings.find((b) => b.type === t.type), `${seed}: ${t.type}`).toBeDefined();
      }
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
    for (const [key, want] of Object.entries(GOLDEN)) {
      const n = Number(key.split('-')[1]);
      expect(hash(generateWorld(cfgFor(key), n)), key).toBe(want);
    }
  });

  it('matches it with layoutStyle: grid spelled out', () => {
    for (const [key, want] of Object.entries(GOLDEN)) {
      const n = Number(key.split('-')[1]);
      expect(hash(generateWorld({ ...cfgFor(key), layoutStyle: 'grid' }, n)), key).toBe(want);
    }
  });

  it('defaults a parsed config without the key to grid', () => {
    const parsed = WorldGenConfigSchema.parse({ sizeTier: 'auto', overrides: {} });
    expect(parsed.layoutStyle).toBe('grid');
  });
});
