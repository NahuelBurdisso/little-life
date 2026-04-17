import { ENCLOSED_BUILDING_TYPES } from '../lib/worldgen/buildingTemplates';

export const DEFAULT_MAP_WIDTH = 60;
export const DEFAULT_MAP_HEIGHT = 45;
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
  // ═══════════════════════════════════════════════════════════════════════════
  // NORTH RESIDENTIAL — Row 1 (y=64)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "Home 1",
    type: "home",
    x: 96, y: 64, width: 96, height: 96,
    entryX: 144, entryY: 160,
    capacity: 2,
    description: "A cozy farmhouse near the fields with a well-worn porch",
  },
  {
    name: "Home 2",
    type: "home",
    x: 288, y: 64, width: 96, height: 96,
    entryX: 336, entryY: 160,
    capacity: 2,
    description: "A warm house with flower boxes in every window",
  },
  {
    name: "Home 3",
    type: "home",
    x: 544, y: 64, width: 96, height: 96,
    entryX: 592, entryY: 160,
    capacity: 2,
    description: "A tidy house with an herb garden out back",
  },
  {
    name: "Home 4",
    type: "home",
    x: 1152, y: 64, width: 96, height: 96,
    entryX: 1200, entryY: 160,
    capacity: 2,
    description: "A quiet residence near the clinic, always well-lit",
  },
  {
    name: "Home 5",
    type: "home",
    x: 1408, y: 64, width: 96, height: 96,
    entryX: 1456, entryY: 160,
    capacity: 2,
    description: "A stately house befitting the town's leadership",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // COMMERCIAL STRIP — North of town square (y=288)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "Priya's Bakery",
    type: "bakery",
    x: 96, y: 288, width: 160, height: 128,
    entryX: 176, entryY: 416,
    capacity: 4,
    description: "A warm bakery that fills the street with the smell of fresh bread every morning. Priya is here before dawn.",
  },
  {
    name: "Rosa's General Store",
    type: "shop",
    x: 352, y: 288, width: 160, height: 128,
    entryX: 432, entryY: 416,
    capacity: 6,
    description: "The town's main shop, well-stocked and tidy. Rosa runs a tight operation with Lucia's help.",
  },
  {
    name: "The Rusty Lantern",
    type: "tavern",
    x: 1088, y: 288, width: 192, height: 128,
    entryX: 1184, entryY: 416,
    capacity: 10,
    description: "A cozy tavern where locals gather every evening. Marco serves drinks behind a weathered oak bar while Diego plays in the corner.",
  },
  {
    name: "Dr. Petrov's Clinic",
    type: "clinic",
    x: 1376, y: 288, width: 160, height: 128,
    entryX: 1456, entryY: 416,
    capacity: 4,
    description: "A small but well-equipped medical clinic. Sofia and Omar keep the town healthy, one patient at a time.",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TOWN CENTER — Square + civic buildings (y=480)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "Carlos' Workshop",
    type: "workshop",
    x: 96, y: 480, width: 160, height: 128,
    entryX: 176, entryY: 608,
    capacity: 3,
    description: "A chaotic but functional workshop filled with tools, half-finished repairs, and sawdust. Carlos fixes everything here.",
  },
  {
    name: "Town Hall",
    type: "town_hall",
    x: 352, y: 480, width: 192, height: 160,
    entryX: 448, entryY: 640,
    capacity: 8,
    description: "The center of town governance, with a bell tower visible from anywhere. Mayor Park holds meetings here every morning.",
  },
  {
    name: "Town Square",
    type: "town_square",
    x: 640, y: 448, width: 288, height: 256,
    entryX: 784, entryY: 576,
    capacity: 20,
    description: "The heart of Little Life, where everyone meets under the old oak tree. A fountain sits in the center.",
  },
  {
    name: "Town Jail",
    type: "prison",
    x: 1088, y: 480, width: 160, height: 128,
    entryX: 1168, entryY: 608,
    capacity: 4,
    description: "A small stone jail behind the tavern. Rarely used, but the cells are always ready. The constable has the key.",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SOUTH RESIDENTIAL — Row 2 (y=768)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "Home 6",
    type: "home",
    x: 96, y: 768, width: 96, height: 96,
    entryX: 144, entryY: 864,
    capacity: 2,
    description: "A cluttered but charming cottage with tools on the porch",
  },
  {
    name: "Home 7",
    type: "home",
    x: 288, y: 768, width: 96, height: 96,
    entryX: 336, entryY: 864,
    capacity: 2,
    description: "A small apartment above a workshop, decorated with paintings",
  },
  {
    name: "Home 8",
    type: "home",
    x: 1152, y: 768, width: 96, height: 96,
    entryX: 1200, entryY: 864,
    capacity: 2,
    description: "A bohemian loft filled with instruments and sheet music",
  },
  {
    name: "Home 9",
    type: "home",
    x: 1408, y: 768, width: 96, height: 96,
    entryX: 1456, entryY: 864,
    capacity: 2,
    description: "A spartan house with heavy curtains and a police scanner on the kitchen table",
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SOUTH — Farm and Park (y=960)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: "Green Acres Farm",
    type: "farm",
    x: 96, y: 960, width: 320, height: 224,
    entryX: 256, entryY: 960,
    capacity: 4,
    description: "The town's main source of food, with fields stretching to the river. Elena and James work the land from dawn to dusk.",
  },
  {
    name: "Riverside Park",
    type: "park",
    x: 640, y: 992, width: 256, height: 192,
    entryX: 768, entryY: 1088,
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
      return null;
    default:
      return null;
  }
}

