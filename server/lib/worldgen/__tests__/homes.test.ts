import { describe, it, expect } from 'vitest';
import { homesStage } from '../stages/homes';
import { roadsStage, buildRoadDistance } from '../stages/roads';
import { forkRng } from '../rng';
import { BORDER_BUFFER } from '../config';
import { FitError } from '../types';
import type { WorldContext } from '../types';
import type { LocationSeed } from '../types';

const CFG = { seed: 'test', sizeTier: 'medium' as const, overrides: {} };

/**
 * Fixture ctx with roads built by the real `roadsStage`.
 *
 * This used to pass `roads: null`, which `homes` accepted via
 * `ctx.roads?.tiles ?? []`. Every default-fixture test therefore exercised a
 * road-free, zone-free world, and the residential-affinity and road-frontage
 * weighting the stage is built around had no covering assertion at all — only
 * the one road-aware test below, which checks avoidance rather than preference.
 * `homes` now throws on a missing `roads`, so the fixture has to be real.
 */
function ctxWith(width: number, height: number, publicBuildings: LocationSeed[] = []): WorldContext {
  const ctx: WorldContext = {
    dimensions: { width, height },
    terrainTiles: [],
    roads: null,
    publicBuildings,
    homes: null, interiors: null, names: null, warnings: null,
  };
  ctx.roads = roadsStage.run(ctx, forkRng('test', 'roads'), CFG, 10, {}).roads!;
  return ctx;
}

