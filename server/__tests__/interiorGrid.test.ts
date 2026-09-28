import { describe, it, expect, beforeEach } from 'vitest';
import { INTERIOR_ZONES, INTERIOR_GRIDS, type ZoneDef } from '../data/interiors';
import { gridToCollisionString, getInteriorGrid, ZoneOccupancy } from '../lib/interiorGrid';

describe('Interior grid data', () => {
  it('every closed building type with zones has a grid', () => {
    const closedTypes = ['shop', 'tavern', 'clinic', 'bakery', 'workshop', 'town_hall', 'prison'];
    for (const type of closedTypes) {
      expect(INTERIOR_GRIDS[type], `missing grid for ${type}`).toBeDefined();
    }
  });

  it('grid dimensions match expected sizes', () => {
    expect(INTERIOR_GRIDS.shop.length).toBe(4);
    expect(INTERIOR_GRIDS.shop[0].length).toBe(5);
    expect(INTERIOR_GRIDS.tavern.length).toBe(4);
    expect(INTERIOR_GRIDS.tavern[0].length).toBe(6);
    expect(INTERIOR_GRIDS.town_hall.length).toBe(5);
    expect(INTERIOR_GRIDS.town_hall[0].length).toBe(6);
    expect(INTERIOR_GRIDS.clinic.length).toBe(4);
    expect(INTERIOR_GRIDS.clinic[0].length).toBe(5);
    expect(INTERIOR_GRIDS.bakery.length).toBe(4);
    expect(INTERIOR_GRIDS.bakery[0].length).toBe(5);
    expect(INTERIOR_GRIDS.workshop.length).toBe(4);
    expect(INTERIOR_GRIDS.workshop[0].length).toBe(5);
    expect(INTERIOR_GRIDS.prison.length).toBe(4);
    expect(INTERIOR_GRIDS.prison[0].length).toBe(5);
  });

  it('every grid has exactly one door tile (type 3)', () => {
    for (const [type, grid] of Object.entries(INTERIOR_GRIDS)) {
      const doorCount = grid.flat().filter(c => c === 3).length;
      expect(doorCount, `${type} should have exactly 1 door`).toBe(1);
    }
  });

  it('home has a synthetic 3x3 grid with door at south edge col 1', () => {
    const info = getInteriorGrid('home');
    expect(info).not.toBeNull();
    expect(info!.doorTile).toEqual([1, 2]);
    expect(info!.width).toBe(3);
    expect(info!.height).toBe(3);
  });

  it('ZoneDef has required fields', () => {
    const shopZones = INTERIOR_ZONES.shop as ZoneDef[];
    expect(shopZones.length).toBeGreaterThan(0);
    const z = shopZones[0];
    expect(z.id).toBeTypeOf('string');
    expect(z.tiles).toBeInstanceOf(Array);
    expect(z.center).toBeInstanceOf(Array);
    expect(z.center.length).toBe(2);
    expect(z.maxOccupants).toBeTypeOf('number');
    expect(z.allowedActions).toBeInstanceOf(Array);
    expect(z.visibility).toBeTypeOf('number');
    expect(z.color).toBeTypeOf('number');
  });

  it('backward compat: relativePosition still works', () => {
    const shopZones = INTERIOR_ZONES.shop as ZoneDef[];
    expect(shopZones[0].relativePosition).toBeDefined();
    expect(shopZones[0].relativePosition.x).toBeTypeOf('number');
    expect(shopZones[0].relativePosition.width).toBeGreaterThan(0);
  });

  it('backward compat: name field present', () => {
    const tavernZones = INTERIOR_ZONES.tavern as ZoneDef[];
    expect(tavernZones[0].name).toBeTypeOf('string');
  });

  it('open areas have zone definitions', () => {
    expect(INTERIOR_ZONES.farm.length).toBeGreaterThan(0);
    expect(INTERIOR_ZONES.town_square.length).toBeGreaterThan(0);
    expect(INTERIOR_ZONES.park.length).toBeGreaterThan(0);
  });
});

describe('gridToCollisionString', () => {
  it('converts mixed grid: 0,3 → walkable (0), 1,2 → blocked (1)', () => {
    const grid = [
      [1, 3, 1],
      [0, 0, 2],
      [1, 1, 1],
    ];
    expect(gridToCollisionString(grid)).toBe('101001111');
  });

  it('length matches grid dimensions (width * height)', () => {
    const grid = INTERIOR_GRIDS.shop;
    const result = gridToCollisionString(grid);
    expect(result.length).toBe(5 * 4);
  });

  it('shop grid door tile (col=2, row=3, south edge) maps to walkable', () => {
    const grid = INTERIOR_GRIDS.shop;
    const result = gridToCollisionString(grid);
    // row 3, col 2 → index 3*5 + 2 = 17
    expect(result[17]).toBe('0');
  });

  it('shop grid wall tiles map to blocked', () => {
    const grid = INTERIOR_GRIDS.shop;
    const result = gridToCollisionString(grid);
    // row 0, col 0 → index 0 (wall)
    expect(result[0]).toBe('1');
    // row 1, col 1 → index 6 (furniture)
    expect(result[6]).toBe('1');
  });
});

