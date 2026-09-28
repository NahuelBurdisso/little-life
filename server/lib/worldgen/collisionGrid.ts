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

  // Map perimeter. Nothing else ever blocks it, so agents could path along the
  // outermost ring — visually "outside" the town. `TilemapRenderer` draws a dark
  // overgrowth band on exactly this ring so the wall is visible; the two must
  // stay in sync.
  for (let x = 0; x < mapWidth; x++) {
    grid[0][x] = 1;
    grid[mapHeight - 1][x] = 1;
  }
  for (let y = 0; y < mapHeight; y++) {
    grid[y][0] = 1;
    grid[y][mapWidth - 1] = 1;
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
      // The door tile and the one below it both sit *outside* the footprint
      // (entry_point is `y + height`), so clearing them only matters when a
      // neighbouring footprint would otherwise cover the approach.
      //
      // The old loop also cleared `doorTileY - 1`, which is the building's
      // bottom-centre wall. That punched a one-tile hole in the wall that led
      // nowhere: exterior A* could route into it and dead-end. Interiors are
      // reached through `computeInteriorPath` on the interior grid, not through
      // this one, so the notch bought nothing.
      const doorTileX = Math.floor(loc.entryX / TILE_SIZE);
      const doorTileY = Math.floor(loc.entryY / TILE_SIZE);
      for (const dy of [0, 1]) {
        const adjY = doorTileY + dy;
        // Never carve into the perimeter. A building on the last legal row has
        // its door at `mapHeight - 2`, so `dy = 1` would punch a walkable hole
        // through the border ring blocked above and let agents stand on the
        // tree line.
        if (adjY <= 0 || adjY >= mapHeight - 1) continue;
        if (doorTileX <= 0 || doorTileX >= mapWidth - 1) continue;
        grid[adjY][doorTileX] = 0;
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
