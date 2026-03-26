export interface BuildingZone {
  name: string;
  relativePosition: { x: number; y: number; width: number; height: number };
  color: number;
  action?: string;
}

export const INTERIOR_ZONES: Record<string, BuildingZone[]> = {
  home: [
    { name: "Bed", relativePosition: { x: 8, y: 8, width: 36, height: 32 }, color: 0x2E4A7A, action: "sleeping" },
    { name: "Kitchen", relativePosition: { x: 52, y: 8, width: 36, height: 32 }, color: 0x8B6B3D, action: "eating" },
    { name: "Living", relativePosition: { x: 8, y: 48, width: 80, height: 32 }, color: 0x5C4033, action: "idle" },
  ],
  shop: [
    { name: "Counter", relativePosition: { x: 8, y: 8, width: 64, height: 28 }, color: 0xB8860B, action: "working" },
    { name: "Shelves", relativePosition: { x: 80, y: 8, width: 64, height: 28 }, color: 0x7B5B3A },
    { name: "Storage", relativePosition: { x: 8, y: 44, width: 48, height: 36 }, color: 0x4A6741 },
    { name: "Display", relativePosition: { x: 64, y: 44, width: 80, height: 36 }, color: 0xA0785A },
  ],
  tavern: [
    { name: "Bar", relativePosition: { x: 8, y: 8, width: 80, height: 28 }, color: 0x6B3A2A, action: "working" },
    { name: "Stage", relativePosition: { x: 96, y: 8, width: 80, height: 28 }, color: 0x4A2D1A, action: "working" },
    { name: "Tables", relativePosition: { x: 8, y: 44, width: 80, height: 40 }, color: 0x8B6B3D, action: "socializing" },
    { name: "Booth", relativePosition: { x: 96, y: 44, width: 80, height: 40 }, color: 0x5C3D2E, action: "socializing" },
  ],
  clinic: [
    { name: "Reception", relativePosition: { x: 8, y: 8, width: 56, height: 28 }, color: 0xE8E0D0, action: "working" },
    { name: "Exam Room", relativePosition: { x: 72, y: 8, width: 72, height: 28 }, color: 0x5B8DAE, action: "working" },
    { name: "Medicine", relativePosition: { x: 8, y: 44, width: 48, height: 36 }, color: 0x2D8B57 },
    { name: "Patient Bed", relativePosition: { x: 64, y: 44, width: 80, height: 36 }, color: 0x4682B4, action: "idle" },
  ],
  town_hall: [
    { name: "Mayor's Desk", relativePosition: { x: 8, y: 8, width: 72, height: 32 }, color: 0x8B4513, action: "working" },
    { name: "Meeting Table", relativePosition: { x: 88, y: 8, width: 88, height: 32 }, color: 0x6B3A1F },
    { name: "Public Seats", relativePosition: { x: 8, y: 48, width: 88, height: 48 }, color: 0xA0785A, action: "socializing" },
    { name: "Records", relativePosition: { x: 104, y: 48, width: 72, height: 48 }, color: 0x4A6741 },
  ],
  bakery: [
    { name: "Oven", relativePosition: { x: 8, y: 8, width: 56, height: 32 }, color: 0xCC4E00, action: "working" },
    { name: "Prep Table", relativePosition: { x: 72, y: 8, width: 72, height: 32 }, color: 0xD2B48C, action: "working" },
    { name: "Display", relativePosition: { x: 8, y: 48, width: 72, height: 32 }, color: 0xB8860B },
    { name: "Flour", relativePosition: { x: 88, y: 48, width: 56, height: 32 }, color: 0xE8D5B7 },
  ],
  workshop: [
    { name: "Workbench", relativePosition: { x: 8, y: 8, width: 72, height: 32 }, color: 0x7B5B3A, action: "working" },
    { name: "Tool Wall", relativePosition: { x: 88, y: 8, width: 56, height: 32 }, color: 0x3D5C5C },
    { name: "Lumber", relativePosition: { x: 8, y: 48, width: 56, height: 32 }, color: 0xA0785A },
    { name: "Forge", relativePosition: { x: 72, y: 48, width: 72, height: 32 }, color: 0xB85C00, action: "working" },
  ],
  prison: [
    { name: "Guard Desk", relativePosition: { x: 8, y: 8, width: 56, height: 28 }, color: 0x6B5B4A, action: "working" },
    { name: "Cell 1", relativePosition: { x: 72, y: 8, width: 72, height: 28 }, color: 0x3A3A2E, action: "idle" },
    { name: "Hallway", relativePosition: { x: 8, y: 44, width: 56, height: 36 }, color: 0x4A4A3A },
    { name: "Cell 2", relativePosition: { x: 72, y: 44, width: 72, height: 36 }, color: 0x3A3A2E, action: "idle" },
  ],
  farm: [],
  town_square: [],
  park: [],
};