// ─── Exported data ───────────────────────────────────────────────────────────

// Re-export from canonical location
import type { LocationSeed } from '../lib/worldgen/types';
export type { LocationSeed } from '../lib/worldgen/types';

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
  for (let y = 0; y < DEFAULT_MAP_HEIGHT; y++) {
    grid[y] = [];
    for (let x = 0; x < DEFAULT_MAP_WIDTH; x++) {
      grid[y][x] = 0;
    }
  }

  const BUILDING_TYPES = ENCLOSED_BUILDING_TYPES;

  for (const loc of MAP_LOCATIONS) {
    const tileX = Math.floor(loc.x / TILE_SIZE);
    const tileY = Math.floor(loc.y / TILE_SIZE);
    const tileW = Math.ceil(loc.width / TILE_SIZE);
    const tileH = Math.ceil(loc.height / TILE_SIZE);

    if (BUILDING_TYPES.has(loc.type)) {
      // Mark ALL building tiles as blocked (walls + interior)
      // Agents enter via the door → interior transition system, not A* through interiors
      for (let x = tileX; x < tileX + tileW; x++) {
        for (let y = tileY; y < tileY + tileH; y++) {
          if (x < 0 || x >= DEFAULT_MAP_WIDTH || y < 0 || y >= DEFAULT_MAP_HEIGHT) continue;
          grid[y][x] = 1;
        }
      }

      // Door tile stays walkable — this is the only entry point for pathfinding
      const doorTileX = Math.floor(loc.entryX / TILE_SIZE);
      const doorTileY = Math.floor(loc.entryY / TILE_SIZE);
      if (doorTileX >= 0 && doorTileX < DEFAULT_MAP_WIDTH && doorTileY >= 0 && doorTileY < DEFAULT_MAP_HEIGHT) {
        grid[doorTileY][doorTileX] = 0;
      }
      // Also ensure the tile just outside the door is walkable (approach path)
      const outsideDoorY = doorTileY + 1;
      if (outsideDoorY >= 0 && outsideDoorY < DEFAULT_MAP_HEIGHT) {
        grid[outsideDoorY][doorTileX] = 0;
      }
    }
  }

  let result = "";
  for (let y = 0; y < DEFAULT_MAP_HEIGHT; y++) {
    for (let x = 0; x < DEFAULT_MAP_WIDTH; x++) {
      result += grid[y][x].toString();
    }
  }
  return result;
}

