import {
  MAP_LOCATIONS,
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  DEFAULT_COLLISION_GRID,
} from "../../data/maps/default";

export interface LocationSeed {
  name: string;
  type: string;
  position: { x: number; y: number; width: number; height: number };
  entryPoint: { x: number; y: number };
  capacity: number;
  currentOccupants: string[];
  operatingHours: { open: number; close: number } | null;
  services: Array<{
    needSatisfied: string;
    amount: number;
    cost: number;
    itemRequired: string | null;
  }>;
  description: string;
  owner: null;
}

function getDefaultServices(
  type: string
): Array<{
  needSatisfied: string;
  amount: number;
  cost: number;
  itemRequired: string | null;
}> {
  switch (type) {
    case "home":
      return [
        { needSatisfied: "energy", amount: 8, cost: 0, itemRequired: null },
        { needSatisfied: "comfort", amount: 5, cost: 0, itemRequired: null },
        { needSatisfied: "hunger", amount: 10, cost: 0, itemRequired: "food_raw" },
      ];
    case "shop":
      return [
        { needSatisfied: "hunger", amount: 15, cost: 6, itemRequired: null },
      ];
    case "tavern":
      return [
        { needSatisfied: "social", amount: 6, cost: 0, itemRequired: null },
        { needSatisfied: "fun", amount: 8, cost: 4, itemRequired: null },
        { needSatisfied: "hunger", amount: 8, cost: 5, itemRequired: null },
      ];
    case "farm":
      return [];
    case "clinic":
      return [
        { needSatisfied: "energy", amount: 5, cost: 12, itemRequired: null },
      ];
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
    default:
      return [];
  }
}

function getOperatingHours(
  type: string
): { open: number; close: number } | null {
  switch (type) {
    case "shop":
      return { open: 8, close: 18 };
    case "tavern":
      return { open: 16, close: 23 };
    case "clinic":
      return { open: 8, close: 17 };
    case "town_hall":
      return { open: 9, close: 17 };
    default:
      return null;
  }
}

export function loadMap(): {
  locations: LocationSeed[];
  collisionGrid: string;
  mapWidth: number;
  mapHeight: number;
  tileSize: number;
} {
  const locations: LocationSeed[] = MAP_LOCATIONS.map((loc) => ({
    name: loc.name,
    type: loc.type,
    position: {
      x: loc.x,
      y: loc.y,
      width: loc.width,
      height: loc.height,
    },
    entryPoint: {
      x: loc.entryX,
      y: loc.entryY,
    },
    capacity: loc.capacity,
    currentOccupants: [],
    operatingHours: getOperatingHours(loc.type),
    services: getDefaultServices(loc.type),
    description: loc.description,
    owner: null,
  }));

  return {
    locations,
    collisionGrid: DEFAULT_COLLISION_GRID,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    tileSize: TILE_SIZE,
  };
}
