export interface MapLocation {
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  entryX: number;
  entryY: number;
  capacity: number;
  description: string;
}

export const MAP_WIDTH = 40;
export const MAP_HEIGHT = 30;
export const TILE_SIZE = 32;

// Map pixel dimensions: 1280 x 960

export const MAP_LOCATIONS: MapLocation[] = [
  // === 8 Homes (spread around the perimeter and residential areas) ===
  {
    name: "Home 1",
    type: "home",
    x: 64,
    y: 64,
    width: 96,
    height: 96,
    entryX: 112,
    entryY: 160,
    capacity: 2,
    description: "A cozy farmhouse near the fields with a well-worn porch",
  },
  {
    name: "Home 2",
    type: "home",
    x: 224,
    y: 64,
    width: 96,
    height: 96,
    entryX: 272,
    entryY: 160,
    capacity: 2,
    description: "A warm house with flower boxes in every window",
  },
  {
    name: "Home 3",
    type: "home",
    x: 960,
    y: 64,
    width: 96,
    height: 96,
    entryX: 1008,
    entryY: 160,
    capacity: 2,
    description: "A tidy house with an herb garden out back",
  },
  {
    name: "Home 4",
    type: "home",
    x: 1120,
    y: 64,
    width: 96,
    height: 96,
    entryX: 1168,
    entryY: 160,
    capacity: 2,
    description: "A quiet residence near the clinic, always well-lit",
  },
  {
    name: "Home 5",
    type: "home",
    x: 960,
    y: 224,
    width: 96,
    height: 96,
    entryX: 1008,
    entryY: 320,
    capacity: 2,
    description: "A stately house befitting the town's leadership",
  },
  {
    name: "Home 6",
    type: "home",
    x: 64,
    y: 448,
    width: 96,
    height: 96,
    entryX: 112,
    entryY: 544,
    capacity: 2,
    description: "A cluttered but charming cottage with tools on the porch",
  },
  {
    name: "Home 7",
    type: "home",
    x: 1120,
    y: 448,
    width: 96,
    height: 96,
    entryX: 1168,
    entryY: 544,
    capacity: 2,
    description: "A small apartment above a workshop, decorated with paintings",
  },
  {
    name: "Home 8",
    type: "home",
    x: 1120,
    y: 608,
    width: 96,
    height: 96,
    entryX: 1168,
    entryY: 704,
    capacity: 2,
    description: "A bohemian loft filled with instruments and sheet music",
  },

  // === 7 Public Locations ===
  {
    name: "Rosa's General Store",
    type: "shop",
    x: 448,
    y: 64,
    width: 128,
    height: 128,
    entryX: 512,
    entryY: 192,
    capacity: 6,
    description: "The town's main shop, well-stocked and tidy",
  },
  {
    name: "The Rusty Lantern",
    type: "tavern",
    x: 640,
    y: 64,
    width: 160,
    height: 128,
    entryX: 720,
    entryY: 192,
    capacity: 10,
    description: "A cozy tavern where locals gather every evening",
  },
  {
    name: "Green Acres Farm",
    type: "farm",
    x: 32,
    y: 672,
    width: 256,
    height: 192,
    entryX: 160,
    entryY: 672,
    capacity: 4,
    description: "The town's main source of food, with fields stretching to the river",
  },
  {
    name: "Dr. Chen's Clinic",
    type: "clinic",
    x: 1120,
    y: 224,
    width: 128,
    height: 128,
    entryX: 1184,
    entryY: 352,
    capacity: 4,
    description: "A small but well-equipped medical clinic",
  },
  {
    name: "Town Hall",
    type: "town_hall",
    x: 448,
    y: 256,
    width: 160,
    height: 128,
    entryX: 528,
    entryY: 384,
    capacity: 8,
    description: "The center of town governance, with a bell tower visible from anywhere",
  },
  {
    name: "Town Square",
    type: "town_square",
    x: 448,
    y: 448,
    width: 192,
    height: 192,
    entryX: 544,
    entryY: 544,
    capacity: 20,
    description: "The heart of Little Life, where everyone meets under the old oak tree",
  },
  {
    name: "Riverside Park",
    type: "park",
    x: 704,
    y: 608,
    width: 192,
    height: 160,
    entryX: 800,
    entryY: 688,
    capacity: 12,
    description: "A peaceful park by the river with old willow trees and a stone bridge",
  },
];

/**
 * Generate a collision grid for the map.
 * "0" = walkable, "1" = blocked (building interior).
 * Outdoor areas, paths, and entry points are walkable.
 */
export function generateCollisionGrid(): string {
  // Start with all walkable
  const grid: number[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    grid[y] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      grid[y][x] = 0;
    }
  }

  // Mark building interiors as blocked (shrink by 1 tile on each side for walls)
  for (const loc of MAP_LOCATIONS) {
    const tileX = Math.floor(loc.x / TILE_SIZE);
    const tileY = Math.floor(loc.y / TILE_SIZE);
    const tileW = Math.floor(loc.width / TILE_SIZE);
    const tileH = Math.floor(loc.height / TILE_SIZE);

    for (let dy = 0; dy < tileH; dy++) {
      for (let dx = 0; dx < tileW; dx++) {
        const gx = tileX + dx;
        const gy = tileY + dy;
        if (gx >= 0 && gx < MAP_WIDTH && gy >= 0 && gy < MAP_HEIGHT) {
          grid[gy][gx] = 1;
        }
      }
    }

    // Carve out the entry point as walkable
    const entryTileX = Math.floor(loc.entryX / TILE_SIZE);
    const entryTileY = Math.floor(loc.entryY / TILE_SIZE);
    if (
      entryTileX >= 0 &&
      entryTileX < MAP_WIDTH &&
      entryTileY >= 0 &&
      entryTileY < MAP_HEIGHT
    ) {
      grid[entryTileY][entryTileX] = 0;
    }
  }

  // Flatten to string
  let result = "";
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      result += grid[y][x].toString();
    }
  }

  return result;
}

export const DEFAULT_COLLISION_GRID = generateCollisionGrid();
