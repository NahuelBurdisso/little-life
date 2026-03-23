/** Tile position in the Serene Village tileset (19 cols x 45 rows, 16x16 each) */
export interface TileRef {
  col: number;
  row: number;
}

// ---- Terrain ----
// Coordinates from visual inspection of serene-village.png (304x720)
export const TERRAIN: Record<string, TileRef[]> = {
  grass: [
    { col: 0, row: 0 },  // plain grass fill
    { col: 1, row: 0 },  // grass variant 2 (slightly different shade)
    { col: 2, row: 0 },  // grass variant 3 (with subtle detail)
    { col: 3, row: 0 },  // grass variant 4
  ],
  path: [
    { col: 0, row: 4 },  // path center
    { col: 1, row: 4 },  // path variant
    { col: 0, row: 3 },  // path top edge
    { col: 0, row: 5 },  // path bottom edge
    { col: 2, row: 4 },  // path left edge
    { col: 3, row: 4 },  // path right edge
  ],
  water: [
    { col: 0, row: 7 },  // water base fill
    { col: 1, row: 7 },  // water variant
  ],
  dirt: [
    { col: 4, row: 4 },  // dirt center
    { col: 5, row: 4 },  // dirt variant
  ],
};

// Map type codes from default.json tileLayer -> terrain keys
export const TILE_TYPE_MAP: Record<number, string> = {
  0: "grass",
  1: "path",
  2: "water",
};

// ---- Edge / Transition Tiles ----
// These are used for auto-tiling borders between terrain types
export const TERRAIN_EDGES: Record<string, Record<string, TileRef>> = {
  grass_to_water: {
    top: { col: 0, row: 6 },
    bottom: { col: 0, row: 8 },
    left: { col: 1, row: 6 },
    right: { col: 2, row: 6 },
    topLeft: { col: 3, row: 6 },
    topRight: { col: 4, row: 6 },
    bottomLeft: { col: 3, row: 7 },
    bottomRight: { col: 4, row: 7 },
  },
  grass_to_path: {
    top: { col: 0, row: 3 },
    bottom: { col: 0, row: 5 },
    left: { col: 1, row: 3 },
    right: { col: 2, row: 3 },
    topLeft: { col: 3, row: 3 },
    topRight: { col: 4, row: 3 },
    bottomLeft: { col: 3, row: 5 },
    bottomRight: { col: 4, row: 5 },
  },
};

// ---- Building Templates ----
export interface BuildingTemplate {
  name: string;
  widthTiles: number;
  heightTiles: number;
  /** Each entry: col/row = local position within the building, tileCol/tileRow = source in tileset */
  tiles: { col: number; row: number; tileCol: number; tileRow: number }[];
  entryOffset: { x: number; y: number };
}

