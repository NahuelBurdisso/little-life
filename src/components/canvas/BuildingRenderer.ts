import * as PIXI from "pixi.js";
import { TERRAIN_COLORS } from "../../lib/tileMap";
import { INTERIOR_ZONES } from "../../../server/data/interiors";
import { getFurnitureTexture } from "./textures";

const TILE_SIZE = 32;

/** Map furniture labels to furniture sprite keys. Unlisted labels stay text-only. */
export const FURNITURE_SPRITE: Record<string, string> = {
  'Bed':              'bed',
  'Stove':            'stove',
  'Counter':          'counter',
  'Shelves':          'shelves',
  'Bar Counter':      'bar_counter',
  'Stage':            'stage',
  'Booth Seat':       'booth_seat',
  'Reception Desk':   'reception_desk',
  'Patient Bed':      'patient_bed',
  "Mayor's Desk":     'mayors_desk',
  'Meeting Table':    'meeting_table',
  'Filing Cabinet':   'filing_cabinet',
  'Oven':             'oven',
  'Prep Table':       'prep_table',
  'Workbench':        'workbench',
  'Tool Rack':        'tool_rack',
  'Forge':            'forge',
  'Guard Desk':       'guard_desk',
};

// ── Per-type interior palettes (proposal-visual.md §3) ───────────────────────
// floor: fill color for the building rect
// wall:  stroke color for the outer wall rect
const INTERIOR_PALETTE: Record<string, { floor: number; wall: number }> = {
  home:      { floor: 0x6b5b45, wall: 0x3d2e1e },
  shop:      { floor: 0x5a5040, wall: 0x38302a },
  tavern:    { floor: 0x7a4f35, wall: 0x4a2e18 },
  clinic:    { floor: 0xd8e8e0, wall: 0x7a9090 },
  town_hall: { floor: 0x7a6a4a, wall: 0x4a3c28 },
  bakery:    { floor: 0xc8a870, wall: 0x6a4a28 },
  workshop:  { floor: 0x4a4a42, wall: 0x2a2820 },
  prison:    { floor: 0x6a6a6a, wall: 0x3a3838 },
  pawnshop:  { floor: 0x5c5044, wall: 0x3a302a },
  divebar:   { floor: 0x3a3028, wall: 0x28201a },
};

// Fallback for any type not in the table above (open areas never reach this path)
const DEFAULT_FLOOR = 0x5a4a3a;
const DEFAULT_WALL  = 0x4a3f2e;

// ── Door styles per building type (proposal-visual.md §4) ────────────────────
const DOOR_STYLE: Record<string, { color: number; w: number; h: number }> = {
  home:      { color: 0x7a5030, w: 10, h: 10 },
  shop:      { color: 0x8b6914, w: 12, h: 10 },
  tavern:    { color: 0x4a2e18, w: 14, h: 12 },
  clinic:    { color: 0xe0e8e4, w: 10, h: 10 },
  town_hall: { color: 0xc09020, w: 16, h: 12 },
  bakery:    { color: 0xa06820, w: 10, h: 10 },
  workshop:  { color: 0x3a3028, w: 12, h: 10 },
  prison:    { color: 0x2a2828, w: 10, h: 12 },
  pawnshop:  { color: 0x5a4030, w: 10, h: 10 },
  divebar:   { color: 0x1e1810, w: 12, h: 10 },
};

// Building types that get a chimney rect (proposal-visual.md §4 chimneys)
const CHIMNEY_TYPES = new Set(['tavern', 'bakery', 'workshop', 'divebar', 'home']);

// ── Accent colors for sign plates (type accent = wall color lightened) ────────
// These are the sign plate colors drawn above the door.
const SIGN_COLOR: Record<string, number | null> = {
  shop:      0xc8a84b, // gold awning strip
  tavern:    0x5a2010, // burgundy awning
  bakery:    0xc07828, // warm orange-tan
  clinic:    0xe0f0e8, // white-ish cross bg
  town_hall: 0xc09020, // gold seal
  pawnshop:  0xc09020, // gold balls
  divebar:   null,     // intentionally no sign
};

