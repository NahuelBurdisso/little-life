import { ENCLOSED_BUILDING_TYPES } from './buildingTemplates';
import { TILE as TILE_SIZE } from './config';

interface CollisionLoc {
  x: number;
  y: number;
  width: number;
  height: number;
  entryX: number;
  entryY: number;
  type: string;
}

/**
 * Generate a row-major '0'/'1' collision grid string from location data.
 * Pure function — no side effects.
 */
export function generateCollisionGridForLocations(
  locs: CollisionLoc[],
  mapWidth: number,
  mapHeight: number,
): string {
  const grid: number[][] = [];
  for (let y = 0; y < mapHeight; y++) {
    grid[y] = [];
    for (let x = 0; x < mapWidth; x++) {
      grid[y][x] = 0;
    }
  }

  for (const loc of locs) {
    const tileX = Math.floor(loc.x / TILE_SIZE);
    const tileY = Math.floor(loc.y / TILE_SIZE);
    const tileW = Math.ceil(loc.width / TILE_SIZE);
    const tileH = Math.ceil(loc.height / TILE_SIZE);

    if (ENCLOSED_BUILDING_TYPES.has(loc.type)) {
      for (let x = tileX; x < tileX + tileW; x++) {
        for (let y = tileY; y < tileY + tileH; y++) {
          if (x < 0 || x >= mapWidth || y < 0 || y >= mapHeight) continue;
          grid[y][x] = 1;
        }
      }
      const doorTileX = Math.floor(loc.entryX / TILE_SIZE);
      const doorTileY = Math.floor(loc.entryY / TILE_SIZE);
      if (doorTileX >= 0 && doorTileX < mapWidth && doorTileY >= 0 && doorTileY < mapHeight) {
        grid[doorTileY][doorTileX] = 0;
      }
      // Unblock tile south of door (exit direction) and the tile above (approach path)
      for (const dy of [-1, 1]) {
        const adjY = doorTileY + dy;
        if (adjY >= 0 && adjY < mapHeight && doorTileX >= 0 && doorTileX < mapWidth) {
          grid[adjY][doorTileX] = 0;
        }
      }
    }
  }

  let result = '';
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      result += grid[y][x].toString();
    }
  }
  return result;
}