export const BUILDINGS: Record<string, BuildingTemplate> = {
  // Red-roofed house (rows 18-22, cols 0-3) - small residential
  home: {
    name: "House",
    widthTiles: 4,
    heightTiles: 4,
    tiles: [
      // Row 0 - roof top
      { col: 0, row: 0, tileCol: 0, tileRow: 18 },
      { col: 1, row: 0, tileCol: 1, tileRow: 18 },
      { col: 2, row: 0, tileCol: 2, tileRow: 18 },
      { col: 3, row: 0, tileCol: 3, tileRow: 18 },
      // Row 1 - roof bottom
      { col: 0, row: 1, tileCol: 0, tileRow: 19 },
      { col: 1, row: 1, tileCol: 1, tileRow: 19 },
      { col: 2, row: 1, tileCol: 2, tileRow: 19 },
      { col: 3, row: 1, tileCol: 3, tileRow: 19 },
      // Row 2 - walls upper
      { col: 0, row: 2, tileCol: 0, tileRow: 20 },
      { col: 1, row: 2, tileCol: 1, tileRow: 20 },
      { col: 2, row: 2, tileCol: 2, tileRow: 20 },
      { col: 3, row: 2, tileCol: 3, tileRow: 20 },
      // Row 3 - walls lower / door
      { col: 0, row: 3, tileCol: 0, tileRow: 21 },
      { col: 1, row: 3, tileCol: 1, tileRow: 21 },
      { col: 2, row: 3, tileCol: 2, tileRow: 21 },
      { col: 3, row: 3, tileCol: 3, tileRow: 21 },
    ],
    entryOffset: { x: 1, y: 3 }, // door is roughly at col 1-2 of the building
  },

  // Blue-roofed building (rows 24-29, cols 0-4) - shop
  shop: {
    name: "Shop",
    widthTiles: 5,
    heightTiles: 5,
    tiles: [
      // Row 0 - roof peak
      { col: 0, row: 0, tileCol: 0, tileRow: 24 },
      { col: 1, row: 0, tileCol: 1, tileRow: 24 },
      { col: 2, row: 0, tileCol: 2, tileRow: 24 },
      { col: 3, row: 0, tileCol: 3, tileRow: 24 },
      { col: 4, row: 0, tileCol: 4, tileRow: 24 },
      // Row 1 - roof body
      { col: 0, row: 1, tileCol: 0, tileRow: 25 },
      { col: 1, row: 1, tileCol: 1, tileRow: 25 },
      { col: 2, row: 1, tileCol: 2, tileRow: 25 },
      { col: 3, row: 1, tileCol: 3, tileRow: 25 },
      { col: 4, row: 1, tileCol: 4, tileRow: 25 },
      // Row 2 - upper wall
      { col: 0, row: 2, tileCol: 0, tileRow: 26 },
      { col: 1, row: 2, tileCol: 1, tileRow: 26 },
      { col: 2, row: 2, tileCol: 2, tileRow: 26 },
      { col: 3, row: 2, tileCol: 3, tileRow: 26 },
      { col: 4, row: 2, tileCol: 4, tileRow: 26 },
      // Row 3 - lower wall / windows
      { col: 0, row: 3, tileCol: 0, tileRow: 27 },
      { col: 1, row: 3, tileCol: 1, tileRow: 27 },
      { col: 2, row: 3, tileCol: 2, tileRow: 27 },
      { col: 3, row: 3, tileCol: 3, tileRow: 27 },
      { col: 4, row: 3, tileCol: 4, tileRow: 27 },
      // Row 4 - ground / door
      { col: 0, row: 4, tileCol: 0, tileRow: 28 },
      { col: 1, row: 4, tileCol: 1, tileRow: 28 },
      { col: 2, row: 4, tileCol: 2, tileRow: 28 },
      { col: 3, row: 4, tileCol: 3, tileRow: 28 },
      { col: 4, row: 4, tileCol: 4, tileRow: 28 },
    ],
    entryOffset: { x: 2, y: 4 },
  },

  // Brown/tan roofed building (rows 30-35, cols 0-5) - tavern (wider)
  tavern: {
    name: "Tavern",
    widthTiles: 5,
    heightTiles: 5,
    tiles: [
      // Row 0 - roof peak
      { col: 0, row: 0, tileCol: 0, tileRow: 30 },
      { col: 1, row: 0, tileCol: 1, tileRow: 30 },
      { col: 2, row: 0, tileCol: 2, tileRow: 30 },
      { col: 3, row: 0, tileCol: 3, tileRow: 30 },
      { col: 4, row: 0, tileCol: 4, tileRow: 30 },
      // Row 1 - roof body
      { col: 0, row: 1, tileCol: 0, tileRow: 31 },
      { col: 1, row: 1, tileCol: 1, tileRow: 31 },
      { col: 2, row: 1, tileCol: 2, tileRow: 31 },
      { col: 3, row: 1, tileCol: 3, tileRow: 31 },
      { col: 4, row: 1, tileCol: 4, tileRow: 31 },
      // Row 2 - upper wall
      { col: 0, row: 2, tileCol: 0, tileRow: 32 },
      { col: 1, row: 2, tileCol: 1, tileRow: 32 },
      { col: 2, row: 2, tileCol: 2, tileRow: 32 },
      { col: 3, row: 2, tileCol: 3, tileRow: 32 },
      { col: 4, row: 2, tileCol: 4, tileRow: 32 },
      // Row 3 - lower wall / windows
      { col: 0, row: 3, tileCol: 0, tileRow: 33 },
      { col: 1, row: 3, tileCol: 1, tileRow: 33 },
      { col: 2, row: 3, tileCol: 2, tileRow: 33 },
      { col: 3, row: 3, tileCol: 3, tileRow: 33 },
      { col: 4, row: 3, tileCol: 4, tileRow: 33 },
      // Row 4 - ground / door
      { col: 0, row: 4, tileCol: 0, tileRow: 34 },
      { col: 1, row: 4, tileCol: 1, tileRow: 34 },
      { col: 2, row: 4, tileCol: 2, tileRow: 34 },
      { col: 3, row: 4, tileCol: 3, tileRow: 34 },
      { col: 4, row: 4, tileCol: 4, tileRow: 34 },
    ],
    entryOffset: { x: 2, y: 4 },
  },

  // Farm uses a simpler structure - barn style from rows 36-40
  farm: {
    name: "Farm",
    widthTiles: 4,
    heightTiles: 4,
    tiles: [
      // Row 0
      { col: 0, row: 0, tileCol: 0, tileRow: 36 },
      { col: 1, row: 0, tileCol: 1, tileRow: 36 },
      { col: 2, row: 0, tileCol: 2, tileRow: 36 },
      { col: 3, row: 0, tileCol: 3, tileRow: 36 },
      // Row 1
      { col: 0, row: 1, tileCol: 0, tileRow: 37 },
      { col: 1, row: 1, tileCol: 1, tileRow: 37 },
      { col: 2, row: 1, tileCol: 2, tileRow: 37 },
      { col: 3, row: 1, tileCol: 3, tileRow: 37 },
      // Row 2
      { col: 0, row: 2, tileCol: 0, tileRow: 38 },
      { col: 1, row: 2, tileCol: 1, tileRow: 38 },
      { col: 2, row: 2, tileCol: 2, tileRow: 38 },
      { col: 3, row: 2, tileCol: 3, tileRow: 38 },
      // Row 3
      { col: 0, row: 3, tileCol: 0, tileRow: 39 },
      { col: 1, row: 3, tileCol: 1, tileRow: 39 },
      { col: 2, row: 3, tileCol: 2, tileRow: 39 },
      { col: 3, row: 3, tileCol: 3, tileRow: 39 },
    ],
    entryOffset: { x: 1, y: 3 },
  },

  // Clinic - green-roofed variant (rows 40-44, cols 0-4)
  clinic: {
    name: "Clinic",
    widthTiles: 4,
    heightTiles: 4,
    tiles: [
      { col: 0, row: 0, tileCol: 0, tileRow: 40 },
      { col: 1, row: 0, tileCol: 1, tileRow: 40 },
      { col: 2, row: 0, tileCol: 2, tileRow: 40 },
      { col: 3, row: 0, tileCol: 3, tileRow: 40 },
      { col: 0, row: 1, tileCol: 0, tileRow: 41 },
      { col: 1, row: 1, tileCol: 1, tileRow: 41 },
      { col: 2, row: 1, tileCol: 2, tileRow: 41 },
      { col: 3, row: 1, tileCol: 3, tileRow: 41 },
      { col: 0, row: 2, tileCol: 0, tileRow: 42 },
      { col: 1, row: 2, tileCol: 1, tileRow: 42 },
      { col: 2, row: 2, tileCol: 2, tileRow: 42 },
      { col: 3, row: 2, tileCol: 3, tileRow: 42 },
      { col: 0, row: 3, tileCol: 0, tileRow: 43 },
      { col: 1, row: 3, tileCol: 1, tileRow: 43 },
      { col: 2, row: 3, tileCol: 2, tileRow: 43 },
      { col: 3, row: 3, tileCol: 3, tileRow: 43 },
    ],
    entryOffset: { x: 1, y: 3 },
  },

  // Town hall - larger building, re-using blue roof design with extra width
  town_hall: {
    name: "Town Hall",
    widthTiles: 5,
    heightTiles: 5,
    tiles: [
      // Uses same blue-roofed style as shop but with different wall details
      // Rows 24-28 cols 5-9 (second building in the blue row)
      { col: 0, row: 0, tileCol: 5, tileRow: 24 },
      { col: 1, row: 0, tileCol: 6, tileRow: 24 },
      { col: 2, row: 0, tileCol: 7, tileRow: 24 },
      { col: 3, row: 0, tileCol: 8, tileRow: 24 },
      { col: 4, row: 0, tileCol: 9, tileRow: 24 },
      { col: 0, row: 1, tileCol: 5, tileRow: 25 },
      { col: 1, row: 1, tileCol: 6, tileRow: 25 },
      { col: 2, row: 1, tileCol: 7, tileRow: 25 },
      { col: 3, row: 1, tileCol: 8, tileRow: 25 },
      { col: 4, row: 1, tileCol: 9, tileRow: 25 },
      { col: 0, row: 2, tileCol: 5, tileRow: 26 },
      { col: 1, row: 2, tileCol: 6, tileRow: 26 },
      { col: 2, row: 2, tileCol: 7, tileRow: 26 },
      { col: 3, row: 2, tileCol: 8, tileRow: 26 },
      { col: 4, row: 2, tileCol: 9, tileRow: 26 },
      { col: 0, row: 3, tileCol: 5, tileRow: 27 },
      { col: 1, row: 3, tileCol: 6, tileRow: 27 },
      { col: 2, row: 3, tileCol: 7, tileRow: 27 },
      { col: 3, row: 3, tileCol: 8, tileRow: 27 },
      { col: 4, row: 3, tileCol: 9, tileRow: 27 },
      { col: 0, row: 4, tileCol: 5, tileRow: 28 },
      { col: 1, row: 4, tileCol: 6, tileRow: 28 },
      { col: 2, row: 4, tileCol: 7, tileRow: 28 },
      { col: 3, row: 4, tileCol: 8, tileRow: 28 },
      { col: 4, row: 4, tileCol: 9, tileRow: 28 },
    ],
    entryOffset: { x: 2, y: 4 },
  },

  // Town square - open area, no building structure
  town_square: {
    name: "Town Square",
    widthTiles: 0,
    heightTiles: 0,
    tiles: [],
    entryOffset: { x: 0, y: 0 },
  },

  // Park - open area, no building structure
  park: {
    name: "Park",
    widthTiles: 0,
    heightTiles: 0,
    tiles: [],
    entryOffset: { x: 0, y: 0 },
  },
};

