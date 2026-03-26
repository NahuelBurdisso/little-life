/** Tile position in the Serene Village tileset (19 cols x 45 rows, 16x16 each) */
export interface TileRef {
  col: number;
  row: number;
}

// ---- Terrain ----
// Note: Grass tiles in this tileset are mostly transparent overlays.
// The actual grass color comes from the PixiJS background (0x4a8c3f).
// Path tiles are stone/brick at rows 3-4. Water uses the animated strip.
export const TERRAIN: Record<string, TileRef[]> = {
  path: [
    { col: 0, row: 3 },  // stone path variant A
    { col: 1, row: 3 },  // stone path variant B
    { col: 0, row: 4 },  // stone path variant C
  ],
  water: [
    { col: 3, row: 4 },  // water base (used only as fallback; animated strip preferred)
  ],
};

// Map type codes from default.json tileLayer -> terrain keys
export const TILE_TYPE_MAP: Record<number, string> = {
  0: "grass",
  1: "path",
  2: "water",
};

// ---- Building Templates ----
export interface BuildingTemplate {
  name: string;
  widthTiles: number;
  heightTiles: number;
  tiles: { col: number; row: number; tileCol: number; tileRow: number }[];
  entryOffset: { x: number; y: number };
}

// Building layout in tileset (verified via pixel analysis):
//   Small buildings: 3 wide × 4 tall (peaked roof)
//     Red:   rows 21-24   (variants at cols 0-2, 3-5, 6-8)
//     Green: rows 29-32   (variants at cols 0-2, 3-5, 6-8)
//     Blue:  rows 37-40   (variants at cols 0-2, 3-5, 6-8)
//   Large buildings: 5 wide × 4 tall
//     Red:   rows 25-28   (variants at cols 0-4, 5-9)
//     Green: rows 33-36   (variants at cols 0-4, 5-9)
//     Blue:  rows 41-44   (variants at cols 0-4, 5-9)

function makeSmall(startRow: number, startCol: number): BuildingTemplate["tiles"] {
  const tiles: BuildingTemplate["tiles"] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      tiles.push({ col: c, row: r, tileCol: startCol + c, tileRow: startRow + r });
    }
  }
  return tiles;
}

function makeLarge(startRow: number, startCol: number): BuildingTemplate["tiles"] {
  const tiles: BuildingTemplate["tiles"] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      tiles.push({ col: c, row: r, tileCol: startCol + c, tileRow: startRow + r });
    }
  }
  return tiles;
}

export const BUILDINGS: Record<string, BuildingTemplate> = {
  // Small red house — rows 21-24, cols 0-2
  home: {
    name: "House",
    widthTiles: 3,
    heightTiles: 4,
    tiles: makeSmall(21, 0),
    entryOffset: { x: 1, y: 3 },
  },

  // Small red house variant 2 — rows 21-24, cols 3-5
  home_alt: {
    name: "House",
    widthTiles: 3,
    heightTiles: 4,
    tiles: makeSmall(21, 3),
    entryOffset: { x: 1, y: 3 },
  },

  // Large red building — rows 25-28, cols 0-4
  shop: {
    name: "Shop",
    widthTiles: 5,
    heightTiles: 4,
    tiles: makeLarge(25, 0),
    entryOffset: { x: 2, y: 3 },
  },

  // Large red building variant 2 — rows 25-28, cols 5-9
  tavern: {
    name: "Tavern",
    widthTiles: 5,
    heightTiles: 4,
    tiles: makeLarge(25, 5),
    entryOffset: { x: 2, y: 3 },
  },

  // Small green house — rows 29-32, cols 0-2
  farm: {
    name: "Farm",
    widthTiles: 3,
    heightTiles: 4,
    tiles: makeSmall(29, 0),
    entryOffset: { x: 1, y: 3 },
  },

  // Large green building — rows 33-36, cols 0-4
  town_hall: {
    name: "Town Hall",
    widthTiles: 5,
    heightTiles: 4,
    tiles: makeLarge(33, 0),
    entryOffset: { x: 2, y: 3 },
  },

  // Large blue building — rows 41-44, cols 0-4
  clinic: {
    name: "Clinic",
    widthTiles: 5,
    heightTiles: 4,
    tiles: makeLarge(41, 0),
    entryOffset: { x: 2, y: 3 },
  },

  // Large blue building variant 2 — rows 41-44, cols 5-9
  clinic_alt: {
    name: "Clinic",
    widthTiles: 5,
    heightTiles: 4,
    tiles: makeLarge(41, 5),
    entryOffset: { x: 2, y: 3 },
  },

  // Open areas — no building tiles
  town_square: {
    name: "Town Square",
    widthTiles: 0,
    heightTiles: 0,
    tiles: [],
    entryOffset: { x: 0, y: 0 },
  },
  park: {
    name: "Park",
    widthTiles: 0,
    heightTiles: 0,
    tiles: [],
    entryOffset: { x: 0, y: 0 },
  },
};

// ---- Props ----
// Props section is in rows 9-17 of the tileset
export const PROPS: Record<string, TileRef> = {
  rock:       { col: 0, row: 13 },
  bush:       { col: 2, row: 13 },
  fence_h:    { col: 0, row: 14 },
  fence_v:    { col: 2, row: 14 },
  sign:       { col: 4, row: 14 },
  flower:     { col: 0, row: 15 },
  flower_red: { col: 1, row: 15 },
  flower_blue:{ col: 2, row: 15 },
  stump:      { col: 4, row: 13 },
  well:       { col: 6, row: 13 },
};

// Multi-tile props (trees are 2x2)
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
