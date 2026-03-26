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
    { name: "chair", relativePosition: { x: 48, y: 40, width: 20, height: 20 }, color: 0x665544, action: "idle" },
  ],
  shop: [
    { name: "counter", relativePosition: { x: 8, y: 8, width: 48, height: 20 }, color: 0xAA8855, action: "working" },
    { name: "shelves", relativePosition: { x: 64, y: 8, width: 48, height: 20 }, color: 0x886633 },
    { name: "storage", relativePosition: { x: 8, y: 40, width: 32, height: 28 }, color: 0x666666 },
    { name: "display", relativePosition: { x: 48, y: 40, width: 32, height: 28 }, color: 0x997744 },
  ],
  tavern: [
    { name: "bar", relativePosition: { x: 8, y: 8, width: 56, height: 20 }, color: 0x774422, action: "working" },
    { name: "stage", relativePosition: { x: 72, y: 8, width: 40, height: 20 }, color: 0x553322, action: "working" },
    { name: "seating", relativePosition: { x: 8, y: 36, width: 56, height: 32 }, color: 0xAA8855, action: "socializing" },
    { name: "corner booth", relativePosition: { x: 72, y: 36, width: 40, height: 32 }, color: 0x664433, action: "socializing" },
  ],
  clinic: [
    { name: "reception", relativePosition: { x: 8, y: 8, width: 36, height: 20 }, color: 0xDDDDDD, action: "working" },
    { name: "exam room", relativePosition: { x: 52, y: 8, width: 32, height: 24 }, color: 0x88AACC, action: "working" },
    { name: "patient bed", relativePosition: { x: 52, y: 40, width: 32, height: 24 }, color: 0x88AACC, action: "idle" },
    { name: "medicine cabinet", relativePosition: { x: 8, y: 36, width: 28, height: 20 }, color: 0xCCCCCC },
  ],
  town_hall: [
    { name: "mayor's desk", relativePosition: { x: 8, y: 8, width: 40, height: 20 }, color: 0x885533, action: "working" },
    { name: "meeting table", relativePosition: { x: 56, y: 8, width: 48, height: 20 }, color: 0x774422 },
    { name: "public seating", relativePosition: { x: 8, y: 36, width: 56, height: 28 }, color: 0xAA8855, action: "socializing" },
    { name: "records room", relativePosition: { x: 72, y: 36, width: 40, height: 28 }, color: 0x666655 },
  ],
  bakery: [
    { name: "oven", relativePosition: { x: 8, y: 8, width: 40, height: 24 }, color: 0xCC6633, action: "working" },
    { name: "prep table", relativePosition: { x: 56, y: 8, width: 40, height: 24 }, color: 0xDDCCAA, action: "working" },
    { name: "display counter", relativePosition: { x: 8, y: 40, width: 48, height: 20 }, color: 0xAA8855 },
    { name: "flour storage", relativePosition: { x: 64, y: 40, width: 32, height: 20 }, color: 0xEEDDCC },
  ],
  workshop: [
    { name: "workbench", relativePosition: { x: 8, y: 8, width: 48, height: 24 }, color: 0x886644, action: "working" },
    { name: "tool wall", relativePosition: { x: 64, y: 8, width: 32, height: 24 }, color: 0x555555 },
    { name: "lumber pile", relativePosition: { x: 8, y: 40, width: 32, height: 28 }, color: 0xAA7744 },
    { name: "forge", relativePosition: { x: 48, y: 40, width: 32, height: 28 }, color: 0xDD6633, action: "working" },
  ],
  prison: [
    { name: "guard desk", relativePosition: { x: 8, y: 8, width: 36, height: 20 }, color: 0x887766, action: "working" },
    { name: "cell 1", relativePosition: { x: 52, y: 8, width: 32, height: 24 }, color: 0x444444, action: "idle" },
    { name: "cell 2", relativePosition: { x: 52, y: 40, width: 32, height: 24 }, color: 0x444444, action: "idle" },
    { name: "hallway", relativePosition: { x: 8, y: 36, width: 36, height: 28 }, color: 0x666666 },
  ],
  farm: [],
  town_square: [],
  park: [],
};
