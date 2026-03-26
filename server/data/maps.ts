export const MAP_WIDTH = 40;
export const MAP_HEIGHT = 30;
export const TILE_SIZE = 32;

interface MapLocationRaw {
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

const MAP_LOCATIONS: MapLocationRaw[] = [
  // === 8 Homes ===
  {
    name: "Home 1",
    type: "home",
    x: 64, y: 64, width: 96, height: 96,
    entryX: 112, entryY: 160,
    capacity: 2,
    description: "A cozy farmhouse near the fields with a well-worn porch",
  },
  {
    name: "Home 2",
    type: "home",
    x: 224, y: 64, width: 96, height: 96,
    entryX: 272, entryY: 160,
    capacity: 2,
    description: "A warm house with flower boxes in every window",
  },
  {
    name: "Home 3",
    type: "home",
    x: 960, y: 64, width: 96, height: 96,
    entryX: 1008, entryY: 160,
    capacity: 2,
    description: "A tidy house with an herb garden out back",
  },
  {
    name: "Home 4",
    type: "home",
    x: 1120, y: 64, width: 96, height: 96,
    entryX: 1168, entryY: 160,
    capacity: 2,
    description: "A quiet residence near the clinic, always well-lit",
  },
  {
    name: "Home 5",
    type: "home",
    x: 960, y: 224, width: 96, height: 96,
    entryX: 1008, entryY: 320,
    capacity: 2,
    description: "A stately house befitting the town's leadership",
  },
  {
    name: "Home 6",
    type: "home",
    x: 64, y: 448, width: 96, height: 96,
    entryX: 112, entryY: 544,
    capacity: 2,
    description: "A cluttered but charming cottage with tools on the porch",
  },
  {
    name: "Home 7",
    type: "home",
    x: 1120, y: 448, width: 96, height: 96,
    entryX: 1168, entryY: 544,
    capacity: 2,
    description: "A small apartment above a workshop, decorated with paintings",
  },
  {
    name: "Home 8",
    type: "home",
    x: 1120, y: 608, width: 96, height: 96,
    entryX: 1168, entryY: 704,
    capacity: 2,
    description: "A bohemian loft filled with instruments and sheet music",
  },
  {
    name: "Home 9",
    type: "home",
    x: 640, y: 448, width: 96, height: 96,
    entryX: 688, entryY: 544,
    capacity: 2,
    description: "A spartan house with heavy curtains and a police scanner on the kitchen table",
  },
  // === Public Buildings ===
  {
    name: "Rosa's General Store",
    type: "shop",
    x: 448, y: 64, width: 128, height: 128,
    entryX: 512, entryY: 192,
    capacity: 6,
    description: "The town's main shop, well-stocked and tidy. Rosa runs a tight operation with Lucia and Priya's baked goods on display.",
  },
  {
    name: "The Rusty Lantern",
    type: "tavern",
    x: 640, y: 64, width: 160, height: 128,
    entryX: 720, entryY: 192,
    capacity: 10,
    description: "A cozy tavern where locals gather every evening. Marco serves drinks behind a weathered oak bar while Diego plays in the corner.",
  },
  {
    name: "Green Acres Farm",
    type: "farm",
    x: 32, y: 672, width: 256, height: 192,
    entryX: 160, entryY: 672,
    capacity: 4,
    description: "The town's main source of food, with fields stretching to the river. Elena and James work the land from dawn to dusk.",
  },
  {
    name: "Dr. Petrov's Clinic",
    type: "clinic",
    x: 1120, y: 224, width: 128, height: 128,
    entryX: 1184, entryY: 352,
    capacity: 4,
    description: "A small but well-equipped medical clinic. Sofia and Omar keep the town healthy, one patient at a time.",
  },
  {
    name: "Town Hall",
    type: "town_hall",
    x: 448, y: 256, width: 160, height: 128,
    entryX: 528, entryY: 384,
    capacity: 8,
    description: "The center of town governance, with a bell tower visible from anywhere. Mayor Park holds meetings here every morning.",
  },
  // === New Buildings ===
  {
    name: "Priya's Bakery",
    type: "bakery",
    x: 224, y: 224, width: 128, height: 128,
    entryX: 288, entryY: 352,
    capacity: 4,
    description: "A warm bakery that fills the street with the smell of fresh bread every morning. Priya is here before dawn.",
  },
  {
    name: "Carlos' Workshop",
    type: "workshop",
    x: 64, y: 224, width: 128, height: 128,
    entryX: 128, entryY: 352,
    capacity: 3,
    description: "A chaotic but functional workshop filled with tools, half-finished repairs, and sawdust. Carlos fixes everything here.",
  },
  {
    name: "Town Jail",
    type: "prison",
    x: 640, y: 256, width: 128, height: 128,
    entryX: 704, entryY: 384,
    capacity: 4,
    description: "A small stone jail behind Town Hall. Rarely used, but the cells are always ready. The mayor has the key.",
  },
  // === Open Areas ===
  {
    name: "Town Square",
    type: "town_square",
    x: 448, y: 448, width: 192, height: 192,
    entryX: 544, entryY: 544,
    capacity: 20,
    description: "The heart of Little Life, where everyone meets under the old oak tree",
  },
  {
    name: "Riverside Park",
    type: "park",
    x: 704, y: 608, width: 192, height: 160,
    entryX: 800, entryY: 688,
    capacity: 12,
    description: "A peaceful park by the river with old willow trees and a stone bridge",
  },
];

// ─── Services & operating hours helpers ──────────────────────────────────────

function getDefaultServices(
  type: string
): Array<{ needSatisfied: string; amount: number; cost: number; itemRequired: string | null }> {
  switch (type) {
    case "home":
      return [
        { needSatisfied: "energy", amount: 8, cost: 0, itemRequired: null },
        { needSatisfied: "comfort", amount: 5, cost: 0, itemRequired: null },
        { needSatisfied: "hunger", amount: 10, cost: 0, itemRequired: "food_raw" },
      ];
    case "shop":
      return [{ needSatisfied: "hunger", amount: 15, cost: 6, itemRequired: null }];
    case "tavern":
      return [
        { needSatisfied: "social", amount: 6, cost: 0, itemRequired: null },
        { needSatisfied: "fun", amount: 8, cost: 4, itemRequired: null },
        { needSatisfied: "hunger", amount: 8, cost: 5, itemRequired: null },
      ];
    case "farm":
      return [];
    case "clinic":
      return [{ needSatisfied: "energy", amount: 5, cost: 12, itemRequired: null }];
    case "town_square":
      return [
        { needSatisfied: "social", amount: 4, cost: 0, itemRequired: null },
        { needSatisfied: "fun", amount: 3, cost: 0, itemRequired: null },
      ];
    case "town_hall":
      return [];
    case "park":
      return [
        { needSatisfied: "fun", amount: 5, cost: 0, itemRequired: null },
        { needSatisfied: "comfort", amount: 3, cost: 0, itemRequired: null },
      ];
    case "bakery":
      return [{ needSatisfied: "hunger", amount: 12, cost: 5, itemRequired: null }];
    case "workshop":
      return [];
    case "prison":
      return [];
    default:
      return [];
  }
}

function getOperatingHours(type: string): { open: number; close: number } | null {
  switch (type) {
    case "shop":
      return { open: 8, close: 18 };
    case "tavern":
      return { open: 16, close: 23 };
    case "clinic":
      return { open: 8, close: 17 };
    case "town_hall":
      return { open: 9, close: 17 };
    case "bakery":
      return { open: 4, close: 14 };
    case "workshop":
      return { open: 7, close: 18 };
    case "prison":
      return null; // always accessible
    default:
      return null;
  }
}

// ─── Exported data ───────────────────────────────────────────────────────────

export interface LocationSeed {
  name: string;
  type: string;
  position: { x: number; y: number; width: number; height: number };
  entry_point: { x: number; y: number };
  capacity: number;
  current_occupants: number[];
  operating_hours: { open: number; close: number } | null;
  services: Array<{
    needSatisfied: string;
    amount: number;
    cost: number;
    itemRequired: string | null;
  }>;
  description: string;
  owner: null;
}

export const LOCATIONS: LocationSeed[] = MAP_LOCATIONS.map((loc) => ({
  name: loc.name,
  type: loc.type,
  position: { x: loc.x, y: loc.y, width: loc.width, height: loc.height },
  entry_point: { x: loc.entryX, y: loc.entryY },
  capacity: loc.capacity,
  current_occupants: [],
  operating_hours: getOperatingHours(loc.type),
  services: getDefaultServices(loc.type),
  description: loc.description,
  owner: null,
}));

// ─── Collision grid ──────────────────────────────────────────────────────────

function generateCollisionGrid(): string {
  const grid: number[][] = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    grid[y] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      grid[y][x] = 0;
    }
  }

  const BUILDING_TYPES = new Set(['home', 'shop', 'tavern', 'clinic', 'town_hall', 'bakery', 'workshop', 'prison']);

  for (const loc of MAP_LOCATIONS) {
    const tileX = Math.floor(loc.x / TILE_SIZE);
    const tileY = Math.floor(loc.y / TILE_SIZE);
    const tileW = Math.ceil(loc.width / TILE_SIZE);
    const tileH = Math.ceil(loc.height / TILE_SIZE);

    if (BUILDING_TYPES.has(loc.type)) {
      // Buildings: perimeter tiles = 1 (walls), interior tiles = 0 (walkable)
      for (let x = tileX; x < tileX + tileW; x++) {
        for (let y = tileY; y < tileY + tileH; y++) {
          if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) continue;
          const isPerimeter =
            x === tileX || x === tileX + tileW - 1 ||
            y === tileY || y === tileY + tileH - 1;
          grid[y][x] = isPerimeter ? 1 : 0;
        }
      }

      // Door tile at entry point — ensure walkable
      const doorTileX = Math.floor(loc.entryX / TILE_SIZE);
      const doorTileY = Math.floor(loc.entryY / TILE_SIZE);
      if (doorTileX >= 0 && doorTileX < MAP_WIDTH && doorTileY >= 0 && doorTileY < MAP_HEIGHT) {
        grid[doorTileY][doorTileX] = 0;
      }
    }
    // Open areas (farm, town_square, park) remain fully walkable (all 0s)
  }

  let result = "";
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      result += grid[y][x].toString();
    }
  }
  return result;
}

export const COLLISION_GRID = generateCollisionGrid();
