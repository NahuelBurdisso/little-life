import * as PIXI from "pixi.js";

/**
 * Central texture registry for world/building sprites.
 * Loads on demand via PIXI.Assets and caches. Pixel-art uses nearest-neighbor scale.
 */

const TERRAIN_URLS: Record<string, string> = {
  grass: '/sprites/tiles/terrain_grass.png',
  dirt_path: '/sprites/tiles/terrain_dirt_path.png',
  water: '/sprites/tiles/terrain_water.png',
  farm_soil: '/sprites/tiles/terrain_farm_soil.png',
  crops_summer: '/sprites/tiles/terrain_crops_summer.png',
  grove: '/sprites/tiles/terrain_grove.png',
  stone_plaza: '/sprites/tiles/terrain_stone_plaza.png',
};

/**
 * Tileable interior floor surfaces. Authored near-white and greyscale so a
 * PixiJS `tint` recolours them to each building type's palette instead of
 * needing one texture per type.
 */
const FLOOR_URLS: Record<string, string> = {
  wood:  '/sprites/tiles/floor_wood.png',
  tile:  '/sprites/tiles/floor_tile.png',
  stone: '/sprites/tiles/floor_stone.png',
};

const WALL_URLS: Record<string, string> = {
  // Wall/door sprites intentionally unused — procedural Graphics handles building
  // walls. Keep the map here so getWallTexture() still returns null cleanly.
};

export const FURNITURE_URLS: Record<string, string> = {
  bed:             '/sprites/furniture/bed.png',
  stove:           '/sprites/furniture/stove.png',
  counter:         '/sprites/furniture/counter.png',
  shelves:         '/sprites/furniture/shelves.png',
  bar_counter:     '/sprites/furniture/bar_counter.png',
  stage:           '/sprites/furniture/stage.png',
  booth_seat:      '/sprites/furniture/booth_seat.png',
  reception_desk:  '/sprites/furniture/reception_desk.png',
  patient_bed:     '/sprites/furniture/patient_bed.png',
  mayors_desk:     '/sprites/furniture/mayors_desk.png',
  meeting_table:   '/sprites/furniture/meeting_table.png',
  filing_cabinet:  '/sprites/furniture/filing_cabinet.png',
  oven:            '/sprites/furniture/oven.png',
  prep_table:      '/sprites/furniture/prep_table.png',
  workbench:       '/sprites/furniture/workbench.png',
  tool_rack:       '/sprites/furniture/tool_rack.png',
  forge:           '/sprites/furniture/forge.png',
  guard_desk:      '/sprites/furniture/guard_desk.png',
};

const cache = new Map<string, PIXI.Texture>();
const inflight = new Map<string, Promise<PIXI.Texture>>();

async function loadTexture(url: string): Promise<PIXI.Texture> {
  if (cache.has(url)) return cache.get(url)!;
  if (inflight.has(url)) return inflight.get(url)!;
  const p = PIXI.Assets.load<PIXI.Texture>(url).then(tex => {
    tex.source.scaleMode = 'nearest';
    cache.set(url, tex);
    inflight.delete(url);
    return tex;
  }).catch(err => {
    // Drop the rejected promise, or one transient failure pins this key to its
    // colour fallback for the rest of the session with no chance to retry.
    inflight.delete(url);
    throw err;
  });
  inflight.set(url, p);
  return p;
}

export function getTerrainTexture(key: string): Promise<PIXI.Texture> | null {
  const url = TERRAIN_URLS[key];
  return url ? loadTexture(url) : null;
}

export function getFloorTexture(key: string): Promise<PIXI.Texture> | null {
  const url = FLOOR_URLS[key];
  return url ? loadTexture(url) : null;
}

export function getWallTexture(key: string): Promise<PIXI.Texture> | null {
  const url = WALL_URLS[key];
  return url ? loadTexture(url) : null;
}

export function getFurnitureTexture(key: string): Promise<PIXI.Texture> | null {
  const url = FURNITURE_URLS[key];
  return url ? loadTexture(url) : null;
}

/** Preload everything. Returns once all textures resolved (or failed). */
export async function preloadAllWorldTextures(): Promise<void> {
  const all = [
    ...Object.values(TERRAIN_URLS),
    ...Object.values(FLOOR_URLS),
    ...Object.values(WALL_URLS),
    ...Object.values(FURNITURE_URLS),
  ];
  await Promise.allSettled(all.map(loadTexture));
}