// ---- Props ----
// Single-tile props from the middle section of the tileset (rows 9-17)
export const PROPS: Record<string, TileRef> = {
  tree_oak: { col: 0, row: 9 },     // deciduous tree top-left (2x2 multi-tile, this is anchor)
  tree_pine: { col: 4, row: 9 },    // pine/conifer tree top-left (2x2 multi-tile, this is anchor)
  rock: { col: 0, row: 13 },        // grey boulder
  bush: { col: 2, row: 13 },        // green bush
  fence_h: { col: 0, row: 14 },     // horizontal fence segment
  fence_v: { col: 2, row: 14 },     // vertical fence segment
  sign: { col: 4, row: 14 },        // wooden signpost
  flower: { col: 0, row: 15 },      // flower patch
  flower_red: { col: 1, row: 15 },  // red flower variant
  flower_blue: { col: 2, row: 15 }, // blue flower variant
  stump: { col: 4, row: 13 },       // tree stump
  well: { col: 6, row: 13 },        // stone well
};

// Multi-tile props (trees are typically 2x2)
export interface MultiTileProp {
  name: string;
  widthTiles: number;
  heightTiles: number;
  tiles: { col: number; row: number; tileCol: number; tileRow: number }[];
}

export const MULTI_TILE_PROPS: Record<string, MultiTileProp> = {
  tree_oak: {
    name: "Oak Tree",
    widthTiles: 2,
    heightTiles: 2,
    tiles: [
      { col: 0, row: 0, tileCol: 0, tileRow: 9 },
      { col: 1, row: 0, tileCol: 1, tileRow: 9 },
      { col: 0, row: 1, tileCol: 0, tileRow: 10 },
      { col: 1, row: 1, tileCol: 1, tileRow: 10 },
    ],
  },
  tree_pine: {
    name: "Pine Tree",
    widthTiles: 2,
    heightTiles: 2,
    tiles: [
      { col: 0, row: 0, tileCol: 4, tileRow: 9 },
      { col: 1, row: 0, tileCol: 5, tileRow: 9 },
      { col: 0, row: 1, tileCol: 4, tileRow: 10 },
      { col: 1, row: 1, tileCol: 5, tileRow: 10 },
    ],
  },
  tree_willow: {
    name: "Willow Tree",
    widthTiles: 2,
    heightTiles: 3,
    tiles: [
      { col: 0, row: 0, tileCol: 8, tileRow: 9 },
      { col: 1, row: 0, tileCol: 9, tileRow: 9 },
      { col: 0, row: 1, tileCol: 8, tileRow: 10 },
      { col: 1, row: 1, tileCol: 9, tileRow: 10 },
      { col: 0, row: 2, tileCol: 8, tileRow: 11 },
      { col: 1, row: 2, tileCol: 9, tileRow: 11 },
    ],
  },
};

// ---- Tileset metadata ----
export const TILESET = {
  src: "/sprites/limezu/serene-village.png",
  tileSize: 16,
  columns: 19,
  rows: 45,
  pixelWidth: 304,
  pixelHeight: 720,
} as const;

/** Convert a TileRef to pixel coordinates within the tileset */
export function tileToPixel(ref: TileRef): { x: number; y: number } {
  return {
    x: ref.col * TILESET.tileSize,
    y: ref.row * TILESET.tileSize,
  };
}

/** Get a random variant from a terrain tile array */
export function randomTerrain(key: string): TileRef {
  const variants = TERRAIN[key];
  if (!variants || variants.length === 0) {
    return TERRAIN.grass[0]; // fallback
  }
  return variants[Math.floor(Math.random() * variants.length)];
}
