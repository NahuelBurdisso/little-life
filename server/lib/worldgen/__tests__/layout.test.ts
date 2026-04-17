import { describe, it, expect } from 'vitest';
import { layoutStage } from '../stages/layout';
import { roadsStage } from '../stages/roads';
import { forkRng } from '../rng';
import { FitError } from '../types';
import type { WorldContext } from '../types';
import { getTemplatesForAgentCount } from '../buildingTemplates';

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
});
