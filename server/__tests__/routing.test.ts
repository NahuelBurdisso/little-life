import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { computeAStarPath, setPathFallbackObserver, type PathFallback } from '../lib/pathfinding';
import { planRoute, enclosingBuilding } from '../engine/systems/movement';
import { generateWorld } from '../lib/worldgen';
import { generateCollisionGridForLocations } from '../lib/worldgen/collisionGrid';
import { ENCLOSED_BUILDING_TYPES } from '../lib/worldgen/buildingTemplates';
import { INTERIOR_ZONES } from '../data/interiors';
import { getOpenAreaTerrainCosts, zoneSlotOffset } from '../lib/interiorGrid';

/**
 * P1: straight-line fallbacks. Every destination the sim hands the movement
 * system — building entry points, interior work spots (zones), and whatever
 * spot a conversation partner is standing on — must route without walking
 * through a wall.
 */

const T = 32;

let fallbacks: PathFallback[] = [];
beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  setPathFallbackObserver((f) => fallbacks.push(f));
});
afterEach(() => { fallbacks = []; });
afterAll(() => {
  setPathFallbackObserver(null);
  vi.restoreAllMocks();
});

const straightLines = () => fallbacks.filter((f) => f.kind === 'unroutable-destination' || f.kind === 'no-route');

type Loc = {
  id: number; type: string;
  position: { x: number; y: number; width: number; height: number };
  entry_point: { x: number; y: number };
};

/** A 16×10 town: a 5×4 shop at tile (2,2) and a 3×3 home at tile (10,2). */
function tinyTown() {
  const mk = (id: number, type: string, tx: number, ty: number, w: number, h: number): Loc => ({
    id, type,
    position: { x: tx * T, y: ty * T, width: w * T, height: h * T },
    entry_point: { x: tx * T + (w * T) / 2, y: (ty + h) * T },
  });
  const locs = [mk(1, 'shop', 2, 2, 5, 4), mk(2, 'home', 10, 2, 3, 3)];
  const world = {
    map_width: 16, map_height: 10,
    collision_grid: generateCollisionGridForLocations(
      locs.map((l) => ({ ...l.position, entryX: l.entry_point.x, entryY: l.entry_point.y, type: l.type })), 16, 10),
  };
  return { locs, world };
}

/** Pixel centre of an interior zone of `loc`. */
function zonePoint(loc: Loc, zoneId: string, slotAgent?: number) {
  const z = INTERIOR_ZONES[loc.type].find((zz) => zz.id === zoneId)!;
  const slot = slotAgent != null ? zoneSlotOffset(slotAgent) : { dx: 0, dy: 0 };
  return { x: loc.position.x + z.center[0] * T + 16 + slot.dx, y: loc.position.y + z.center[1] * T + 16 + slot.dy };
}

/** Every waypoint either on an open world tile or inside the building grid it belongs to. */
function crossesNoWall(path: number[][], world: { collision_grid: string; map_width: number }, locs: Loc[]) {
  for (const [x, y] of path) {
    const b = enclosingBuilding({ x, y }, locs);
    if (b) continue; // interior waypoint — checked on the interior grid by A*
    const i = Math.floor(y / T) * world.map_width + Math.floor(x / T);
    if (world.collision_grid[i] === '1') return false;
  }
  return true;
}

describe('planRoute', () => {
  it('walks into a building to a work spot through its door, not through the wall', () => {
    const { locs, world } = tinyTown();
    const counter = zonePoint(locs[0], 'counter');
    const path = planRoute({ x: 14 * T + 16, y: 8 * T + 16 }, counter, world, locs);
    expect(straightLines()).toEqual([]);
    expect(path.at(-1)).toEqual([counter.x, counter.y]);
    expect(path).toContainEqual([locs[0].entry_point.x, locs[0].entry_point.y]);
    expect(crossesNoWall(path, world, locs)).toBe(true);
  });

  it('walks out of a building from a work spot through its door', () => {
    const { locs, world } = tinyTown();
    const counter = zonePoint(locs[0], 'counter');
    const dest = { x: 14 * T + 16, y: 8 * T + 16 };
    const path = planRoute(counter, dest, world, locs);
    expect(straightLines()).toEqual([]);
    expect(path.at(-1)).toEqual([dest.x, dest.y]);
    expect(path).toContainEqual([locs[0].entry_point.x, locs[0].entry_point.y]);
    expect(crossesNoWall(path, world, locs)).toBe(true);
  });

  it('walks from a spot in one building to a spot in another (a conversation approach)', () => {
    const { locs, world } = tinyTown();
    const from = zonePoint(locs[0], 'shelves', 7);
    const to = zonePoint(locs[1], 'bed');
    const path = planRoute(from, to, world, locs);
    expect(straightLines()).toEqual([]);
    expect(path.at(-1)).toEqual([to.x, to.y]);
    expect(path).toContainEqual([locs[0].entry_point.x, locs[0].entry_point.y]);
    expect(path).toContainEqual([locs[1].entry_point.x, locs[1].entry_point.y]);
  });

  it('stays on the interior grid between two spots of the same building', () => {
    const { locs, world } = tinyTown();
    const path = planRoute(zonePoint(locs[0], 'counter'), zonePoint(locs[0], 'shelves'), world, locs);
    expect(straightLines()).toEqual([]);
    for (const [x, y] of path) expect(enclosingBuilding({ x, y }, locs)?.id).toBe(1);
  });

  it('leaves the doorstep outside the building', () => {
    const { locs } = tinyTown();
    expect(enclosingBuilding(locs[0].entry_point, locs)).toBeNull();
  });
});