describe('getInteriorGrid', () => {
  it('returns valid InteriorGridInfo for home (synthetic 3x3 grid)', () => {
    const info = getInteriorGrid('home');
    expect(info).not.toBeNull();
    expect(info!.width).toBe(3);
    expect(info!.height).toBe(3);
    expect(info!.doorTile).toEqual([1, 2]);
  });

  it('returns null for farm (no grid)', () => {
    expect(getInteriorGrid('farm')).toBeNull();
  });

  it('returns null for unknown building type', () => {
    expect(getInteriorGrid('nonexistent')).toBeNull();
  });

  it('returns valid InteriorGridInfo for shop', () => {
    const info = getInteriorGrid('shop');
    expect(info).not.toBeNull();
    expect(info!.width).toBe(5);
    expect(info!.height).toBe(4);
    expect(info!.doorTile).toBeInstanceOf(Array);
    expect(info!.doorTile.length).toBe(2);
    expect(info!.collisionString).toBeTypeOf('string');
    expect(info!.collisionString.length).toBe(5 * 4);
    expect(info!.raw).toBe(INTERIOR_GRIDS.shop);
  });

  it('shop doorTile is at [col=2, row=3] (south edge, matching world entry)', () => {
    const info = getInteriorGrid('shop')!;
    expect(info.doorTile).toEqual([2, 3]);
  });

  it('every closed-building grid has its door on the south edge (last row)', () => {
    const closedTypes = ['shop', 'tavern', 'clinic', 'bakery', 'workshop', 'town_hall', 'prison'];
    for (const type of closedTypes) {
      const info = getInteriorGrid(type)!;
      expect(info.doorTile[1], `${type} door must be on last row`).toBe(info.height - 1);
    }
  });

  it('door column matches each building entry_point offset', () => {
    // Originally derived from the hand-authored map (entry_point - building.x);
    // pinned here now that worldgen places buildings procedurally.
    const expected: Record<string, number> = {
      shop: 2, tavern: 3, clinic: 2, bakery: 2, workshop: 2, town_hall: 3, prison: 2,
    };
    for (const [type, col] of Object.entries(expected)) {
      const info = getInteriorGrid(type)!;
      expect(info.doorTile[0], `${type} door col`).toBe(col);
    }
  });

  it('caches results — same object reference on second call', () => {
    const first = getInteriorGrid('shop');
    const second = getInteriorGrid('shop');
    expect(first).toBe(second);
  });

  it('returns valid info for town_hall (6w × 5h)', () => {
    const info = getInteriorGrid('town_hall');
    expect(info).not.toBeNull();
    expect(info!.width).toBe(6);
    expect(info!.height).toBe(5);
  });
});

describe('ZoneOccupancy', () => {
  let occupancy: ZoneOccupancy;

  beforeEach(() => {
    occupancy = new ZoneOccupancy();
  });

  it('findAgentZone returns null for unknown agent', () => {
    expect(occupancy.findAgentZone(99)).toBeNull();
  });

  it('enter adds agent to zone and findAgentZone returns it', () => {
    occupancy.enter(1, 'shop', 'counter');
    expect(occupancy.findAgentZone(1)).toEqual({ building: 'shop', zone: 'counter' });
  });

  it('getOccupants returns all agents in a zone', () => {
    occupancy.enter(1, 'shop', 'counter');
    occupancy.enter(2, 'shop', 'counter');
    const occ = occupancy.getOccupants('shop', 'counter');
    expect(occ).toContain(1);
    expect(occ).toContain(2);
    expect(occ.length).toBe(2);
  });

  it('leave removes agent from zone', () => {
    occupancy.enter(1, 'shop', 'counter');
    occupancy.leave(1);
    expect(occupancy.findAgentZone(1)).toBeNull();
    expect(occupancy.getOccupants('shop', 'counter')).not.toContain(1);
  });

  it('leave is a no-op for unknown agent', () => {
    expect(() => occupancy.leave(999)).not.toThrow();
  });

  it('enter auto-removes agent from previous zone before adding to new one', () => {
    occupancy.enter(1, 'shop', 'counter');
    occupancy.enter(1, 'shop', 'shelves');
    expect(occupancy.getOccupants('shop', 'counter')).not.toContain(1);
    expect(occupancy.getOccupants('shop', 'shelves')).toContain(1);
    expect(occupancy.findAgentZone(1)).toEqual({ building: 'shop', zone: 'shelves' });
  });

  it('enter auto-removes agent when moving to different building', () => {
    occupancy.enter(1, 'shop', 'counter');
    occupancy.enter(1, 'tavern', 'bar');
    expect(occupancy.getOccupants('shop', 'counter')).not.toContain(1);
    expect(occupancy.findAgentZone(1)).toEqual({ building: 'tavern', zone: 'bar' });
  });

  it('isFull returns false when under capacity', () => {
    occupancy.enter(1, 'shop', 'counter');
    expect(occupancy.isFull('shop', 'counter', 2)).toBe(false);
  });

  it('isFull returns true when at capacity', () => {
    occupancy.enter(1, 'shop', 'counter');
    occupancy.enter(2, 'shop', 'counter');
    expect(occupancy.isFull('shop', 'counter', 2)).toBe(true);
  });

  it('isFull returns false for empty zone', () => {
    expect(occupancy.isFull('shop', 'counter', 2)).toBe(false);
  });

  it('clear removes all tracking state', () => {
    occupancy.enter(1, 'shop', 'counter');
    occupancy.enter(2, 'tavern', 'bar');
    occupancy.clear();
    expect(occupancy.findAgentZone(1)).toBeNull();
    expect(occupancy.findAgentZone(2)).toBeNull();
    expect(occupancy.getOccupants('shop', 'counter')).toEqual([]);
  });
});
