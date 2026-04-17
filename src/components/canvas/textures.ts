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

const WALL_URLS: Record<string, string> = {
  // Wall/door sprites intentionally unused — procedural Graphics handles building
  // walls. Keep the map here so getWallTexture() still returns null cleanly.
};

const FURNITURE_URLS: Record<string, string> = {
  bed: '/sprites/furniture/bed.png',
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
  });
  inflight.set(url, p);
  return p;
}

export function getTerrainTexture(key: string): Promise<PIXI.Texture> | null {
  const url = TERRAIN_URLS[key];
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
    ...Object.values(WALL_URLS),
    ...Object.values(FURNITURE_URLS),
  ];
  await Promise.allSettled(all.map(loadTexture));
}
