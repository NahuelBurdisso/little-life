import { describe, it, expect } from 'vitest';
import { INTERIOR_GRIDS, INTERIOR_ZONES, ACTION_ZONE_REQUIREMENTS } from '../data/interiors';
import { getInteriorGrid } from '../lib/interiorGrid';

// ---------------------------------------------------------------------------
// Helper: Chebyshev distance
// ---------------------------------------------------------------------------
function chebyshev(a: [number, number], b: [number, number]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

// ---------------------------------------------------------------------------
// 1. Zone center walkability (closed buildings only)
// ---------------------------------------------------------------------------

describe('zone center walkability', () => {
  it('every zone.center is a walkable tile (0 or 3) in INTERIOR_GRIDS', () => {
    for (const [type, zones] of Object.entries(INTERIOR_ZONES)) {
      const grid = INTERIOR_GRIDS[type];
      if (!grid) continue; // open areas / home (if no grid) are exempt
      for (const zone of zones) {
        const [cx, cy] = zone.center;
        const cell = grid[cy]?.[cx];
        expect(
          cell === 0 || cell === 3,
          `${type}:${zone.id} center [${cx},${cy}] has grid value ${cell}, expected 0 or 3`,
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Furniture tile validity
// ---------------------------------------------------------------------------

describe('zone furniture tile validity', () => {
  it('every zone.furniture.tile points to grid cell == 2 (or is sentinel [-1,-1])', () => {
    for (const [type, zones] of Object.entries(INTERIOR_ZONES)) {
      const grid = INTERIOR_GRIDS[type];
      for (const zone of zones) {
        if (!zone.furniture) continue;
        const [fx, fy] = zone.furniture.tile;
        if (fx === -1 && fy === -1) continue; // sentinel — grid-exempt
        // There must be a grid for non-sentinel furniture tiles
        expect(
          grid,
          `${type}:${zone.id} has furniture.tile [${fx},${fy}] but no INTERIOR_GRIDS entry`,
        ).toBeDefined();
        if (!grid) continue;
        expect(
          grid[fy]?.[fx],
          `${type}:${zone.id} furniture.tile [${fx},${fy}] must be 2, got ${grid[fy]?.[fx]}`,
        ).toBe(2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Chebyshev distance(center, furniture.tile) <= 1
// ---------------------------------------------------------------------------

describe('Chebyshev distance center ↔ furniture', () => {
  it('distance is <= 1 for every zone with a real furniture tile', () => {
    for (const [type, zones] of Object.entries(INTERIOR_ZONES)) {
      for (const zone of zones) {
        if (!zone.furniture) continue;
        const [fx, fy] = zone.furniture.tile;
        if (fx === -1 && fy === -1) continue; // sentinel exempt
        const dist = chebyshev(zone.center as [number, number], [fx, fy]);
        expect(
          dist,
          `${type}:${zone.id} center [${zone.center}] is Chebyshev ${dist} from furniture [${fx},${fy}], must be <= 1`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. No orphan furniture cells — every grid cell == 2 claimed by exactly one zone
// ---------------------------------------------------------------------------

describe('no orphan furniture cells', () => {
  it('every grid cell with value 2 is claimed by exactly one zone.furniture.tile', () => {
    for (const [type, grid] of Object.entries(INTERIOR_GRIDS)) {
      const zones = INTERIOR_ZONES[type] ?? [];
      const claimed = new Set(
        zones
          .filter(z => z.furniture && z.furniture.tile[0] !== -1)
          .map(z => `${z.furniture!.tile[0]},${z.furniture!.tile[1]}`),
      );
      for (let row = 0; row < grid.length; row++) {
        for (let col = 0; col < grid[row].length; col++) {
          if (grid[row][col] === 2) {
            expect(
              claimed.has(`${col},${row}`),
              `${type} grid cell [col=${col},row=${row}] = 2 but no zone claims it as furniture.tile`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. ACTION_ZONE_REQUIREMENTS references resolve to existing building + zone ids
// ---------------------------------------------------------------------------

describe('ACTION_ZONE_REQUIREMENTS integrity', () => {
  it('every building type referenced exists in INTERIOR_ZONES', () => {
    for (const [action, buildingMap] of Object.entries(ACTION_ZONE_REQUIREMENTS)) {
      for (const buildingType of Object.keys(buildingMap)) {
        expect(
          INTERIOR_ZONES[buildingType],
          `ACTION_ZONE_REQUIREMENTS.${action} references unknown building "${buildingType}"`,
        ).toBeDefined();
      }
    }
  });

  it('every zone id referenced exists in the building zones list', () => {
    for (const [action, buildingMap] of Object.entries(ACTION_ZONE_REQUIREMENTS)) {
      for (const [buildingType, zoneIds] of Object.entries(buildingMap)) {
        const zones = INTERIOR_ZONES[buildingType];
        if (!zones) continue;
        const knownIds = new Set(zones.map(z => z.id));
        for (const zoneId of zoneIds) {
          expect(
            knownIds.has(zoneId),
            `ACTION_ZONE_REQUIREMENTS.${action}.${buildingType} references unknown zone id "${zoneId}"`,
          ).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Home synthetic grid — door at [col=1, row=2]
// ---------------------------------------------------------------------------

describe('home synthetic grid', () => {
  it('INTERIOR_GRIDS.home exists (synthetic 3x3 grid)', () => {
    expect(INTERIOR_GRIDS.home).toBeDefined();
    expect(INTERIOR_GRIDS.home.length).toBe(3);
    expect(INTERIOR_GRIDS.home[0].length).toBe(3);
  });

  it('home grid has door tile (3) at [col=1, row=2]', () => {
    const grid = INTERIOR_GRIDS.home;
    expect(grid).toBeDefined();
    expect(grid[2]?.[1]).toBe(3);
  });

  it('getInteriorGrid("home") returns valid info with doorTile [1,2]', () => {
    const info = getInteriorGrid('home');
    expect(info).not.toBeNull();
    expect(info!.doorTile).toEqual([1, 2]);
    expect(info!.width).toBe(3);
    expect(info!.height).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 7. Comfort outlet — park benches reachable via ACTION_ZONE_REQUIREMENTS
// ---------------------------------------------------------------------------

describe('comfort outlet reachability', () => {
  it('ACTION_ZONE_REQUIREMENTS has comfort mapped to park benches', () => {
    expect(ACTION_ZONE_REQUIREMENTS.comfort).toBeDefined();
    expect(ACTION_ZONE_REQUIREMENTS.comfort?.park).toContain('benches');
  });

  it('park benches zone allows comfort action', () => {
    const bench = INTERIOR_ZONES.park?.find(z => z.id === 'benches');
    expect(bench).toBeDefined();
    expect(bench?.allowedActions).toContain('comfort');
  });
});
