// Cell types: 0=floor, 1=wall, 2=furniture, 3=door
// Grid coordinates: [col, row] (x=col, y=row), origin at top-left of building interior

const TILE_SIZE = 32;

function tilesToRelPos(tiles: [number, number][]): { x: number; y: number; width: number; height: number } {
  const xs = tiles.map(t => t[0]);
  const ys = tiles.map(t => t[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX * TILE_SIZE + 8,
    y: minY * TILE_SIZE + 8,
    width: (maxX - minX + 1) * TILE_SIZE - 16,
    height: (maxY - minY + 1) * TILE_SIZE - 16,
  };
}

export interface ZoneDef {
  id: string;
  name: string;
  label: string;
  tiles: [number, number][];
  center: [number, number];
  maxOccupants: number;
  color: number;
  allowedActions: string[];
  visibility: number;
  furniture?: { label: string; tile: [number, number] };
  relativePosition: { x: number; y: number; width: number; height: number };
}

// Backward compat alias — BuildingRenderer still references this type name
export type BuildingZone = ZoneDef;

// ---------------------------------------------------------------------------
// INTERIOR_GRIDS
// 2D arrays: row-major, outer index = row (y), inner index = col (x)
// 0=floor  1=wall  2=furniture  3=door
// ---------------------------------------------------------------------------

// All buildings in maps.ts have entry_point.y = building.y + height → world
// door is on the SOUTH edge. Interior grids must put their door cell (3) on
// the bottom row at the column matching the entry_point's relative offset,
// otherwise agents walk through the south wall when entering/exiting.
//
// Entry column = floor((entryX - building.x) / TILE_SIZE):
//   shop (x=352, entryX=432) → col 2
//   tavern (x=1088, entryX=1184) → col 3
//   clinic (x=1376, entryX=1456) → col 2
//   bakery (x=96, entryX=176) → col 2
//   workshop (x=96, entryX=176) → col 2
//   town_hall (x=352, entryX=448) → col 3
//   prison (x=1088, entryX=1168) → col 2
export const INTERIOR_GRIDS: Record<string, number[][]> = {
  // Shop — 5w × 4h, door at row 3 col 2
  shop: [
    [1, 1, 1, 1, 1],
    [1, 2, 0, 2, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 3, 1, 1],
  ],

  // Tavern — 6w × 4h, door at row 3 col 3
  tavern: [
    [1, 1, 1, 1, 1, 1],
    [1, 2, 0, 0, 2, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 1, 1, 3, 1, 1],
  ],

  // Clinic — 5w × 4h, door at row 3 col 2
  clinic: [
    [1, 1, 1, 1, 1],
    [1, 2, 0, 0, 1],
    [1, 0, 0, 2, 1],
    [1, 1, 3, 1, 1],
  ],

  // Bakery — 5w × 4h, door at row 3 col 2
  bakery: [
    [1, 1, 1, 1, 1],
    [1, 2, 0, 2, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 3, 1, 1],
  ],

  // Workshop — 5w × 4h, door at row 3 col 2
  workshop: [
    [1, 1, 1, 1, 1],
    [1, 2, 0, 2, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 3, 1, 1],
  ],

  // Town Hall — 6w × 5h, door at row 4 col 3
  town_hall: [
    [1, 1, 1, 1, 1, 1],
    [1, 2, 0, 0, 0, 1],
    [1, 0, 0, 0, 2, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 1, 1, 3, 1, 1],
  ],

  // Prison — 5w × 4h, door at row 3 col 2
  prison: [
    [1, 1, 1, 1, 1],
    [1, 2, 0, 2, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 3, 1, 1],
  ],
};

// ---------------------------------------------------------------------------
// INTERIOR_ZONES
// ---------------------------------------------------------------------------

export const INTERIOR_ZONES: Record<string, ZoneDef[]> = {
  // Homes are 3×3 tiles (96px square). Zone tiles must stay within cols 0..2.
  home: [
    {
      id: 'bed',
      name: 'Bed',
      label: 'Bed',
      tiles: [[0, 0], [1, 0]],
      center: [0, 0],
      maxOccupants: 1,
      color: 0x2E4A7A,
      allowedActions: ['sleep', 'rest'],
      visibility: 0.3,
      furniture: { label: 'Bed', tile: [0, 0] },
      relativePosition: { x: 8, y: 8, width: 36, height: 32 },
    },
    {
      id: 'kitchen',
      name: 'Kitchen',
      label: 'Kitchen',
      tiles: [[2, 0]],
      center: [2, 0],
      maxOccupants: 2,
      color: 0x8B6B3D,
      allowedActions: ['eat', 'cook'],
      visibility: 0.6,
      furniture: { label: 'Stove', tile: [2, 0] },
      relativePosition: { x: 52, y: 8, width: 36, height: 32 },
    },
    {
      id: 'living',
      name: 'Living',
      label: 'Living Room',
      tiles: [[0, 1], [1, 1], [2, 1]],
      center: [1, 1],
      maxOccupants: 4,
      color: 0x5C4033,
      allowedActions: ['idle', 'socialize', 'relax'],
      visibility: 0.7,
      relativePosition: { x: 8, y: 48, width: 80, height: 32 },
    },
  ],

  shop: [
    {
      id: 'counter',
      name: 'Counter',
      label: 'Counter',
      tiles: [[1, 1]],
      // [1,1] is furniture (2) — moved to adjacent walkable [2,1] (floor)
      center: [2, 1],
      maxOccupants: 2,
      color: 0xB8860B,
      allowedActions: ['work', 'sell', 'buy'],
      visibility: 0.8,
      furniture: { label: 'Counter', tile: [1, 1] },
      relativePosition: { x: 8, y: 8, width: 64, height: 28 },
    },
    {
      id: 'shelves',
      name: 'Shelves',
      label: 'Shelves',
      tiles: [[3, 1]],
      // [3,1] is furniture (2) — moved to adjacent walkable [3,2] (floor)
      center: [3, 2],
      maxOccupants: 2,
      color: 0x7B5B3A,
      allowedActions: ['browse', 'stock'],
      visibility: 0.7,
      furniture: { label: 'Shelves', tile: [3, 1] },
      relativePosition: { x: 80, y: 8, width: 64, height: 28 },
    },
    {
      id: 'storage',
      name: 'Storage',
      label: 'Storage',
      tiles: [[1, 2]],
      center: [1, 2],
      maxOccupants: 1,
      color: 0x4A6741,
      allowedActions: ['store', 'work'],
      visibility: 0.4,
      relativePosition: { x: 8, y: 44, width: 48, height: 36 },
    },
    {
      id: 'display',
      name: 'Display',
      label: 'Display',
      tiles: [[2, 2], [3, 2]],
      center: [2, 2],
      maxOccupants: 3,
      color: 0xA0785A,
      allowedActions: ['browse', 'buy'],
      visibility: 0.9,
      relativePosition: { x: 64, y: 44, width: 80, height: 36 },
    },
  ],

  tavern: [
    {
      id: 'bar',
      name: 'Bar',
      label: 'Bar',
      tiles: [[1, 1]],
      // [1,1] is furniture (2) — moved to adjacent walkable [2,1] (floor)
      center: [2, 1],
      maxOccupants: 3,
      color: 0x6B3A2A,
      allowedActions: ['work', 'drink', 'socialize'],
      visibility: 0.9,
      furniture: { label: 'Bar Counter', tile: [1, 1] },
      relativePosition: { x: 8, y: 8, width: 80, height: 28 },
    },
    {
      id: 'stage',
      name: 'Stage',
      label: 'Stage',
      tiles: [[4, 1]],
      // [4,1] is furniture (2) — moved to adjacent walkable [3,1] (floor)
      center: [3, 1],
      maxOccupants: 2,
      color: 0x4A2D1A,
      allowedActions: ['work', 'perform', 'gamble'],
      visibility: 1.0,
      furniture: { label: 'Stage', tile: [4, 1] },
      relativePosition: { x: 96, y: 8, width: 80, height: 28 },
    },
    {
      id: 'tables',
      name: 'Tables',
      label: 'Tables',
      tiles: [[1, 2], [2, 2]],
      center: [1, 2],
      maxOccupants: 4,
      color: 0x8B6B3D,
      allowedActions: ['eat', 'drink', 'socialize'],
      visibility: 0.8,
      relativePosition: { x: 8, y: 44, width: 80, height: 40 },
    },
    {
      id: 'booth',
      name: 'Booth',
      label: 'Booth',
      tiles: [[3, 2], [4, 2]],
      center: [3, 2],
      maxOccupants: 3,
      color: 0x5C3D2E,
      allowedActions: ['eat', 'drink', 'socialize', 'gamble'],
      visibility: 0.3,
      relativePosition: { x: 96, y: 44, width: 80, height: 40 },
    },
  ],

  clinic: [
    {
      id: 'reception',
      name: 'Reception',
      label: 'Reception',
      tiles: [[1, 1]],
      // [1,1] is furniture (2) — moved to adjacent walkable [2,1] (floor)
      center: [2, 1],
      maxOccupants: 2,
      color: 0xE8E0D0,
      allowedActions: ['work', 'wait'],
      visibility: 0.9,
      furniture: { label: 'Reception Desk', tile: [1, 1] },
      relativePosition: { x: 8, y: 8, width: 56, height: 28 },
    },
    {
      id: 'exam_room',
      name: 'Exam Room',
      label: 'Exam Room',
      tiles: [[2, 1], [3, 1]],
      center: [3, 1],
      maxOccupants: 2,
      color: 0x5B8DAE,
      allowedActions: ['work', 'heal', 'examine'],
      visibility: 0.5,
      relativePosition: { x: 72, y: 8, width: 72, height: 28 },
    },
    {
      id: 'medicine',
      name: 'Medicine',
      label: 'Medicine Storage',
      tiles: [[1, 2]],
      center: [1, 2],
      maxOccupants: 1,
      color: 0x2D8B57,
      allowedActions: ['work', 'store'],
      visibility: 0.4,
      relativePosition: { x: 8, y: 44, width: 48, height: 36 },
    },
    {
      id: 'patient_bed',
      name: 'Patient Bed',
      label: 'Patient Bed',
      tiles: [[2, 2], [3, 2]],
      // [3,2] is furniture (2) — moved to adjacent walkable [2,2] (floor)
      center: [2, 2],
      maxOccupants: 1,
      color: 0x4682B4,
      allowedActions: ['rest', 'heal', 'idle'],
      visibility: 0.4,
      furniture: { label: 'Patient Bed', tile: [3, 2] },
      relativePosition: { x: 64, y: 44, width: 80, height: 36 },
    },
  ],

  town_hall: [
    {
      id: 'mayors_desk',
      name: "Mayor's Desk",
      label: "Mayor's Desk",
      tiles: [[1, 1]],
      // [1,1] is furniture (2) — moved to adjacent walkable [2,1] (floor)
      center: [2, 1],
      maxOccupants: 2,
      color: 0x8B4513,
      allowedActions: ['work', 'govern', 'decide'],
      visibility: 0.8,
      furniture: { label: "Mayor's Desk", tile: [1, 1] },
      relativePosition: { x: 8, y: 8, width: 72, height: 32 },
    },
    {
      id: 'meeting_table',
      name: 'Meeting Table',
      label: 'Meeting Table',
      tiles: [[2, 1], [3, 1], [4, 1]],
      center: [3, 1],
      maxOccupants: 4,
      color: 0x6B3A1F,
      allowedActions: ['work', 'discuss', 'socialize'],
      visibility: 0.9,
      furniture: { label: 'Meeting Table', tile: [3, 1] },
      relativePosition: { x: 88, y: 8, width: 88, height: 32 },
    },
    {
      id: 'public_seats',
      name: 'Public Seats',
      label: 'Public Seats',
      tiles: [[1, 2], [2, 2], [3, 2]],
      center: [2, 2],
      maxOccupants: 6,
      color: 0xA0785A,
      allowedActions: ['wait', 'socialize', 'idle'],
      visibility: 0.9,
      relativePosition: { x: 8, y: 48, width: 88, height: 48 },
    },
    {
      id: 'records',
      name: 'Records',
      label: 'Records',
      tiles: [[4, 2], [1, 3], [2, 3], [3, 3], [4, 3]],
      // [4,2] is furniture (2) — moved to adjacent walkable [1,3] (floor)
      center: [1, 3],
      maxOccupants: 2,
      color: 0x4A6741,
      allowedActions: ['work', 'research'],
      visibility: 0.5,
      furniture: { label: 'Filing Cabinet', tile: [4, 2] },
      relativePosition: { x: 104, y: 48, width: 72, height: 48 },
    },
  ],

  bakery: [
    {
      id: 'oven',
      name: 'Oven',
      label: 'Oven',
      tiles: [[1, 1]],
      // [1,1] is furniture (2) — moved to adjacent walkable [2,1] (floor)
      center: [2, 1],
      maxOccupants: 1,
      color: 0xCC4E00,
      allowedActions: ['work', 'cook', 'bake'],
      visibility: 0.7,
      furniture: { label: 'Oven', tile: [1, 1] },
      relativePosition: { x: 8, y: 8, width: 56, height: 32 },
    },
    {
      id: 'prep_table',
      name: 'Prep Table',
      label: 'Prep Table',
      tiles: [[3, 1]],
      // [3,1] is furniture (2) — moved to adjacent walkable [2,2] (floor)
      center: [2, 2],
      maxOccupants: 2,
      color: 0xD2B48C,
      allowedActions: ['work', 'prepare', 'bake'],
      visibility: 0.7,
      furniture: { label: 'Prep Table', tile: [3, 1] },
      relativePosition: { x: 72, y: 8, width: 72, height: 32 },
    },
    {
      id: 'display',
      name: 'Display',
      label: 'Display Case',
      tiles: [[1, 2], [2, 2]],
      center: [1, 2],
      maxOccupants: 3,
      color: 0xB8860B,
      allowedActions: ['buy', 'browse'],
      visibility: 0.9,
      relativePosition: { x: 8, y: 48, width: 72, height: 32 },
    },
    {
      id: 'flour',
      name: 'Flour',
      label: 'Flour Storage',
      tiles: [[3, 2]],
      center: [3, 2],
      maxOccupants: 1,
      color: 0xE8D5B7,
      allowedActions: ['store', 'work'],
      visibility: 0.4,
      relativePosition: { x: 88, y: 48, width: 56, height: 32 },
    },
  ],

  workshop: [
    {
      id: 'workbench',
      name: 'Workbench',
      label: 'Workbench',
      tiles: [[1, 1]],
      // [1,1] is furniture (2) — moved to adjacent walkable [2,1] (floor)
      center: [2, 1],
      maxOccupants: 2,
      color: 0x7B5B3A,
      allowedActions: ['work', 'craft', 'build'],
      visibility: 0.8,
      furniture: { label: 'Workbench', tile: [1, 1] },
      relativePosition: { x: 8, y: 8, width: 72, height: 32 },
    },
    {
      id: 'tool_wall',
      name: 'Tool Wall',
      label: 'Tool Wall',
      tiles: [[3, 1]],
      // [3,1] is furniture (2) — moved to adjacent walkable [2,2] (floor)
      center: [2, 2],
      maxOccupants: 1,
      color: 0x3D5C5C,
      allowedActions: ['work', 'store'],
      visibility: 0.6,
      furniture: { label: 'Tool Rack', tile: [3, 1] },
      relativePosition: { x: 88, y: 8, width: 56, height: 32 },
    },
    {
      id: 'lumber',
      name: 'Lumber',
      label: 'Lumber Storage',
      tiles: [[1, 2]],
      center: [1, 2],
      maxOccupants: 1,
      color: 0xA0785A,
      allowedActions: ['store', 'work'],
      visibility: 0.5,
      relativePosition: { x: 8, y: 48, width: 56, height: 32 },
    },
    {
      id: 'forge',
      name: 'Forge',
      label: 'Forge',
      tiles: [[2, 2], [3, 2]],
      center: [3, 2],
      maxOccupants: 1,
      color: 0xB85C00,
      allowedActions: ['work', 'smith', 'craft'],
      visibility: 0.7,
      furniture: { label: 'Forge', tile: [3, 2] },
      relativePosition: { x: 72, y: 48, width: 72, height: 32 },
    },
  ],

  prison: [
    {
      id: 'guard_desk',
      name: 'Guard Desk',
      label: 'Guard Desk',
      tiles: [[1, 1]],
      // [1,1] is furniture (2) — moved to adjacent walkable [2,1] (floor)
      center: [2, 1],
      maxOccupants: 2,
      color: 0x6B5B4A,
      allowedActions: ['work', 'guard'],
      visibility: 0.8,
      furniture: { label: 'Guard Desk', tile: [1, 1] },
      relativePosition: { x: 8, y: 8, width: 56, height: 28 },
    },
    {
      id: 'cell_1',
      name: 'Cell 1',
      label: 'Cell 1',
      tiles: [[3, 1]],
      // [3,1] is furniture (2) — moved to adjacent walkable [3,2] (floor)
      center: [3, 2],
      maxOccupants: 2,
      color: 0x3A3A2E,
      allowedActions: ['idle', 'rest'],
      visibility: 0.4,
      relativePosition: { x: 72, y: 8, width: 72, height: 28 },
    },
    {
      id: 'hallway',
      name: 'Hallway',
      label: 'Hallway',
      tiles: [[1, 2], [2, 2]],
      center: [1, 2],
      maxOccupants: 3,
      color: 0x4A4A3A,
      allowedActions: ['idle', 'walk'],
      visibility: 0.7,
      relativePosition: { x: 8, y: 44, width: 56, height: 36 },
    },
    {
      id: 'cell_2',
      name: 'Cell 2',
      label: 'Cell 2',
      tiles: [[3, 2]],
      center: [2, 2],
      maxOccupants: 2,
      color: 0x3A3A2E,
      allowedActions: ['idle', 'rest'],
      visibility: 0.4,
      relativePosition: { x: 72, y: 44, width: 72, height: 36 },
    },
  ],

  farm: [
    { id: 'crops_north', name: 'Crop Field', label: 'Crops', tiles: [[0,0],[1,0],[2,0],[3,0],[0,1],[1,1],[2,1],[3,1]], center: [2, 1], maxOccupants: 2, color: 0x4a7a2a, allowedActions: ['working', 'plant', 'harvest'], visibility: 1.0, relativePosition: { x: 8, y: 8, width: 120, height: 56 } },
    { id: 'crops_south', name: 'Crop Field', label: 'Crops', tiles: [[4,0],[5,0],[6,0],[7,0],[4,1],[5,1],[6,1],[7,1]], center: [6, 1], maxOccupants: 2, color: 0x4a7a2a, allowedActions: ['working', 'plant', 'harvest'], visibility: 1.0, relativePosition: { x: 136, y: 8, width: 120, height: 56 } },
    { id: 'coop', name: 'Chicken Coop', label: 'Coop', tiles: [[0,3],[1,3]], center: [1, 3], maxOccupants: 1, color: 0xd69e2e, allowedActions: ['collect_eggs', 'feed_animals'], visibility: 0.8, relativePosition: { x: 8, y: 96, width: 56, height: 28 } },
    { id: 'barn', name: 'Barn', label: 'Barn', tiles: [[3,3],[4,3],[3,4],[4,4]], center: [4, 3], maxOccupants: 2, color: 0x8B6B3D, allowedActions: ['working', 'hide', 'hookup'], visibility: 0.4, relativePosition: { x: 96, y: 96, width: 56, height: 56 } },
    { id: 'rest_spot', name: 'Rest Spot', label: 'Rest', tiles: [[7,4],[8,4]], center: [8, 4], maxOccupants: 2, color: 0xfbd38d, allowedActions: ['eat', 'idle', 'rest'], visibility: 0.8, relativePosition: { x: 224, y: 128, width: 56, height: 28 } },
  ],

  park: [
    { id: 'riverside', name: 'Riverside', label: 'River', tiles: [[0,0],[1,0],[0,1],[1,1]], center: [1, 1], maxOccupants: 3, color: 0x4299e1, allowedActions: ['fish', 'contemplate'], visibility: 0.7, relativePosition: { x: 8, y: 8, width: 56, height: 56 } },
    { id: 'grove_west', name: 'Grove', label: 'Grove', tiles: [[3,0],[4,0],[3,1],[4,1]], center: [4, 0], maxOccupants: 3, color: 0x48bb78, allowedActions: ['stroll', 'flirt', 'secret_meeting', 'forage'], visibility: 0.3, relativePosition: { x: 96, y: 8, width: 56, height: 56 } },
    { id: 'grove_east', name: 'Grove', label: 'Grove', tiles: [[5,0],[6,0],[5,1],[6,1]], center: [6, 0], maxOccupants: 3, color: 0x48bb78, allowedActions: ['stroll', 'flirt', 'secret_meeting', 'forage'], visibility: 0.3, relativePosition: { x: 160, y: 8, width: 56, height: 56 } },
    { id: 'benches', name: 'Benches', label: 'Bench', tiles: [[0,3],[1,3]], center: [1, 3], maxOccupants: 4, color: 0xd69e2e, allowedActions: ['socialize', 'idle', 'comfort', 'people_watch'], visibility: 0.9, relativePosition: { x: 8, y: 96, width: 56, height: 28 } },
    { id: 'garden', name: 'Garden', label: 'Garden', tiles: [[3,3],[4,3]], center: [4, 3], maxOccupants: 2, color: 0xfbd38d, allowedActions: ['garden', 'pick_flowers'], visibility: 0.8, relativePosition: { x: 96, y: 96, width: 56, height: 28 } },
  ],

  town_square: [
    { id: 'market_north', name: 'Market Stalls', label: 'Market', tiles: [[0,0],[1,0],[2,0],[0,1],[1,1],[2,1]], center: [1, 1], maxOccupants: 4, color: 0xd69e2e, allowedActions: ['browse', 'shopping', 'pickpocket'], visibility: 1.0, relativePosition: { x: 8, y: 8, width: 88, height: 56 } },
    { id: 'fountain', name: 'Fountain', label: 'Fountain', tiles: [[3,0],[4,0],[3,1],[4,1]], center: [4, 1], maxOccupants: 5, color: 0x63b3ed, allowedActions: ['socialize', 'perform'], visibility: 1.0, relativePosition: { x: 96, y: 8, width: 56, height: 56 } },
    { id: 'market_south', name: 'Market Stalls', label: 'Market', tiles: [[6,0],[7,0],[8,0],[6,1],[7,1],[8,1]], center: [7, 1], maxOccupants: 4, color: 0xd69e2e, allowedActions: ['browse', 'shopping', 'pickpocket'], visibility: 1.0, relativePosition: { x: 192, y: 8, width: 88, height: 56 } },
    { id: 'plaza', name: 'Open Plaza', label: 'Plaza', tiles: [[0,3],[1,3],[2,3],[3,3],[4,3],[5,3],[6,3],[7,3],[8,3]], center: [4, 3], maxOccupants: 10, color: 0xa0aec0, allowedActions: ['socialize', 'idle', 'fight'], visibility: 1.3, relativePosition: { x: 8, y: 96, width: 272, height: 28 } },
    { id: 'podium', name: 'Podium', label: 'Podium', tiles: [[0,5],[1,5]], center: [1, 5], maxOccupants: 2, color: 0xf6ad55, allowedActions: ['speech', 'protest', 'announce'], visibility: 1.3, relativePosition: { x: 8, y: 160, width: 56, height: 28 } },
    { id: 'seating', name: 'Seating', label: 'Seats', tiles: [[3,5],[4,5],[5,5],[6,5],[7,5],[8,5]], center: [5, 5], maxOccupants: 6, color: 0x68d391, allowedActions: ['idle', 'eat', 'watch'], visibility: 0.9, relativePosition: { x: 96, y: 160, width: 184, height: 28 } },
  ],
};

// ---------------------------------------------------------------------------
// ACTION_ZONE_REQUIREMENTS
// Maps action types to required zones per building type.
// If an action isn't in this map, it has no zone requirement.
// ---------------------------------------------------------------------------

export const ACTION_ZONE_REQUIREMENTS: Record<string, Record<string, string[]>> = {
  sleeping: { home: ['bed'] },
  eating: { home: ['kitchen'], tavern: ['tables'], bakery: ['display'] },
  working: {
    shop: ['counter', 'storage'],
    tavern: ['bar', 'stage'],
    bakery: ['oven', 'prep_table'],
    clinic: ['reception', 'exam_room', 'medicine'],
    workshop: ['workbench', 'forge'],
    town_hall: ['mayors_desk'],
    prison: ['guard_desk'],
    farm: ['crops_north', 'crops_south'],
  },
  gambling: { tavern: ['tables'] },
};