export interface LocationData {
  id: number;
  name: string;
  type: string;
  position: { x: number; y: number; width: number; height: number };
  entry_point: { x: number; y: number };
  current_occupants: number[];
}

import { OPEN_AREA_TYPES } from "../../../server/lib/worldgen/buildingTemplates";

const OPEN_AREA_COLORS: Record<string, number> = {
  farm: 0x6b7c3a,
  town_square: 0x8a7a5a,
  park: 0x4a6b3a,
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

const FURNITURE_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 5,
  fill: 0xcccccc,
  stroke: { color: 0x000000, width: 1 },
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

  // Track hover state for zone-rect suppression (task 3)
  private hoveredBuildingId: number | null = null;
  // Track which building IDs contain the selected agent (task 3)
  private occupiedBuildingIds: Set<number> = new Set();

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
    this.hoveredBuildingId = null;
    this.occupiedBuildingIds.clear();

    for (const loc of locations) {
      if (OPEN_AREA_TYPES.has(loc.type)) {
        this.addOpenArea(loc);
      } else {
        this.addBuilding(loc);
      }
    }
  }

  /**
   * Called per data-tick. Receives a map of agentId -> locationId (or null).
   * We use this to know which buildings are occupied so we can show their
   * interior zone rects (task 3: show when agent is inside).
   */
  update(agentLocations: Map<number, number | null>): void {
    const newOccupied = new Set<number>();
    for (const locId of agentLocations.values()) {
      if (locId !== null) newOccupied.add(locId);
    }
    this.occupiedBuildingIds = newOccupied;
    this.syncInteriorVisibility();
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.buildings.clear();
  }

  // ---- Private ----

  /**
   * Sync interior container alpha/visibility based on hover + occupancy state.
   * Zone rects hidden by default; visible when hovered or occupied (task 3).
   */
  private syncInteriorVisibility(): void {
    for (const [id, entry] of this.buildings) {
      if (!entry.interiorContainer) continue;
      const show = id === this.hoveredBuildingId || this.occupiedBuildingIds.has(id);
      entry.interiorContainer.alpha = show ? 0.4 : 0;
    }
  }

  private addBuilding(loc: LocationData): void {
    const { x, y, width, height } = loc.position;

    const palette = INTERIOR_PALETTE[loc.type] ?? { floor: DEFAULT_FLOOR, wall: DEFAULT_WALL };
    const walls = new PIXI.Graphics();

    // ── 1. Chimney rects — drawn BEFORE floor so walls overlap base naturally ──
    if (CHIMNEY_TYPES.has(loc.type)) {
      this.drawChimney(walls, loc.type, x, y, width);
    }

    // ── 2. Floor rect ──────────────────────────────────────────────────────────
    walls.rect(x, y, width, height).fill({ color: palette.floor, alpha: 1.0 });

    // ── 3. Roof trim strip: 4px horizontal bar at the building top edge ────────
    // Color = wall color (darker than floor, implies eave shadow line)
    walls.rect(x, y, width, 4).fill({ color: palette.wall, alpha: 1.0 });

    // ── 4. Wall stroke — per-type color, 4px for added mass ───────────────────
    walls.rect(x, y, width, height).stroke({ width: 4, color: palette.wall });

    // ── 5. Inner shadow ────────────────────────────────────────────────────────
    walls.rect(x + 2, y + 2, width - 4, height - 4).stroke({ color: 0x1a1510, width: 1, alpha: 0.6 });

    // ── 6. Door rect — per-type style ──────────────────────────────────────────
    const doorDef = DOOR_STYLE[loc.type] ?? { color: TERRAIN_COLORS.door, w: 12, h: 8 };
    const ex = loc.entry_point.x;
    const ey = loc.entry_point.y;
    const doorX = Math.round(ex - doorDef.w / 2);
    const doorY = Math.round(ey - doorDef.h / 2);
    walls.rect(doorX, doorY, doorDef.w, doorDef.h).fill({ color: doorDef.color });
    // Thin outline on door
    walls.rect(doorX, doorY, doorDef.w, doorDef.h).stroke({ width: 1, color: 0x1a1510, alpha: 0.8 });

    // ── 7. Sign plate above door ───────────────────────────────────────────────
    this.drawSign(walls, loc.type, x, y, width, ex);

    // Enable pointer events on building container for hover (task 3)
    walls.eventMode = 'static';
    walls.cursor = 'default';
    walls.on('pointerover', () => {
      this.hoveredBuildingId = loc.id;
      this.syncInteriorVisibility();
    });
    walls.on('pointerout', () => {
      if (this.hoveredBuildingId === loc.id) {
        this.hoveredBuildingId = null;
        this.syncInteriorVisibility();
      }
    });

    this.buildingLayer.addChild(walls);

    // ── 8. Interior zones ──────────────────────────────────────────────────────
    const interiorContainer = new PIXI.Container();
    interiorContainer.alpha = 0; // hidden by default (task 3)
    const zones = INTERIOR_ZONES[loc.type] ?? [];
    for (const zone of zones) {
      const zg = new PIXI.Graphics();
      const zx = x + zone.relativePosition.x;
      const zy = y + zone.relativePosition.y;
      zg.rect(zx, zy, zone.relativePosition.width, zone.relativePosition.height);
      zg.fill({ color: zone.color, alpha: 1.0 }); // alpha on the container handles fade
      // Subtle border to separate zones
      zg.rect(zx, zy, zone.relativePosition.width, zone.relativePosition.height);
      zg.stroke({ color: 0x3a3028, width: 0.5, alpha: 0.5 });
      interiorContainer.addChild(zg);

      // Zone label
      const zoneLabel = new PIXI.Text({ text: zone.name, style: ZONE_LABEL_STYLE });
      zoneLabel.anchor.set(0.5, 0.5);
      zoneLabel.x = zx + zone.relativePosition.width / 2;
      zoneLabel.y = zy + zone.relativePosition.height / 2;
      interiorContainer.addChild(zoneLabel);
    }

    // ── 9. Furniture labels + sprites ──────────────────────────────────────────
    for (const zone of zones) {
      if ((zone as any).furniture) {
        const furn = (zone as any).furniture as { label: string; tile: [number, number] };

        // Sprite for mapped furniture labels (bed, patient bed) — loaded async.
        const spriteKey = FURNITURE_SPRITE[furn.label];
        if (spriteKey) {
          const px = x + furn.tile[0] * TILE_SIZE;
          const py = y + furn.tile[1] * TILE_SIZE;
          getFurnitureTexture(spriteKey)
            ?.then((texture) => {
              if (interiorContainer.destroyed) return;
              const sprite = new PIXI.Sprite(texture);
              sprite.x = px;
              sprite.y = py;
              sprite.width = TILE_SIZE;
              sprite.height = TILE_SIZE;
              interiorContainer.addChild(sprite);
            })
            .catch(() => {
              // No-op — label stays as-is.
            });
        }

        const furnText = new PIXI.Text({ text: furn.label, style: FURNITURE_STYLE });
        furnText.anchor.set(0.5, 0.5);
        furnText.x = x + furn.tile[0] * TILE_SIZE + TILE_SIZE / 2;
        furnText.y = y + furn.tile[1] * TILE_SIZE + TILE_SIZE / 2;
        furnText.alpha = 0.6;
        interiorContainer.addChild(furnText);
      }
    }

    this.buildingLayer.addChild(interiorContainer);

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

  /**
   * Draw a chimney rect at the top-right of the building.
   * bakery: 6×10 STONE_MD; workshop: 4×8 IRON_MD; others: 5×9 generic stone.
   * Must be called BEFORE the floor rect (so walls naturally overlap the chimney base).
   */
  private drawChimney(g: PIXI.Graphics, type: string, bx: number, by: number, bw: number): void {
    // Place chimney at top-right corner, 4px inside right edge
    let cw: number, ch: number, color: number, capColor: number;
    if (type === 'bakery') {
      cw = 6; ch = 10; color = 0x5a5850; capColor = 0x8a8878; // STONE_MD/LT
    } else if (type === 'workshop') {
      cw = 4; ch = 8;  color = 0x484442; capColor = 0x706a60; // IRON_MD/LT
    } else {
      // tavern / divebar / home — generic small chimney
      cw = 5; ch = 9;  color = 0x5a5850; capColor = 0x8a8878;
    }
    const cx = bx + bw - cw - 4;
    const cy = by - ch + 2; // stick up above building top
    g.rect(cx, cy, cw, ch).fill({ color });
    // 2px highlight strip on cap
    g.rect(cx, cy, cw, 2).fill({ color: capColor });
  }

  /**
   * Draw a small sign plate / accent above the door. Graphics-only, no sprites.
   */
  private drawSign(g: PIXI.Graphics, type: string, bx: number, by: number, bw: number, doorCx: number): void {
    const signColor = SIGN_COLOR[type];
    if (signColor === undefined) return; // type has no sign entry at all
    if (signColor === null) return;      // divebar: intentionally no sign

    const signY = by - 9; // 9px above building top edge

    switch (type) {
      case 'shop': {
        // 20×6 gold strip centered above door
        const sw = 20;
        g.rect(Math.round(doorCx - sw / 2), signY + 3, sw, 6).fill({ color: signColor });
        break;
      }
      case 'tavern': {
        // 28×8 burgundy awning, full-width-ish
        const sw = Math.min(28, bw - 4);
        g.rect(Math.round(bx + bw / 2 - sw / 2), signY + 1, sw, 8).fill({ color: signColor });
        break;
      }
      case 'bakery': {
        // 18×6 warm orange strip
        const sw = 18;
        g.rect(Math.round(doorCx - sw / 2), signY + 3, sw, 6).fill({ color: signColor });
        break;
      }
      case 'clinic': {
        // White cross 6×6 (two rects)
        const cx = Math.round(doorCx - 1);
        const cy = signY + 2;
        g.rect(cx - 3, cy + 2, 6, 2).fill({ color: signColor }); // horizontal bar
        g.rect(cx - 1, cy,     2, 6).fill({ color: signColor }); // vertical bar
        break;
      }
      case 'town_hall': {
        // 8×8 gold circle at top-center of building face
        const cx = Math.round(bx + bw / 2);
        g.circle(cx, by - 7, 5).fill({ color: signColor });
        break;
      }
      case 'pawnshop': {
        // Three pawnbroker balls: 3× 4px circles in a triangle, gold
        const cx = Math.round(doorCx);
        const cy = signY;
        g.circle(cx,     cy + 4, 3).fill({ color: signColor }); // bottom-center
        g.circle(cx - 5, cy,     3).fill({ color: signColor }); // top-left
        g.circle(cx + 5, cy,     3).fill({ color: signColor }); // top-right
        break;
      }
      default:
        // No sign for types not listed above
        break;
    }
  }

  private addOpenArea(loc: LocationData): void {
    const { x, y, width, height } = loc.position;
    const color = OPEN_AREA_COLORS[loc.type] ?? 0x888888;

    const patch = new PIXI.Graphics();
    patch.roundRect(x, y, width, height, 4).fill({ color, alpha: 0.30 });
    patch.roundRect(x, y, width, height, 4).stroke({ width: 1, color, alpha: 0.4 });
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
