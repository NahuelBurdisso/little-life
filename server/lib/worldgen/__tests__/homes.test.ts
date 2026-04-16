import { describe, it, expect } from 'vitest';
import { homesStage } from '../stages/homes';
import { forkRng } from '../rng';
import { FitError } from '../types';
import type { WorldContext } from '../types';
import type { LocationSeed } from '../../../data/maps';

function ctxWith(width: number, height: number, publicBuildings: LocationSeed[] = []): WorldContext {
  return {
    dimensions: { width, height },
    terrainTiles: [],
    publicBuildings,
    homes: null, interiors: null, names: null,
  };
}

const CFG = { seed: 'test', sizeTier: 'medium' as const, overrides: {} };

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
    const pinned = [{ x: 32, y: 32 }, { x: 32, y: 160 }];
    const cfg = { ...CFG, overrides: { homePositions: pinned } };
    const homes = homesStage.run(ctx, rng, cfg, 4, {}).homes!;
    expect(homes).toHaveLength(2);
    expect(homes[0].position.x).toBe(pinned[0].x);
    expect(homes[0].position.y).toBe(pinned[0].y);
  });

  it('override path: mismatched count throws FitError', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const cfg = { ...CFG, overrides: { homePositions: [{ x: 32, y: 32 }] } };
    expect(() => homesStage.run(ctx, rng, cfg, 10, {}).homes).toThrowError(FitError);
  });

  it('home footprint must stay within [1, width-1] × [1, height-1] border', () => {
    const ctx = ctxWith(60, 45);
    const rng = forkRng('test', 'homes');
    const homes = homesStage.run(ctx, rng, CFG, 20, {}).homes!;
    for (const h of homes) {
      const tx = h.position.x / 32;
      const ty = h.position.y / 32;
      expect(tx).toBeGreaterThanOrEqual(1);
      expect(ty).toBeGreaterThanOrEqual(1);
      expect(tx + 3).toBeLessThanOrEqual(60 - 1);
      expect(ty + 3).toBeLessThanOrEqual(45 - 1);
    }
  });
});