describe('homes stage', () => {
  it('is deterministic: same seed + ctx → same positions', () => {
    const ctx = ctxWith(60, 45);
    const rngA = forkRng('test', 'homes');
    const rngB = forkRng('test', 'homes');
    const a = homesStage.run(ctx, rngA, CFG, 10, {}).homes!;
    const b = homesStage.run(ctx, rngB, CFG, 10, {}).homes!;
    expect(a.map((h) => h.position)).toEqual(b.map((h) => h.position));
  });

  it('home count matches ceil(agents/2) with no floor', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    expect(homesStage.run(ctx, rng, CFG, 2, {}).homes!).toHaveLength(1);
  });

  it('home count grows to fit highest Home N agent reference', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const extras = { agents: [
      { homeName: 'Home 1' }, { homeName: 'Home 2' }, { homeName: 'Home 7' }
    ] };
    const homes = homesStage.run(ctx, rng, CFG, 2, extras).homes!;
    expect(homes).toHaveLength(7); // max(halfAgents=1, maxReferenced=7)
  });

  it('homes do not overlap public buildings', () => {
    // Put a dummy 3-tile wide public building at (100, 100) and verify no home overlaps.
    const pub: LocationSeed = {
      name: 'Block', type: 'shop',
      position: { x: 160, y: 160, width: 96, height: 96 },
      entry_point: { x: 208, y: 256 },
      capacity: 0, current_occupants: [], operating_hours: null,
      services: [], description: '', owner: null,
    };
    const ctx = ctxWith(60, 45, [pub]);
    const rng = forkRng('test', 'homes');
    const homes = homesStage.run(ctx, rng, CFG, 20, {}).homes!;
    for (const h of homes) {
      const hR = h.position.x + h.position.width;
      const hB = h.position.y + h.position.height;
      const pR = pub.position.x + pub.position.width;
      const pB = pub.position.y + pub.position.height;
      const overlaps = h.position.x < pR && hR > pub.position.x &&
                       h.position.y < pB && hB > pub.position.y;
      expect(overlaps).toBe(false);
    }
  });

  it('homes do not overlap each other', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const homes = homesStage.run(ctx, rng, CFG, 20, {}).homes!;
    for (let i = 0; i < homes.length; i++) {
      for (let j = i + 1; j < homes.length; j++) {
        const a = homes[i].position, b = homes[j].position;
        const aR = a.x + a.width, aB = a.y + a.height;
        const bR = b.x + b.width, bB = b.y + b.height;
        const overlaps = a.x < bR && aR > b.x && a.y < bB && aB > b.y;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('throws FitError when the map cannot fit the requested count', () => {
    // Minimum 48×37 map with giant public buildings consuming most of it.
    // Together with the 1-tile border and 2-tile buffer + spacing rule, this
    // leaves too few candidates for the requested homeCount=40.
    const bigBlockers: LocationSeed[] = [
      {
        name: 'Blocker1', type: 'town_square',
        position: { x: 32, y: 32, width: 32 * 20, height: 32 * 15 },
        entry_point: { x: 32, y: 32 },
        capacity: 0, current_occupants: [], operating_hours: null,
        services: [], description: '', owner: null,
      },
      {
        name: 'Blocker2', type: 'farm',
        position: { x: 32 * 25, y: 32, width: 32 * 20, height: 32 * 30 },
        entry_point: { x: 32 * 25, y: 32 },
        capacity: 0, current_occupants: [], operating_hours: null,
        services: [], description: '', owner: null,
      },
    ];
    const ctx = ctxWith(48, 37, bigBlockers);
    const rng = forkRng('test', 'homes');
    expect(() => homesStage.run(ctx, rng, CFG, 80, {}).homes).toThrowError(FitError);
  });

  it('emits LocationSeed with correct shape', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const home = homesStage.run(ctx, rng, CFG, 4, {}).homes![0];
    expect(home.type).toBe('home');
    expect(home.name).toMatch(/^Home \d+$/);
    expect(home.position.width).toBe(96);
    expect(home.position.height).toBe(96);
    expect(home.capacity).toBe(2);
    expect(home.current_occupants).toEqual([]);
    expect(home.operating_hours).toBeNull();
    expect(home.owner).toBeNull();
    expect(home.services.length).toBeGreaterThan(0);
    // entry_point is south-center of footprint
    expect(home.entry_point.x).toBe(home.position.x + 48);
    expect(home.entry_point.y).toBe(home.position.y + home.position.height);
  });

  it('override path: pinned positions returned verbatim when valid', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    // Tiles (2,2) and (2,7) — tile (1,1) is inside the 2-tile border reserve,
    // and the two must be HOME_TILES + HOME_SPACING = 5 tiles apart, the same
    // Chebyshev rule the greedy unpinned selector enforces. The old fixture used
    // (2,6), 4 apart, which only passed because pins were never checked against
    // each other.
    const pinned = [{ x: 64, y: 64 }, { x: 64, y: 224 }];
    const cfg = { ...CFG, overrides: { homePositions: pinned } };
    const homes = homesStage.run(ctx, rng, cfg, 4, {}).homes!;
    expect(homes).toHaveLength(2);
    expect(homes[0].position.x).toBe(pinned[0].x);
    expect(homes[0].position.y).toBe(pinned[0].y);
  });

  it('override path: mismatched count throws a non-retryable error', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const cfg = { ...CFG, overrides: { homePositions: [{ x: 32, y: 32 }] } };
    // Deliberately NOT a FitError: the pipeline retries those on a bigger map, so
    // this config mistake was retried three times and surfaced as
    // 'dimensions cap reached' with the real message thrown away.
    expect(() => homesStage.run(ctx, rng, cfg, 10, {}).homes)
      .toThrowError(/override length 1 does not match homeCount 5/);
    expect(() => homesStage.run(ctx, rng, cfg, 10, {}).homes).not.toThrowError(FitError);
  });

  it('override path: overlapping pins are rejected', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const cfg = { ...CFG, overrides: { homePositions: [{ x: 64, y: 64 }, { x: 64, y: 64 }] } };
    expect(() => homesStage.run(ctx, rng, cfg, 4, {}).homes)
      .toThrowError(/pinned position at \(64, 64\) does not fit/);
  });

  it('home footprint keeps BORDER_BUFFER tiles clear of the map edge', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const homes = homesStage.run(ctx, rng, CFG, 20, {}).homes!;
    for (const h of homes) {
      const tx = h.position.x / 32;
      const ty = h.position.y / 32;
      expect(tx).toBeGreaterThanOrEqual(BORDER_BUFFER);
      expect(ty).toBeGreaterThanOrEqual(BORDER_BUFFER);
      expect(tx + 3).toBeLessThanOrEqual(60 - BORDER_BUFFER);
      expect(ty + 3).toBeLessThanOrEqual(45 - BORDER_BUFFER);
    }
  });

  it('homes do not overlap road tiles', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const homes = homesStage.run(ctx, rng, CFG, 10, {}).homes!;
    const roadSet = new Set(ctx.roads!.tiles.map((t) => `${t.x},${t.y}`));
    for (const h of homes) {
      const tx = h.position.x / 32;
      const ty = h.position.y / 32;
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          expect(roadSet.has(`${tx + dx},${ty + dy}`)).toBe(false);
        }
      }
    }
  });

  it('throws rather than silently degrading when the roads dependency is missing', () => {
    // `dependsOn` lists 'roads', but the stage read it through `?? []` and would
    // happily build a road-free, uniformly-weighted world instead. The other two
    // dependencies have always thrown; this one now does too.
    const ctx = ctxWith(60, 45);
    ctx.roads = null;
    expect(() => homesStage.run(ctx, forkRng('test', 'homes'), CFG, 10, {}))
      .toThrowError(/roads not populated/);
  });

  // ── Candidate weighting ───────────────────────────────────────────────────
  // Both terms of the weight in `homes.ts` are rates, so they need a sample:
  // the project rule is >=60 seeds for any rate assertion, and these are
  // aggregated over 60 forked RNGs against one fixed 60×45 road layout.
  //
  // Baselines are the same statistics taken uniformly over the *whole* legal
  // candidate pool (border, roads and road buffer already excluded), i.e. what
  // the flat lottery this weighting replaced would produce:
  //   mean residential affinity  2.667
  //   front doors >6 tiles from a road  25.2%
  // Measured for the weighted selector across nine disjoint 60-seed families:
  //   mean residential affinity  3.107 - 3.310
  //   front doors >6 tiles out   7.5% - 11.2%
  // The `weighting-*` family the assertions below actually sample sits at 3.170
  // and 9.67%, i.e. below the middle of both spreads. The stated range used to
  // be 3.22-3.29 / 8.5-9.3%, which excluded the very family being measured and
  // made the affinity bar look further from the data than it is: the worst
  // family clears `> 3.0` by 0.107, and `< 0.15` by 0.038.

  const weightingSample = () => {
    const ctx = ctxWith(60, 45);
    const zones = ctx.roads!.zones;
    const roadDist = buildRoadDistance(60, 45, ctx.roads!.tiles);
    const residentialAt = (tx: number, ty: number) =>
      zones.find((z) => tx >= z.bounds.x1 && tx <= z.bounds.x2 && ty >= z.bounds.y1 && ty <= z.bounds.y2)
        ?.affinity.residential ?? 0;

    let n = 0, farDoors = 0, residentialSum = 0;
    for (let i = 0; i < 60; i++) {
      const homes = homesStage.run(ctxWith(60, 45), forkRng(`weighting-${i}`, 'homes'), CFG, 20, {}).homes!;
      for (const h of homes) {
        const tx = h.position.x / 32, ty = h.position.y / 32;
        n++;
        // Door tile is south-centre and sits outside the footprint.
        if (roadDist[(ty + 3) * 60 + (tx + 1)] > 6) farDoors++;
        // Centre tile, so a home straddling a zone edge is attributed to the
        // zone it mostly sits in — same rule the stage itself uses.
        residentialSum += residentialAt(tx + 1, ty + 1);
      }
    }
    return { n, farShare: farDoors / n, meanResidential: residentialSum / n };
  };

  it('prefers residentially-zoned lots over the flat free-space lottery', () => {
    const { meanResidential } = weightingSample();
    expect(meanResidential, 'mean residential affinity of chosen lots')
      .toBeGreaterThan(3.0); // uniform baseline is 2.667
  });

  it('puts front doors on the street rather than mid-block', () => {
    const { farShare } = weightingSample();
    expect(farShare, 'share of front doors more than 6 tiles from a road')
      .toBeLessThan(0.15); // uniform baseline is 0.252
  });
});

