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

export const INTERIOR_GRIDS: Record<string, number[][]> = {
  // Shop — 5w × 4h
  shop: [
    [1, 1, 3, 1, 1],
    [1, 2, 0, 2, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ],

  // Tavern — 6w × 4h
  tavern: [
    [1, 1, 3, 1, 1, 1],
    [1, 2, 0, 0, 2, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1],
  ],

  // Clinic — 5w × 4h
  clinic: [
    [1, 1, 3, 1, 1],
    [1, 2, 0, 0, 1],
    [1, 0, 0, 2, 1],
    [1, 1, 1, 1, 1],
  ],

  // Bakery — 5w × 4h
  bakery: [
    [1, 1, 3, 1, 1],
    [1, 2, 0, 2, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ],

  // Workshop — 5w × 4h
  workshop: [
    [1, 1, 3, 1, 1],
    [1, 2, 0, 2, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ],

  // Town Hall — 6w × 5h
  town_hall: [
    [1, 1, 3, 1, 1, 1],
    [1, 2, 0, 0, 0, 1],
    [1, 0, 0, 0, 2, 1],
    [1, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1],
  ],

  // Prison — 5w × 4h
  prison: [
    [1, 1, 3, 1, 1],
    [1, 2, 0, 2, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ],
};

// ---------------------------------------------------------------------------
// INTERIOR_ZONES
// ---------------------------------------------------------------------------

export const INTERIOR_ZONES: Record<string, ZoneDef[]> = {
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
      relativePosition: tilesToRelPos([[0, 0], [1, 0]]),
    },
    {
      id: 'kitchen',
      name: 'Kitchen',
      label: 'Kitchen',
      tiles: [[2, 0], [3, 0]],
      center: [2, 0],
      maxOccupants: 2,
      color: 0x8B6B3D,
      allowedActions: ['eat', 'cook'],
      visibility: 0.6,
      furniture: { label: 'Stove', tile: [2, 0] },
      relativePosition: tilesToRelPos([[2, 0], [3, 0]]),
    },
    {
      id: 'living',
      name: 'Living',
      label: 'Living Room',
      tiles: [[0, 1], [1, 1], [2, 1], [3, 1]],
      center: [1, 1],
      maxOccupants: 4,
      color: 0x5C4033,
      allowedActions: ['idle', 'socialize', 'relax'],
      visibility: 0.7,
      relativePosition: tilesToRelPos([[0, 1], [1, 1], [2, 1], [3, 1]]),
    },
  ],

  shop: [
    {
      id: 'counter',
      name: 'Counter',
      label: 'Counter',
      tiles: [[1, 1]],
      center: [1, 1],
      maxOccupants: 2,
      color: 0xB8860B,
      allowedActions: ['work', 'sell', 'buy'],
      visibility: 0.8,
      furniture: { label: 'Counter', tile: [1, 1] },
      relativePosition: tilesToRelPos([[1, 1]]),
    },
    {
      id: 'shelves',
      name: 'Shelves',
      label: 'Shelves',
      tiles: [[3, 1]],
      center: [3, 1],
      maxOccupants: 2,
      color: 0x7B5B3A,
      allowedActions: ['browse', 'stock'],
      visibility: 0.7,
      furniture: { label: 'Shelves', tile: [3, 1] },
      relativePosition: tilesToRelPos([[3, 1]]),
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
      relativePosition: tilesToRelPos([[1, 2]]),
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
      relativePosition: tilesToRelPos([[2, 2], [3, 2]]),
    },
  ],

  tavern: [
    {
      id: 'bar',
      name: 'Bar',
      label: 'Bar',
      tiles: [[1, 1]],
      center: [1, 1],
      maxOccupants: 3,
      color: 0x6B3A2A,
      allowedActions: ['work', 'drink', 'socialize'],
      visibility: 0.9,
      furniture: { label: 'Bar Counter', tile: [1, 1] },
      relativePosition: tilesToRelPos([[1, 1]]),
    },
    {
      id: 'stage',
      name: 'Stage',
      label: 'Stage',
      tiles: [[4, 1]],
      center: [4, 1],
      maxOccupants: 2,
      color: 0x4A2D1A,
      allowedActions: ['work', 'perform', 'gamble'],
      visibility: 1.0,
      furniture: { label: 'Stage', tile: [4, 1] },
      relativePosition: tilesToRelPos([[4, 1]]),
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
      relativePosition: tilesToRelPos([[1, 2], [2, 2]]),
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
      relativePosition: tilesToRelPos([[3, 2], [4, 2]]),
    },
  ],

  clinic: [
    {
      id: 'reception',
      name: 'Reception',
      label: 'Reception',
      tiles: [[1, 1]],
      center: [1, 1],
      maxOccupants: 2,
      color: 0xE8E0D0,
      allowedActions: ['work', 'wait'],
      visibility: 0.9,
      furniture: { label: 'Reception Desk', tile: [1, 1] },
      relativePosition: tilesToRelPos([[1, 1]]),
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
      relativePosition: tilesToRelPos([[2, 1], [3, 1]]),
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
      relativePosition: tilesToRelPos([[1, 2]]),
    },
    {
      id: 'patient_bed',
      name: 'Patient Bed',
      label: 'Patient Bed',
      tiles: [[2, 2], [3, 2]],
      center: [3, 2],
      maxOccupants: 1,
      color: 0x4682B4,
      allowedActions: ['rest', 'heal', 'idle'],
      visibility: 0.4,
      furniture: { label: 'Patient Bed', tile: [3, 2] },
      relativePosition: tilesToRelPos([[2, 2], [3, 2]]),
    },
  ],

  town_hall: [
    {
      id: 'mayors_desk',
      name: "Mayor's Desk",
      label: "Mayor's Desk",
      tiles: [[1, 1]],
      center: [1, 1],
      maxOccupants: 2,
      color: 0x8B4513,
      allowedActions: ['work', 'govern', 'decide'],
      visibility: 0.8,
      furniture: { label: "Mayor's Desk", tile: [1, 1] },
      relativePosition: tilesToRelPos([[1, 1]]),
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
      relativePosition: tilesToRelPos([[2, 1], [3, 1], [4, 1]]),
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
      relativePosition: tilesToRelPos([[1, 2], [2, 2], [3, 2]]),
    },
    {
      id: 'records',
      name: 'Records',
      label: 'Records',
      tiles: [[4, 2], [1, 3], [2, 3], [3, 3], [4, 3]],
      center: [4, 2],
      maxOccupants: 2,
      color: 0x4A6741,
      allowedActions: ['work', 'research'],
      visibility: 0.5,
      furniture: { label: 'Filing Cabinet', tile: [4, 2] },
      relativePosition: tilesToRelPos([[4, 2]]),
    },
  ],

  bakery: [
    {
      id: 'oven',
      name: 'Oven',
      label: 'Oven',
      tiles: [[1, 1]],
      center: [1, 1],
      maxOccupants: 1,
      color: 0xCC4E00,
      allowedActions: ['work', 'cook', 'bake'],
      visibility: 0.7,
      furniture: { label: 'Oven', tile: [1, 1] },
      relativePosition: tilesToRelPos([[1, 1]]),
    },
    {
      id: 'prep_table',
      name: 'Prep Table',
      label: 'Prep Table',
      tiles: [[3, 1]],
      center: [3, 1],
      maxOccupants: 2,
      color: 0xD2B48C,
      allowedActions: ['work', 'prepare', 'bake'],
      visibility: 0.7,
      furniture: { label: 'Prep Table', tile: [3, 1] },
      relativePosition: tilesToRelPos([[3, 1]]),
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
      relativePosition: tilesToRelPos([[1, 2], [2, 2]]),
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
      relativePosition: tilesToRelPos([[3, 2]]),
    },
  ],

  workshop: [
    {
      id: 'workbench',
      name: 'Workbench',
      label: 'Workbench',
      tiles: [[1, 1]],
      center: [1, 1],
      maxOccupants: 2,
      color: 0x7B5B3A,
      allowedActions: ['work', 'craft', 'build'],
      visibility: 0.8,
      furniture: { label: 'Workbench', tile: [1, 1] },
      relativePosition: tilesToRelPos([[1, 1]]),
    },
    {
      id: 'tool_wall',
      name: 'Tool Wall',
      label: 'Tool Wall',
      tiles: [[3, 1]],
      center: [3, 1],
      maxOccupants: 1,
      color: 0x3D5C5C,
      allowedActions: ['work', 'store'],
      visibility: 0.6,
      furniture: { label: 'Tool Rack', tile: [3, 1] },
      relativePosition: tilesToRelPos([[3, 1]]),
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
      relativePosition: tilesToRelPos([[1, 2]]),
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
      relativePosition: tilesToRelPos([[2, 2], [3, 2]]),
    },
  ],

  prison: [
    {
      id: 'guard_desk',
      name: 'Guard Desk',
      label: 'Guard Desk',
      tiles: [[1, 1]],
      center: [1, 1],
      maxOccupants: 2,
      color: 0x6B5B4A,
      allowedActions: ['work', 'guard'],
      visibility: 0.8,
      furniture: { label: 'Guard Desk', tile: [1, 1] },
      relativePosition: tilesToRelPos([[1, 1]]),
    },
    {
      id: 'cell_1',
      name: 'Cell 1',
      label: 'Cell 1',
      tiles: [[3, 1]],
      center: [3, 1],
      maxOccupants: 2,
      color: 0x3A3A2E,
      allowedActions: ['idle', 'rest'],
      visibility: 0.4,
      relativePosition: tilesToRelPos([[3, 1]]),
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
      relativePosition: tilesToRelPos([[1, 2], [2, 2]]),
    },
    {
      id: 'cell_2',
      name: 'Cell 2',
      label: 'Cell 2',
      tiles: [[3, 2]],
      center: [3, 2],
      maxOccupants: 2,
      color: 0x3A3A2E,
      allowedActions: ['idle', 'rest'],
      visibility: 0.4,
      relativePosition: tilesToRelPos([[3, 2]]),
    },
  ],

  farm: [],
  town_square: [],
  park: [],
};
