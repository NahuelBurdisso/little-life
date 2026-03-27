import * as PIXI from "pixi.js";
import { TERRAIN_COLORS } from "../../lib/tileMap";
import { INTERIOR_ZONES } from "../../../server/data/interiors";

export interface LocationData {
  id: number;
  name: string;
  type: string;
  position: { x: number; y: number; width: number; height: number };
  entry_point: { x: number; y: number };
  current_occupants: number[];
}

/** Open-area types that get a transparent patch instead of walls + roof. */
const OPEN_AREA_TYPES = new Set(["farm", "town_square", "park"]);

const OPEN_AREA_COLORS: Record<string, number> = {
  farm: 0x7cba4a,
  town_square: 0xd4b483,
  park: 0x5a9c4f,
};

const LABEL_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 7,
  fill: 0xffffff,
  stroke: { color: 0x000000, width: 2 },
  align: "center",
});

const ZONE_LABEL_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 6,
  fill: 0xffffff,
  stroke: { color: 0x000000, width: 1.5 },
  align: "center",
});

interface BuildingEntry {
  id: number;
  type: string;
  wallGraphic: PIXI.Graphics;
  interiorContainer: PIXI.Container | null;
  label: PIXI.Text;
  position: { x: number; y: number; width: number; height: number };
  entryPoint: { x: number; y: number };
}

export class BuildingRenderer {
  private container: PIXI.Container;
  private buildingLayer: PIXI.Container;
  private labelLayer: PIXI.Container;

  private buildings: Map<number, BuildingEntry> = new Map();

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    this.container.eventMode = 'none'; // transparent to clicks
    this.buildingLayer = new PIXI.Container();
    this.labelLayer = new PIXI.Container();

    this.container.addChild(this.buildingLayer);
    this.container.addChild(this.labelLayer);

    parent.addChild(this.container);
  }

  init(locations: LocationData[]): void {
    // Clear previous
    for (const [, entry] of this.buildings) {
      this.destroyEntry(entry);
    }
    this.buildings.clear();
    this.buildingLayer.removeChildren();
    this.labelLayer.removeChildren();

    for (const loc of locations) {
      if (OPEN_AREA_TYPES.has(loc.type)) {
        this.addOpenArea(loc);
      } else {
        this.addBuilding(loc);
      }
    }
  }

  update(_agentLocations: Map<number, number | null>): void {
    // Interiors always visible — nothing to toggle
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.buildings.clear();
  }

  // ---- Private ----

  private addBuilding(loc: LocationData): void {
    const { x, y, width, height } = loc.position;

    // Walls — fill then re-draw rect for stroke (PixiJS v8: fill() flushes the path)
    const walls = new PIXI.Graphics();
    walls.rect(x, y, width, height).fill({ color: TERRAIN_COLORS.building });
    walls.rect(x, y, width, height).stroke({ width: 2, color: 0x444444 });

    // Door — a small brown rectangle centered on the entry point edge
    const doorW = 12;
    const doorH = 8;
    const ex = loc.entry_point.x;
    const ey = loc.entry_point.y;
    walls.rect(ex - doorW / 2, ey - doorH / 2, doorW, doorH).fill({ color: TERRAIN_COLORS.door });

    this.buildingLayer.addChild(walls);

    // Interior zones
    const interiorContainer = new PIXI.Container();
    interiorContainer.alpha = 1;
    const zones = INTERIOR_ZONES[loc.type] ?? [];
    for (const zone of zones) {
      const zg = new PIXI.Graphics();
      const zx = x + zone.relativePosition.x;
      const zy = y + zone.relativePosition.y;
      zg.rect(zx, zy, zone.relativePosition.width, zone.relativePosition.height);
      zg.fill({ color: zone.color, alpha: 0.85 });
      // Subtle border to separate zones
      zg.rect(zx, zy, zone.relativePosition.width, zone.relativePosition.height);
      zg.stroke({ color: 0x000000, width: 0.5, alpha: 0.3 });
      interiorContainer.addChild(zg);

      // Zone label
      const zoneLabel = new PIXI.Text({ text: zone.name, style: ZONE_LABEL_STYLE });
      zoneLabel.anchor.set(0.5, 0.5);
      zoneLabel.x = zx + zone.relativePosition.width / 2;
      zoneLabel.y = zy + zone.relativePosition.height / 2;
      interiorContainer.addChild(zoneLabel);
    }
    this.buildingLayer.addChild(interiorContainer);

    // No roof overlay — interiors always visible

    // Name label centered below the building
    const label = new PIXI.Text({ text: loc.name, style: LABEL_STYLE });
    label.anchor.set(0.5, 0);
    label.x = x + width / 2;
    label.y = y + height + 2;
    this.labelLayer.addChild(label);

    this.buildings.set(loc.id, {
      id: loc.id,
      type: loc.type,
      wallGraphic: walls,
      interiorContainer,
      label,
      position: loc.position,
      entryPoint: loc.entry_point,
    });
  }

  private addOpenArea(loc: LocationData): void {
    const { x, y, width, height } = loc.position;
    const color = OPEN_AREA_COLORS[loc.type] ?? 0x888888;

    const patch = new PIXI.Graphics();
    patch.roundRect(x, y, width, height, 4).fill({ color, alpha: 0.45 });
    patch.roundRect(x, y, width, height, 4).stroke({ width: 1, color, alpha: 0.7 });
    this.buildingLayer.addChild(patch);

    const label = new PIXI.Text({ text: loc.name, style: LABEL_STYLE });
    label.anchor.set(0.5, 0.5);
    label.x = x + width / 2;
    label.y = y + height / 2;
    this.labelLayer.addChild(label);

    this.buildings.set(loc.id, {
      id: loc.id,
      type: loc.type,
      wallGraphic: patch,
      interiorContainer: null,
      label,
      position: loc.position,
      entryPoint: loc.entry_point,
    });
  }

  private destroyEntry(entry: BuildingEntry): void {
    entry.wallGraphic.destroy();
    entry.interiorContainer?.destroy({ children: true });
    entry.label.destroy();
  }
}