export const COLLISION_GRID = generateCollisionGrid();

// --- Dynamic home generation for setup wizard ---

export const HOME_DESCRIPTIONS = [
  "A cozy farmhouse with a well-worn porch",
  "A warm house with flower boxes in every window",
  "A tidy house with an herb garden out back",
  "A quiet residence, always well-lit",
  "A stately house with a polished front door",
  "A cluttered but charming cottage",
  "A small apartment decorated with paintings",
  "A bohemian loft filled with instruments",
  "A spartan house with heavy curtains",
  "A bright cottage with a red roof",
  "A stone house with ivy-covered walls",
  "A modest cabin near the edge of town",
  "A cheerful yellow house with a garden",
  "A renovated barn turned cozy home",
  "A two-story house with a balcony",
];

// Residential placement zones (x ranges for north and south rows)
const RESIDENTIAL_ROWS = [
  { y: 64, entryY: 160 },   // North row
  { y: 768, entryY: 864 },  // South row
];

const HOME_X_START = 96;
const HOME_X_SPACING = 192; // space between home centers
const HOME_WIDTH = 96;
const HOME_HEIGHT = 96;
const MAX_HOMES_PER_ROW = 8; // fits in the 1920px map width

export function generateHomes(count: number): MapLocationRaw[] {
  const homes: MapLocationRaw[] = [];
  for (let i = 0; i < count; i++) {
    const row = RESIDENTIAL_ROWS[Math.floor(i / MAX_HOMES_PER_ROW) % RESIDENTIAL_ROWS.length];
    const col = i % MAX_HOMES_PER_ROW;
    const x = HOME_X_START + col * HOME_X_SPACING;

    homes.push({
      name: `Home ${i + 1}`,
      type: 'home',
      x,
      y: row.y,
      width: HOME_WIDTH,
      height: HOME_HEIGHT,
      entryX: x + HOME_WIDTH / 2,
      entryY: row.entryY,
      capacity: 2,
      description: HOME_DESCRIPTIONS[i % HOME_DESCRIPTIONS.length],
    });
  }
  return homes;
}

// Public buildings (non-residential) — exported separately for setup wizard
export function getPublicBuildings(): MapLocationRaw[] {
  return MAP_LOCATIONS.filter(l => l.type !== 'home');
}

export function generateLocationsForAgentCount(agentCount: number, homeCountOverride?: number): LocationSeed[] {
  const homesNeeded = homeCountOverride ?? Math.ceil(agentCount / 2);
  const homes = generateHomes(homesNeeded);
  const publicBuildings = getPublicBuildings();
  const allBuildings = [...homes, ...publicBuildings];

  return allBuildings.map(loc => ({
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
}

export function generateCollisionGridForLocations(
  locs: MapLocationRaw[],
  mapWidth: number = DEFAULT_MAP_WIDTH,
  mapHeight: number = DEFAULT_MAP_HEIGHT,
): string {
  const grid: number[][] = [];
  for (let y = 0; y < mapHeight; y++) {
    grid[y] = [];
    for (let x = 0; x < mapWidth; x++) {
      grid[y][x] = 0;
    }
  }

  const BUILDING_TYPES = ENCLOSED_BUILDING_TYPES;

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

  let result = "";
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      result += grid[y][x].toString();
    }
  }
  return result;
}

// ─── Backward-compat re-exports ───────────────────────────────────────────────
/** @deprecated Use DEFAULT_MAP_WIDTH. Retained for one release for backward compatibility. */
export const MAP_WIDTH = DEFAULT_MAP_WIDTH;
/** @deprecated Use DEFAULT_MAP_HEIGHT. */
export const MAP_HEIGHT = DEFAULT_MAP_HEIGHT;
