export interface BuildingZone {
  name: string;
  relativePosition: { x: number; y: number; width: number; height: number };
  color: number;
  action?: string;
}

export const INTERIOR_ZONES: Record<string, BuildingZone[]> = {
  home: [
    { name: "bed", relativePosition: { x: 8, y: 8, width: 32, height: 24 }, color: 0x334488, action: "sleeping" },
    { name: "table", relativePosition: { x: 48, y: 8, width: 28, height: 24 }, color: 0x885533, action: "eating" },
  ],
  shop: [
    { name: "counter", relativePosition: { x: 8, y: 8, width: 48, height: 20 }, color: 0xAA8855, action: "working" },
    { name: "storage", relativePosition: { x: 8, y: 40, width: 32, height: 28 }, color: 0x666666 },
  ],
  tavern: [
    { name: "bar", relativePosition: { x: 8, y: 8, width: 56, height: 20 }, color: 0x774422, action: "working" },
    { name: "seating", relativePosition: { x: 8, y: 36, width: 56, height: 32 }, color: 0xAA8855 },
  ],
  clinic: [
    { name: "desk", relativePosition: { x: 8, y: 8, width: 36, height: 20 }, color: 0xDDDDDD, action: "working" },
    { name: "patient bed", relativePosition: { x: 52, y: 8, width: 32, height: 24 }, color: 0x88AACC },
  ],
  town_hall: [
    { name: "desk", relativePosition: { x: 8, y: 8, width: 40, height: 20 }, color: 0x885533, action: "working" },
    { name: "seating", relativePosition: { x: 8, y: 36, width: 56, height: 28 }, color: 0xAA8855 },
  ],
  farm: [],
  town_square: [],
  park: [],
};
