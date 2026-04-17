const TILE_SIZE = 32;

const BUILDING_TYPES = new Set([
  'home', 'shop', 'tavern', 'clinic', 'town_hall',
  'bakery', 'workshop', 'prison', 'pawnshop', 'divebar',
]);

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

    if (BUILDING_TYPES.has(loc.type)) {
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
      const outsideDoorY = doorTileY + 1;
      if (outsideDoorY >= 0 && outsideDoorY < mapHeight) {
        grid[outsideDoorY][doorTileX] = 0;
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
