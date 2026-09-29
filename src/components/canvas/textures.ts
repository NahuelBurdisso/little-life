import * as PIXI from "pixi.js";

/**
 * Central texture registry for world/building sprites.
 * Loads on demand via PIXI.Assets and caches. Pixel-art uses nearest-neighbor scale.
 */

const TERRAIN_URLS: Record<string, string> = {
  grass: '/sprites/tiles/terrain_grass.png',
  dirt_path: '/sprites/tiles/terrain_dirt_path.png',
  water: '/sprites/tiles/terrain_water.png',
  // Opaque river water (scripts/aseprite/river-tile.lua); `water` is only a dash overlay.
  river: '/sprites/tiles/terrain_river.png',
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

/**
 * Tileable roof surfaces (scripts/aseprite/roof-tiles.lua). Neutral grey like the
 * floors: BuildingRenderer tints them per building type.
 */
const ROOF_URLS: Record<string, string> = {
  clay:    '/sprites/tiles/roof_clay.png',
  shingle: '/sprites/tiles/roof_shingle.png',
  slate:   '/sprites/tiles/roof_slate.png',
  tin:     '/sprites/tiles/roof_tin.png',
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

/**
 * Zone props (scripts/aseprite/furniture.lua): objects that dress a *zone* rather than back
 * a sim furniture label, so they are not in FURNITURE_SPRITE. Placement lives in zoneProps.ts.
 * Same folder and cell conventions as FURNITURE_URLS.
 */
export const PROP_URLS: Record<string, string> = {
  sofa:               '/sprites/furniture/sofa.png',
  armchair:           '/sprites/furniture/armchair.png',
  rug:                '/sprites/furniture/rug.png',
  crates:             '/sprites/furniture/crates.png',
  display_table:      '/sprites/furniture/display_table.png',
  pawn_case:          '/sprites/furniture/pawn_case.png',
  table_chairs:       '/sprites/furniture/table_chairs.png',
  table_stools:       '/sprites/furniture/table_stools.png',
  exam_table:         '/sprites/furniture/exam_table.png',
  medicine_cabinet:   '/sprites/furniture/medicine_cabinet.png',
  bench:              '/sprites/furniture/bench.png',
  bread_display:      '/sprites/furniture/bread_display.png',
  flour_sacks:        '/sprites/furniture/flour_sacks.png',
  plank_pile:         '/sprites/furniture/plank_pile.png',
  prison_cell:        '/sprites/furniture/prison_cell.png',
  hall_mat:           '/sprites/furniture/hall_mat.png',
  stall_produce:      '/sprites/furniture/stall_produce.png',
  stall_cloth:        '/sprites/furniture/stall_cloth.png',
  stall_bread:        '/sprites/furniture/stall_bread.png',
  stall_fish:         '/sprites/furniture/stall_fish.png',
  podium:             '/sprites/furniture/podium.png',
  lamp_post:          '/sprites/furniture/lamp_post.png',
  planter:            '/sprites/furniture/planter.png',
  flower_bed_pink:    '/sprites/furniture/flower_bed_pink.png',
  flower_bed_yellow:  '/sprites/furniture/flower_bed_yellow.png',
  reeds:              '/sprites/furniture/reeds.png',
  shore_rocks:        '/sprites/furniture/shore_rocks.png',
  fallen_log:         '/sprites/furniture/fallen_log.png',
  mushrooms:          '/sprites/furniture/mushrooms.png',
  chicken_coop:       '/sprites/furniture/chicken_coop.png',
  barn:               '/sprites/furniture/barn.png',
  hay_bale:           '/sprites/furniture/hay_bale.png',
  stump:              '/sprites/furniture/stump.png',
  trough:             '/sprites/furniture/trough.png',
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

export function getRoofTexture(key: string): Promise<PIXI.Texture> | null {
  const url = ROOF_URLS[key];
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

/** Texture for a zone prop; also resolves furniture keys (the tavern booth reuses `booth_seat`). */
export function getPropTexture(key: string): Promise<PIXI.Texture> | null {
  const url = PROP_URLS[key] ?? FURNITURE_URLS[key];
  return url ? loadTexture(url) : null;
}
