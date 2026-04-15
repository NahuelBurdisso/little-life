import { describe, it, expect } from 'vitest';
import { INTERIOR_ZONES, INTERIOR_GRIDS, type ZoneDef } from '../data/interiors';

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

  it('home has no grid (uses lerp fallback)', () => {
    expect(INTERIOR_GRIDS.home).toBeUndefined();
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

  it('open areas still have empty arrays', () => {
    expect(INTERIOR_ZONES.farm).toEqual([]);
    expect(INTERIOR_ZONES.town_square).toEqual([]);
    expect(INTERIOR_ZONES.park).toEqual([]);
  });
});