/**
 * Social placement at stage level. The pipeline-level behaviour (distances over
 * many seeds, byte-identity without edges) lives in `social.test.ts`; this pins
 * the stage contract: the same plots come out, only which label sits on which
 * plot changes, and the rng stream is untouched.
 */
describe('homes stage — social placement', () => {
  const agents = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ name: `A${n}`, homeName: `Home ${n}` }));
  const edges = [
    { a: 'A1', b: 'A8', kind: 'rival' as const },
    { a: 'A2', b: 'A3', kind: 'secret_lovers' as const },
  ];
  const door = (h: LocationSeed) => ({ x: h.entry_point.x / 32, y: h.entry_point.y / 32 });
  const d = (a: LocationSeed, b: LocationSeed) =>
    Math.abs(door(a).x - door(b).x) + Math.abs(door(a).y - door(b).y);

  it("keeps the plot set and each plot's description, and pulls the rivals together", () => {
    let closer = 0;
    for (let i = 0; i < 10; i++) {
      const ctx = ctxWith(60, 45);
      const base = homesStage.run(ctx, forkRng(`social-${i}`, 'homes'), CFG, 16, { agents }).homes!;
      const soc = homesStage.run(ctx, forkRng(`social-${i}`, 'homes'), CFG, 16, {
        agents, social: { edges },
      }).homes!;
      expect(soc.map((h) => h.name)).toEqual(base.map((h) => h.name));
      const plot = (h: LocationSeed) => `${h.position.x},${h.position.y}|${h.description}`;
      expect(new Set(soc.map(plot))).toEqual(new Set(base.map(plot)));
      if (d(soc[0], soc[7]) <= d(base[0], base[7])) closer++;
    }
    expect(closer).toBe(10);
  });
});
