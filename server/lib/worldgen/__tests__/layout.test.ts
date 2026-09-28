import { describe, it, expect } from 'vitest';
import { layoutStage } from '../stages/layout';
import { roadsStage } from '../stages/roads';
import { forkRng } from '../rng';
import type { WorldContext } from '../types';
import { getTemplatesForAgentCount } from '../buildingTemplates';
import { generateWorld } from '../pipeline';
import { BORDER_BUFFER } from '../config';

const TILE = 32;

function ctxWithRoads(width: number, height: number): WorldContext {
  const ctx: WorldContext = {
    dimensions: { width, height },
    terrainTiles: [],
    roads: null,
    publicBuildings: null,
    homes: null,
    interiors: null,
    names: null,
    warnings: null,
  };
  const rng = forkRng('test', 'roads');
  const result = roadsStage.run(ctx, rng, CFG, 10, {});
  ctx.roads = result.roads;
  return ctx;
}

const CFG = { seed: 'test', sizeTier: 'medium' as const, overrides: {} };

const OUTDOOR_TYPES = ['market_square', 'mainstreet', 'alley', 'farmyard'];

function isBuilding(loc: { type: string }) {
  return !OUTDOOR_TYPES.includes(loc.type);
}

describe('layout stage', () => {
  it('places all 7 core buildings on a 60x45 map (agentCount=5)', () => {
    const ctx = ctxWithRoads(60, 45);
    const rng = forkRng('test', 'layout');
    const result = layoutStage.run(ctx, rng, CFG, 5, {});
    const buildings = result.publicBuildings!.filter(isBuilding);
    const coreTemplates = getTemplatesForAgentCount(5).filter(
      (t) => t.category === 'core',
    );
    expect(buildings.length).toBeGreaterThanOrEqual(coreTemplates.length);
    for (const ct of coreTemplates) {
      expect(buildings.find((b) => b.type === ct.type)).toBeDefined();
    }
  });

  it('includes optional buildings when agent threshold met (agentCount=12, 80x60)', () => {
    const ctx = ctxWithRoads(80, 60);
    const rng = forkRng('test', 'layout');
    const result = layoutStage.run(ctx, rng, CFG, 12, {});
    const buildings = result.publicBuildings!.filter(isBuilding);
    const allTemplates = getTemplatesForAgentCount(12);
    expect(buildings.length).toBeGreaterThanOrEqual(allTemplates.length);
    for (const t of allTemplates) {
      expect(buildings.find((b) => b.type === t.type)).toBeDefined();
    }
  });

  it('no buildings overlap each other', () => {
    const ctx = ctxWithRoads(80, 60);
    const rng = forkRng('test', 'layout');
    const result = layoutStage.run(ctx, rng, CFG, 12, {});
    const buildings = result.publicBuildings!.filter(isBuilding);
    for (let i = 0; i < buildings.length; i++) {
      for (let j = i + 1; j < buildings.length; j++) {
        const a = buildings[i].position;
        const b = buildings[j].position;
        const overlap =
          a.x < b.x + b.width &&
          a.x + a.width > b.x &&
          a.y < b.y + b.height &&
          a.y + a.height > b.y;
        expect(overlap).toBe(false);
      }
    }
  });

  it('buildings have 2+ tile spacing (Chebyshev distance)', () => {
    const ctx = ctxWithRoads(80, 60);
    const rng = forkRng('test', 'layout');
    const result = layoutStage.run(ctx, rng, CFG, 12, {});
    const buildings = result.publicBuildings!.filter(isBuilding);
    for (let i = 0; i < buildings.length; i++) {
      for (let j = i + 1; j < buildings.length; j++) {
        const a = buildings[i].position;
        const b = buildings[j].position;
        // Convert to tiles for gap calculation
        const aTileR = (a.x + a.width) / TILE;
        const aTileB = (a.y + a.height) / TILE;
        const aTileX = a.x / TILE;
        const aTileY = a.y / TILE;
        const bTileR = (b.x + b.width) / TILE;
        const bTileB = (b.y + b.height) / TILE;
        const bTileX = b.x / TILE;
        const bTileY = b.y / TILE;
        // Gap in each axis
        const gapX = Math.max(0, Math.max(bTileX - aTileR, aTileX - bTileR));
        const gapY = Math.max(0, Math.max(bTileY - aTileB, aTileY - bTileB));
        const chebyshev = Math.max(gapX, gapY);
        expect(chebyshev).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('buildings do not overlap road tiles', () => {
    const ctx = ctxWithRoads(80, 60);
    const rng = forkRng('test', 'layout');
    const result = layoutStage.run(ctx, rng, CFG, 12, {});
    const roadSet = new Set(ctx.roads!.tiles.map((t) => `${t.x},${t.y}`));
    const buildings = result.publicBuildings!.filter(isBuilding);
    for (const b of buildings) {
      const tx = b.position.x / TILE;
      const ty = b.position.y / TILE;
      const tw = b.position.width / TILE;
      const th = b.position.height / TILE;
      for (let y = ty; y < ty + th; y++) {
        for (let x = tx; x < tx + tw; x++) {
          expect(roadSet.has(`${x},${y}`)).toBe(false);
        }
      }
    }
  });

  it('door/entry point at south face, centered', () => {
    const ctx = ctxWithRoads(80, 60);
    const rng = forkRng('test', 'layout');
    const result = layoutStage.run(ctx, rng, CFG, 12, {});
    const buildings = result.publicBuildings!.filter(isBuilding);
    for (const b of buildings) {
      expect(b.entry_point.x).toBe(b.position.x + b.position.width / 2);
      expect(b.entry_point.y).toBe(b.position.y + b.position.height);
    }
  });

  it('deterministic: same seed produces same output', () => {
    const ctxA = ctxWithRoads(60, 45);
    const ctxB = ctxWithRoads(60, 45);
    const rngA = forkRng('test', 'layout');
    const rngB = forkRng('test', 'layout');
    const a = layoutStage.run(ctxA, rngA, CFG, 10, {});
    const b = layoutStage.run(ctxB, rngB, CFG, 10, {});
    expect(a.publicBuildings!.map((l) => l.position)).toEqual(
      b.publicBuildings!.map((l) => l.position),
    );
  });

  it('always generates mainstreet outdoor location', () => {
    const ctx = ctxWithRoads(60, 45);
    const rng = forkRng('test', 'layout');
    const result = layoutStage.run(ctx, rng, CFG, 5, {});
    const mainstreet = result.publicBuildings!.find(
      (l) => l.type === 'mainstreet',
    );
    expect(mainstreet).toBeDefined();
    expect(mainstreet!.name).toContain('Main');
  });

  // ── Whole-world invariants ────────────────────────────────────────────────
  // These deliberately cover the outdoor locations that `isBuilding` filters
  // out. Every assertion below failed before the layout remediation: homes sat
  // one tile from the edge, `market_square`/`farmyard` never generated at all,
  // the alley's entry point was inside a neighbouring wall, and every seed
  // produced an identical town.

  const SEEDS = Array.from({ length: 12 }, (_, i) => `seed-${i}`);
  const worldsFor = (agents: number) =>
    SEEDS.map((seed) =>
      generateWorld({ sizeTier: 'auto', overrides: {}, seed } as never, agents, {} as never),
    );

  it('every templated venue type generates for every seed', () => {
    // Core templates throw FitError when they cannot be placed, so asserting on
    // them alone would pass trivially. The optional templates are the real test:
    // they are placed on a best-effort basis after the core ones have taken the
    // good slots, and a layout regression shows up here first.
    const required = [
      'town_square', 'mainstreet', 'farm', 'park', 'town_hall', 'shop', 'tavern', 'home',
      'clinic', 'bakery', 'workshop', 'prison', 'pawnshop', 'divebar',
    ];
    for (const world of worldsFor(13)) {
      const types = new Set(world.locations.map((l) => l.type));
      for (const t of required) expect(types).toContain(t);
    }
  });

  it('derived plots generate for the large majority of seeds', () => {
    // `market_square` and `farmyard` are derived from a neighbour rather than
    // placed from a template, so they can legitimately miss when the anchor is
    // boxed in. They used to be structurally impossible — both offset candidates
    // sat inside the anchor's own reserved gap — and generated in 0% of seeds.
    //
    // Sampled separately from `worldsFor`, which is 12 seeds. At a true rate of
    // 90% a 12-seed sample sits below the 0.8 bar roughly a quarter of the time,
    // and this test duly went red on an unrelated scoring change that measured at
    // 90%/100% (13/30 agents) over 200 seeds. 60 seeds puts that false-failure
    // rate under 2%.
    const worlds = Array.from({ length: 60 }, (_, i) =>
      generateWorld({ sizeTier: 'auto', overrides: {}, seed: `derived-${i}` } as never, 13, {} as never),
    );
    for (const type of ['market_square', 'farmyard']) {
      const hits = worlds.filter((w) => w.locations.some((l) => l.type === type)).length;
      expect(hits / worlds.length, `${type} generation rate`).toBeGreaterThan(0.8);
    }
  });

  it('alleys generate for most seeds, and every one is genuine', () => {
    // The rate is lower than the other derived plots on purpose. An alley needs two
    // commercial buildings aligned on one axis and no more than ALLEY_MAX_SPAN
    // apart; nothing in the layout stage pulls commercial buildings together, so
    // whether such a pair exists is luck. The bar used to be 0.8, but only because
    // any separation was accepted and the rect clamped to 3 tiles — 24% of alleys
    // were not actually flanked by two commercial buildings, worst case 16 tiles
    // apart. In every alley-less world the nearest aligned commercial pair is
    // further than the span limit (0 rejected for any other reason).
    //
    // The rate is nonetheless high, and the bar used to say otherwise: it claimed
    // "67% of worlds get an alley" and sat at 0.5, which would have let a
    // regression halving alley generation pass silently. Re-measured over 2400
    // worlds at 13 agents (the count this test uses): 0.950. At 20 agents 0.965
    // (n=600), at 30 agents 0.905 (n=600). The 12 seeds below currently all hit.
    //
    // The bar is 0.7 rather than the 0.8 the true rate would suggest, because 12
    // seeds is a small sample: across 200 disjoint 12-seed blocks at 13 agents the
    // worst block was 9/12 and ~5% of blocks landed at 10/12 or below, so a 0.8
    // bar (>=10/12) would false-fail on any RNG reshuffle a few percent of the
    // time. 0.7 means >=9/12, which no measured block missed, and still fails
    // decisively if the true rate halves. Raising it further means clustering
    // commercial buildings in `layout.ts`, not loosening the checks below.
    const COMMERCIAL = ['shop', 'tavern', 'bakery', 'pawnshop', 'divebar'];
    const worlds = worldsFor(13);
    const hits = worlds.filter((w) => w.locations.some((l) => l.type === 'alley'));
    expect(hits.length / worlds.length, 'alley generation rate').toBeGreaterThan(0.7);

    for (const world of hits) {
      const a = world.locations.find((l) => l.type === 'alley')!;
      const ax = a.position.x / TILE, ay = a.position.y / TILE;
      const aw = a.position.width / TILE, ah = a.position.height / TILE;
      const others = world.locations.filter((l) => l !== a);

      // Flanked by two commercial buildings. The tolerance is 1 tile because when
      // the upper building's doorway occupies the first row of a stacked gap the
      // alley yields that row and starts one tile lower.
      const flanking = others.filter((l) => {
        if (!COMMERCIAL.includes(l.type)) return false;
        const bx = l.position.x / TILE, by = l.position.y / TILE;
        const bw = l.position.width / TILE, bh = l.position.height / TILE;
        const vertical = (Math.abs(by + bh - ay) <= 1 || Math.abs(ay + ah - by) <= 1)
          && bx < ax + aw && ax < bx + bw;
        const horizontal = (Math.abs(bx + bw - ax) <= 1 || Math.abs(ax + aw - bx) <= 1)
          && by < ay + ah && ay < by + bh;
        return vertical || horizontal;
      });
      expect(flanking.length, `alley in ${world.dimensions.width}× world is not flanked`)
        .toBeGreaterThanOrEqual(2);

      // No building's doorstep inside the alley. The renderer paints the alley over
      // the door and `findContainingLocation` resolved the overlap by array order.
      for (const l of others) {
        const dx = Math.floor(l.entry_point.x / TILE);
        const dy = Math.floor(l.entry_point.y / TILE);
        const inside = dx >= ax && dx < ax + aw && dy >= ay && dy < ay + ah;
        expect(inside, `${l.name} doorway sits inside the alley`).toBe(false);
      }
    }
  });

  it('public buildings front onto the street network', () => {
    // Zones are the blocks *between* the roads, and a slot in the middle of a
    // block used to score exactly like one on its edge — so the bigger the town,
    // the more of it was back-lot. Doors within 2 tiles of a road were 21.0% at 13
    // agents, 15.8% at 20 and 15.2% at 30, with 46.5% of doors more than 6 tiles
    // out at 30. Ordering slots by door-to-road distance takes it to ~53% / ~8%,
    // and — the real point — flat across town size instead of degrading.
    //
    // Sampled over its own 60 seeds rather than `worldsFor`, which is 12. The
    // "~65%" this comment used to quote was never measured; the truth over 200
    // seeds is 52.7% at 13 agents and 54.3% at 30, so the old >0.5 bar had a
    // 1.4-point margin on the 12 pinned seeds (they measure 0.5139 at 30 agents)
    // — a coin flip away from a false regression. Worst 60-seed window over 200
    // seeds is 0.5139 / 0.5375, so 0.48 is the bar with headroom on both sides:
    // it still fails loudly on the 21% pre-fix behaviour.
    const OUTDOOR = ['mainstreet', 'alley', 'market_square', 'farmyard'];
    for (const agents of [13, 30]) {
      const frontageWorlds = Array.from({ length: 60 }, (_, i) =>
        generateWorld({ sizeTier: 'auto', overrides: {}, seed: `frontage-${i}` } as never, agents, {} as never),
      );
      let doors = 0, near = 0, far = 0;
      for (const world of frontageWorlds) {
        const roads = world.roads;
        for (const l of world.locations) {
          if (OUTDOOR.includes(l.type) || l.type === 'home') continue;
          const dx = Math.floor(l.entry_point.x / TILE);
          const dy = Math.floor(l.entry_point.y / TILE);
          let best = Infinity;
          for (const t of roads) {
            const d = Math.abs(t.x - dx) + Math.abs(t.y - dy);
            if (d < best) best = d;
          }
          doors++;
          if (best <= 2) near++;
          if (best > 6) far++;
        }
      }
      expect(near / doors, `${agents} agents: doors within 2 tiles of a road`)
        .toBeGreaterThan(0.48);
      expect(far / doors, `${agents} agents: doors more than 6 tiles from a road`)
        .toBeLessThan(0.15);
    }
  });

  it('every footprint keeps BORDER_BUFFER tiles clear of the map edge', () => {
    for (const world of worldsFor(13)) {
      const { width, height } = world.dimensions;
      for (const loc of world.locations) {
        if (loc.type === 'mainstreet') continue; // the road itself spans the map
        const tx = loc.position.x / TILE;
        const ty = loc.position.y / TILE;
        const tw = loc.position.width / TILE;
        const th = loc.position.height / TILE;
        expect(tx).toBeGreaterThanOrEqual(BORDER_BUFFER);
        expect(ty).toBeGreaterThanOrEqual(BORDER_BUFFER);
        expect(tx + tw).toBeLessThanOrEqual(width - BORDER_BUFFER);
        expect(ty + th).toBeLessThanOrEqual(height - BORDER_BUFFER);
      }
    }
  });

  it('every entry point is a walkable tile and mutually reachable', () => {
    for (const world of worldsFor(13)) {
      const { width, height } = world.dimensions;
      // `collisionGrid` is a flat row-major string, not an array of rows.
      const grid = world.collisionGrid;
      const walkable = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < width && y < height && grid[y * width + x] === '0';

      const entries = world.locations.map((loc) => ({
        type: loc.type,
        x: Math.floor(loc.entry_point.x / TILE),
        y: Math.floor(loc.entry_point.y / TILE),
      }));
      for (const e of entries) {
        expect(walkable(e.x, e.y), `${e.type} entry (${e.x},${e.y}) is blocked`).toBe(true);
      }

      // Flood fill from the first entry — every other entry must be in the same
      // connected component, or agents can never physically get there.
      const seen = new Uint8Array(width * height);
      const queue = [entries[0].y * width + entries[0].x];
      seen[queue[0]] = 1;
      for (let i = 0; i < queue.length; i++) {
        const cur = queue[i];
        const cx = cur % width;
        const cy = (cur - cx) / width;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!walkable(nx, ny) || seen[ny * width + nx]) continue;
          seen[ny * width + nx] = 1;
          queue.push(ny * width + nx);
        }
      }
      for (const e of entries) {
        expect(seen[e.y * width + e.x], `${e.type} entry is unreachable`).toBe(1);
      }
    }
  });

  it('produces materially different layouts across seeds', () => {
    const worlds = worldsFor(13);
    // Only venues with real slot freedom are asserted here; the pinned ones are
    // covered at region granularity below, which is the resolution the centrality
    // rule actually leaves them.
    //
    // `town_square` (centrality 1.0) sets the slot bucket to 1 tile and takes 2
    // distinct origins over 480 seeds. `park` (0.7) takes 18, but they are not
    // evenly spread — the top 4 are 83% of the mass and the worst 12-seed block
    // of 480 lands on 3, which is a failure.
    //
    // `tavern` is excluded for the same reason, one notch weaker: 13 distinct
    // origins over 480 seeds with the top 4 at 72% of the mass, and a worst
    // 12-seed block of exactly 4 — i.e. the `> 3` bar with zero margin. Compare
    // shop/town_hall/workshop, whose worst blocks are 6/7/7 out of 33-39 distinct
    // origins. Tavern's variety is asserted at region granularity below.
    for (const type of ['shop', 'town_hall', 'workshop']) {
      const origins = new Set(
        worlds.map((w) => {
          const loc = w.locations.find((l) => l.type === type)!;
          return `${loc.position.x},${loc.position.y}`;
        }),
      );
      // Was exactly 1 for every type — the slot lattice offered one candidate
      // per zone, so the RNG had nothing to pick from.
      expect(origins.size, `${type} is identical across seeds`).toBeGreaterThan(3);
    }
  });

  it('assigns venues to different map regions across seeds', () => {
    // Even after the slot lattice was fixed, `scoreZone` was a pure function of
    // (template, zone, used area) and the tie-break shuffle almost never fired,
    // so every seed put every venue in the same ninth of the map — only the slot
    // within that ninth moved. ZONE_SCORE_JITTER is what makes towns differ.
    const worlds = worldsFor(12);
    for (const type of ['shop', 'tavern', 'town_hall', 'workshop', 'park']) {
      const cells = new Set(
        worlds.map((w) => {
          const loc = w.locations.find((l) => l.type === type)!;
          const col = Math.floor((loc.position.x / TILE / w.dimensions.width) * 3);
          const row = Math.floor((loc.position.y / TILE / w.dimensions.height) * 3);
          return `${row},${col}`;
        }),
      );
      expect(cells.size, `${type} always lands in the same region`).toBeGreaterThan(1);
    }
  });
});