describe('computeAStarPath destination snapping', () => {
  it('routes to the nearest open tile, then steps onto a blocked destination', () => {
    // 5×3, the middle column of row 1 is solid; the destination is on it.
    const grid = '000000001000000';
    const end = { x: 3 * T + 16, y: 1 * T + 16 };
    const path = computeAStarPath({ x: 16, y: 16 }, end, grid, 5, 3, T);
    expect(fallbacks.map((f) => f.kind)).toEqual(['snapped-destination']);
    expect(path.at(-1)).toEqual([end.x, end.y]);
    // Every waypoint but the last is on an open tile.
    for (const [x, y] of path.slice(0, -1)) expect(grid[Math.floor(y / T) * 5 + Math.floor(x / T)]).toBe('0');
  });

  it('steps off a solid start tile walled in on all sides instead of cutting through', () => {
    // 5×3: the start (0,1) is solid and so are both its orthogonal neighbours,
    // so A* from it could not move at all.
    const grid = '100001100010000';
    const path = computeAStarPath({ x: 16, y: T + 16 }, { x: 4 * T + 16, y: 1 * T + 16 }, grid, 5, 3, T);
    expect(fallbacks.map((f) => f.kind)).toEqual(['snapped-start']);
    expect(straightLines()).toEqual([]);
    expect(path.at(-1)).toEqual([4 * T + 16, T + 16]);
  });

  it('treats an infinite-cost destination (the park river) the same way', () => {
    const costs = new Float32Array(15).fill(1);
    costs[8] = Infinity;
    const end = { x: 3 * T + 16, y: 1 * T + 16 };
    const path = computeAStarPath({ x: 16, y: 16 }, end, '0'.repeat(15), 5, 3, T, costs);
    expect(fallbacks.map((f) => f.kind)).toEqual(['snapped-destination']);
    expect(path.at(-1)).toEqual([end.x, end.y]);
  });
});

describe('generated towns are fully routable', () => {
  // Grid and organic layouts, several sizes. Every entry point, every interior
  // zone (with the per-agent slot offsets the decision engine adds) and every
  // open-area zone must be reachable from every building's door with no
  // straight-line fallback.
  const cases: { seed: string; agents: number; organic: boolean }[] = [];
  for (const [i, n] of [5, 13, 13, 30].entries()) {
    cases.push({ seed: `route-${i}`, agents: n, organic: false });
    cases.push({ seed: `route-org-${i}`, agents: n, organic: true });
  }
  cases.push({ seed: 'soak', agents: 13, organic: false });

  it.each(cases)('$seed ($agents agents, organic=$organic)', ({ seed, agents, organic }) => {
    const gen = generateWorld(
      { sizeTier: 'auto', overrides: {}, seed, ...(organic ? { layoutStyle: 'organic' } : {}) } as never,
      agents, {} as never,
    );
    const locs: Loc[] = gen.locations.map((l, i) => ({ id: i + 1, type: l.type, position: l.position, entry_point: l.entry_point }));
    const world = { collision_grid: gen.collisionGrid, map_width: gen.dimensions.width, map_height: gen.dimensions.height };
    const costMap = new Float32Array(world.map_width * world.map_height).fill(1);
    for (const season of ['spring', 'winter']) {
      for (const e of getOpenAreaTerrainCosts(season, locs.filter((l) => ['farm', 'park', 'town_square'].includes(l.type)), T)) {
        costMap[e.tileY * world.map_width + e.tileX] = Math.max(costMap[e.tileY * world.map_width + e.tileX], e.cost);
      }
    }

    const targets: { label: string; pt: { x: number; y: number } }[] = [];
    for (const l of locs) {
      targets.push({ label: `${l.type}#${l.id} door`, pt: l.entry_point });
      for (const z of INTERIOR_ZONES[l.type] ?? []) {
        for (const agent of [undefined, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
          targets.push({ label: `${l.type}#${l.id} ${z.id}${agent ? `+slot${agent}` : ''}`, pt: zonePoint(l, z.id, agent) });
        }
      }
    }
    // Start from a door and from a spot inside a public building and a home.
    const shop = locs.find((l) => l.type === 'shop')!;
    const home = locs.find((l) => l.type === 'home')!;
    const starts = [shop.entry_point, zonePoint(shop, 'counter'), zonePoint(home, 'bed')];

    const bad: string[] = [];
    for (const from of starts) {
      for (const t of targets) {
        fallbacks = [];
        const path = planRoute(from, t.pt, world, locs, costMap);
        const last = path.at(-1)!;
        if (straightLines().length) bad.push(`${t.label}: ${straightLines().map((f) => f.kind).join(',')}`);
        else if (last[0] !== t.pt.x || last[1] !== t.pt.y) bad.push(`${t.label}: ends at ${last}`);
        else if (!crossesNoWall(path, world, locs)) bad.push(`${t.label}: crosses a wall`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    // Every enclosed building type in the town has an interior grid to route on.
    for (const l of locs) if (ENCLOSED_BUILDING_TYPES.has(l.type)) expect(INTERIOR_ZONES[l.type]?.length ?? 0).toBeGreaterThan(0);
  });
});
