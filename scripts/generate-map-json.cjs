/**
 * Generate public/maps/default.json from data/maps/default.ts
 *
 * This creates a JSON version of the map data that the PixiJS canvas renderer
 * can fetch at runtime without importing TypeScript modules.
 *
 * Run: node scripts/generate-map-json.js
 */

const fs = require("fs");
const path = require("path");

const MAP_WIDTH = 40;
const MAP_HEIGHT = 30;
const TILE_SIZE = 32;

const MAP_LOCATIONS = [
  // 8 Homes
  { name: "Home 1", type: "home", x: 64, y: 64, width: 96, height: 96, entryX: 112, entryY: 160, capacity: 2, description: "A cozy farmhouse near the fields with a well-worn porch" },
  { name: "Home 2", type: "home", x: 224, y: 64, width: 96, height: 96, entryX: 272, entryY: 160, capacity: 2, description: "A warm house with flower boxes in every window" },
  { name: "Home 3", type: "home", x: 960, y: 64, width: 96, height: 96, entryX: 1008, entryY: 160, capacity: 2, description: "A tidy house with an herb garden out back" },
  { name: "Home 4", type: "home", x: 1120, y: 64, width: 96, height: 96, entryX: 1168, entryY: 160, capacity: 2, description: "A quiet residence near the clinic, always well-lit" },
  { name: "Home 5", type: "home", x: 960, y: 224, width: 96, height: 96, entryX: 1008, entryY: 320, capacity: 2, description: "A stately house befitting the town's leadership" },
  { name: "Home 6", type: "home", x: 64, y: 448, width: 96, height: 96, entryX: 112, entryY: 544, capacity: 2, description: "A cluttered but charming cottage with tools on the porch" },
  { name: "Home 7", type: "home", x: 1120, y: 448, width: 96, height: 96, entryX: 1168, entryY: 544, capacity: 2, description: "A small apartment above a workshop, decorated with paintings" },
  { name: "Home 8", type: "home", x: 1120, y: 608, width: 96, height: 96, entryX: 1168, entryY: 704, capacity: 2, description: "A bohemian loft filled with instruments and sheet music" },
  // 7 Public locations
  { name: "Rosa's General Store", type: "shop", x: 448, y: 64, width: 128, height: 128, entryX: 512, entryY: 192, capacity: 6, description: "The town's main shop, well-stocked and tidy" },
  { name: "The Rusty Lantern", type: "tavern", x: 640, y: 64, width: 160, height: 128, entryX: 720, entryY: 192, capacity: 10, description: "A cozy tavern where locals gather every evening" },
  { name: "Green Acres Farm", type: "farm", x: 32, y: 672, width: 256, height: 192, entryX: 160, entryY: 672, capacity: 4, description: "The town's main source of food, with fields stretching to the river" },
  { name: "Dr. Chen's Clinic", type: "clinic", x: 1120, y: 224, width: 128, height: 128, entryX: 1184, entryY: 352, capacity: 4, description: "A small but well-equipped medical clinic" },
  { name: "Town Hall", type: "town_hall", x: 448, y: 256, width: 160, height: 128, entryX: 528, entryY: 384, capacity: 8, description: "The center of town governance, with a bell tower visible from anywhere" },
  { name: "Town Square", type: "town_square", x: 448, y: 448, width: 192, height: 192, entryX: 544, entryY: 544, capacity: 20, description: "The heart of Little Life, where everyone meets under the old oak tree" },
  { name: "Riverside Park", type: "park", x: 704, y: 608, width: 192, height: 160, entryX: 800, entryY: 688, capacity: 12, description: "A peaceful park by the river with old willow trees and a stone bridge" },
];

// Generate collision grid
function generateCollisionGrid() {
  const grid = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    grid[y] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      grid[y][x] = 0;
    }
  }

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

    const entryTileX = Math.floor(loc.entryX / TILE_SIZE);
    const entryTileY = Math.floor(loc.entryY / TILE_SIZE);
    if (entryTileX >= 0 && entryTileX < MAP_WIDTH && entryTileY >= 0 && entryTileY < MAP_HEIGHT) {
      grid[entryTileY][entryTileX] = 0;
    }
  }

  let result = "";
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      result += grid[y][x].toString();
    }
  }
  return result;
}

// Build tile layer (numeric IDs for the renderer)
// 0 = grass, 1 = path, 2 = water edge
// Buildings get their own overlay from locations data
function generateTileLayer() {
  const tiles = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const row = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
      // Default: grass
      let tile = 0;

      // Paths: horizontal and vertical through town center
      // Horizontal path at y=12 (through town hall area)
      if (y === 12 || y === 13) tile = 1;
      // Vertical path at x=16-17 (main street)
      if (x === 16 || x === 17) tile = 1;
      // Path around town square
      if (x >= 13 && x <= 20 && (y === 14 || y === 20)) tile = 1;
      if ((x === 13 || x === 20) && y >= 14 && y <= 20) tile = 1;

      // Water: bottom edge of map (river)
      if (y >= 28) tile = 2;
      // River running through the right side
      if (x >= 22 && x <= 23 && y >= 20) tile = 2;

      row.push(tile);
    }
    tiles.push(row);
  }
  return tiles;
}

// Build the JSON
const mapData = {
  mapWidth: MAP_WIDTH,
  mapHeight: MAP_HEIGHT,
  tileSize: TILE_SIZE,
  pixelWidth: MAP_WIDTH * TILE_SIZE,
  pixelHeight: MAP_HEIGHT * TILE_SIZE,
  collisionGrid: generateCollisionGrid(),
  tileLayer: generateTileLayer(),
  tileTypes: {
    0: { name: "grass", tileset: "terrain", tileIndex: 0 },
    1: { name: "path", tileset: "terrain", tileIndex: 1 },
    2: { name: "water", tileset: "terrain", tileIndex: 2 },
  },
  locations: MAP_LOCATIONS.map((loc) => ({
    name: loc.name,
    type: loc.type,
    x: loc.x,
    y: loc.y,
    width: loc.width,
    height: loc.height,
    entryX: loc.entryX,
    entryY: loc.entryY,
    capacity: loc.capacity,
    description: loc.description,
  })),
  tilesets: {
    terrain: { src: "/tilesets/terrain.png", tileSize: 32, columns: 8 },
    buildings: { src: "/tilesets/buildings.png", tileSize: 32, columns: 8 },
  },
};

const outPath = path.join(__dirname, "..", "public", "maps", "default.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(mapData, null, 2));
console.log(`Written: ${outPath} (${fs.statSync(outPath).size} bytes)`);
