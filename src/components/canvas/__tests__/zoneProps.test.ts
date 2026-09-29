import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INTERIOR_ZONES, INTERIOR_GRIDS } from '../../../../server/data/interiors';
import { BUILDING_TEMPLATES } from '../../../../server/lib/worldgen/buildingTemplates';
import { FURNITURE_SPRITE } from '../BuildingRenderer';
import { FURNITURE_URLS, PROP_URLS } from '../textures';
import {
  ZONE_PROPS,
  ZONES_DRAWN_ELSEWHERE,
  isZoneIllustrated,
  marketSquareStalls,
  farmyardStock,
} from '../zoneProps';

const TILE = 32;

/** Width/height from a PNG's IHDR chunk. */
function pngSize(url: string): { w: number; h: number } {
  const buf = readFileSync(resolve(process.cwd(), 'public', url.replace(/^\//, '')));
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function urlFor(sprite: string): string | undefined {
  return PROP_URLS[sprite] ?? FURNITURE_URLS[sprite];
}

/** Footprint in tiles of a location type: enclosed grids, else the template size. */
function footprint(type: string): { cols: number; rows: number } {
  const grid = INTERIOR_GRIDS[type];
  if (grid) return { cols: grid[0].length, rows: grid.length };
  const tpl = BUILDING_TEMPLATES.find((t) => t.type === type);
  if (!tpl) throw new Error(`no footprint for ${type}`);
  return { cols: tpl.size.w, rows: tpl.size.h };
}

describe('zone prop coverage', () => {
  it('every zone is a picture: a furniture sprite, a prop list, or drawn elsewhere on purpose', () => {
    const naked: string[] = [];
    for (const [type, zones] of Object.entries(INTERIOR_ZONES)) {
      for (const zone of zones) {
        if (ZONES_DRAWN_ELSEWHERE[type]?.has(zone.id)) continue;
        if (!isZoneIllustrated(type, zone, FURNITURE_SPRITE)) naked.push(`${type}:${zone.id}`);
      }
    }
    expect(naked).toEqual([]);
  });

  it('ZONE_PROPS only names real zones', () => {
    for (const [type, byZone] of Object.entries(ZONE_PROPS)) {
      const ids = new Set((INTERIOR_ZONES[type] ?? []).map((z) => z.id));
      for (const zoneId of Object.keys(byZone)) {
        expect(ids.has(zoneId), `${type}:${zoneId} is not a zone`).toBe(true);
      }
    }
  });

  it('drawn-elsewhere exemptions name real zones', () => {
    for (const [type, ids] of Object.entries(ZONES_DRAWN_ELSEWHERE)) {
      const real = new Set((INTERIOR_ZONES[type] ?? []).map((z) => z.id));
      for (const id of ids) expect(real.has(id), `${type}:${id}`).toBe(true);
    }
  });
});

describe('zone prop placement', () => {
  const all = Object.entries(ZONE_PROPS).flatMap(([type, byZone]) =>
    Object.entries(byZone).flatMap(([zoneId, list]) =>
      list.map((p) => ({ type, zoneId, ...p })),
    ),
  );

  it('every sprite has a texture url and a PNG on disk', () => {
    for (const p of all) {
      const url = urlFor(p.sprite);
      expect(url, `${p.type}:${p.zoneId} -> ${p.sprite}`).toBeDefined();
      expect(() => pngSize(url!)).not.toThrow();
    }
  });

  it('every PROP_URLS entry is placed somewhere', () => {
    const used = new Set<string>([
      ...all.map((p) => p.sprite),
      // Derived areas place their sprites by geometry, not by zone.
      ...marketSquareStalls(128, 128).map((p) => p.sprite),
      ...farmyardStock(96, 96).map((p) => p.sprite),
    ]);
    for (const key of Object.keys(PROP_URLS)) {
      expect(used.has(key), `PROP_URLS "${key}" is never placed`).toBe(true);
    }
  });

  it('sprites stay inside the location footprint', () => {
    for (const p of all) {
      const { w, h } = pngSize(urlFor(p.sprite)!);
      const { cols, rows } = footprint(p.type);
      expect(p.tile[0] >= 0 && p.tile[1] >= 0, `${p.type}:${p.zoneId}`).toBe(true);
      expect(p.tile[0] * TILE + w, `${p.type}:${p.zoneId} ${p.sprite} right edge`).toBeLessThanOrEqual(cols * TILE);
      expect(p.tile[1] * TILE + h, `${p.type}:${p.zoneId} ${p.sprite} bottom edge`).toBeLessThanOrEqual(rows * TILE);
    }
  });

  it('never sits on a wall or door cell of an enclosed interior', () => {
    for (const p of all) {
      const grid = INTERIOR_GRIDS[p.type];
      if (!grid) continue;
      const cell = grid[p.tile[1]]?.[p.tile[0]];
      expect(cell === 0 || cell === 2, `${p.type}:${p.zoneId} ${p.sprite} at ${p.tile} is cell ${cell}`).toBe(true);
    }
  });

  it('never covers a tile that another sprite already occupies', () => {
    const owner = new Map<string, string>();
    const claim = (type: string, col: number, row: number, what: string) => {
      const key = `${type}@${col},${row}`;
      expect(owner.get(key), `${what} overlaps ${owner.get(key)} at ${key}`).toBeUndefined();
      owner.set(key, what);
    };
    // Furniture sprites first (one tile each, at the sentinel-resolved position).
    for (const [type, zones] of Object.entries(INTERIOR_ZONES)) {
      for (const zone of zones) {
        const f = zone.furniture;
        if (!f || !FURNITURE_SPRITE[f.label]) continue;
        const [c, r] = f.tile[0] < 0 || f.tile[1] < 0 ? zone.center : f.tile;
        claim(type, c, r, `furniture ${type}:${zone.id}`);
      }
    }
    for (const p of all) {
      const { w, h } = pngSize(urlFor(p.sprite)!);
      for (let dc = 0; dc < Math.ceil(w / TILE); dc++) {
        for (let dr = 0; dr < Math.ceil(h / TILE); dr++) {
          claim(p.type, p.tile[0] + dc, p.tile[1] + dr, `${p.sprite} ${p.type}:${p.zoneId}`);
        }
      }
    }
  });
});

describe('derived open areas', () => {
  it('a 4x4-tile market square gets two centred rows of three stalls with a walkway', () => {
    const stalls = marketSquareStalls(128, 128);
    expect(stalls).toHaveLength(6);
    const rows = [...new Set(stalls.map((s) => s.y))].sort((a, b) => a - b);
    expect(rows).toHaveLength(2);
    expect(rows[1] - (rows[0] + TILE)).toBeGreaterThanOrEqual(24);
    const xs = stalls.filter((s) => s.y === rows[0]).map((s) => s.x);
    // Centred: equal margin left and right.
    expect(xs[0]).toBe(128 - (xs[xs.length - 1] + TILE));
  });

  it('a lot too short for a walkway gets no stalls', () => {
    expect(marketSquareStalls(128, 64)).toEqual([]);
  });

  it('farmyard stock stays inside a 3x3-tile yard, off the fence line', () => {
    const stock = farmyardStock(96, 96);
    expect(stock.length).toBeGreaterThan(0);
    for (const s of stock) {
      const { w, h } = pngSize(urlFor(s.sprite)!);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x + w).toBeLessThanOrEqual(96);
      expect(s.y + h).toBeLessThanOrEqual(96);
    }
    expect(stock.some((s) => s.sprite === 'trough')).toBe(true);
  });
});
