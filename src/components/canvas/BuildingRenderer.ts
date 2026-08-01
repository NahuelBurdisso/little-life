import * as PIXI from "pixi.js";
import { TERRAIN_COLORS } from "../../lib/tileMap";
import { INTERIOR_ZONES } from "../../../server/data/interiors";
import { getFurnitureTexture, getFloorTexture } from "./textures";

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
  // Muted sage instead of near-white: the old 0xd8e8e0 floor glowed like a
  // blank placeholder slab against the earthy palette (fresh-eyes audit r25)
  clinic:    { floor: 0xaebdb2, wall: 0x5e7270 },
  town_hall: { floor: 0x7a6a4a, wall: 0x4a3c28 },
  bakery:    { floor: 0xc8a870, wall: 0x6a4a28 },
  workshop:  { floor: 0x5c5a4e, wall: 0x2a2820 },
  prison:    { floor: 0x6a6a6a, wall: 0x3a3838 },
  pawnshop:  { floor: 0x5c5044, wall: 0x3a302a },
  divebar:   { floor: 0x584538, wall: 0x28201a },
};

// Fallback for any type not in the table above (open areas never reach this path)
const DEFAULT_FLOOR = 0x5a4a3a;
const DEFAULT_WALL  = 0x4a3f2e;

/**
 * Floor material per building type. The textures are greyscale, so the
 * building's own `palette.floor` tints them — one texture serves every type
 * that shares a material.
 */
const FLOOR_MATERIAL: Record<string, string> = {
  home:      'wood',
  shop:      'wood',
  tavern:    'wood',
  divebar:   'wood',
  pawnshop:  'wood',
  bakery:    'wood',
  town_hall: 'wood',
  clinic:    'tile',
  prison:    'tile',
  workshop:  'stone',
};

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

/**
 * World-x of each lit window on a building's south facade, with the ones that
 * would collide with the door already dropped.
 *
 * Exported because LightingSystem has to put its warm night glow on these exact
 * rects, and the two had drifted apart: the glow used a flat ±20px from the door
 * while the windows sit at ±0.22×width, which is 15px off on a 160px-wide shop
 * and 22px off on the 192px tavern — the light pooled between the windows
 * instead of behind them.
 */
export function southWindowXs(loc: {
  type: string;
  position: { x: number; y: number; width: number; height: number };
  entry_point: { x: number; y: number };
}): number[] {
  const { x, width, y, height } = loc.position;
  const doorW = (DOOR_STYLE[loc.type] ?? { w: 12 }).w;
  const doorOnSouth = Math.abs(loc.entry_point.y - (y + height)) < 6;
  const xs = width < 70 ? [x + width / 2] : [x + width * 0.28, x + width * 0.72];
  return xs.filter(
    (wx) => !doorOnSouth || Math.abs(wx - loc.entry_point.x) >= doorW / 2 + 10,
  );
}

/** Distance from the south edge up to the vertical centre of a window rect. */
export const WINDOW_CENTER_ABOVE_SOUTH_EDGE = 6;

/** Per-channel multiply darken for hex colors (used for south wall face band). */
function darken(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

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

import { OUTDOOR_TYPES } from "../../../server/lib/worldgen/buildingTemplates";

const OPEN_AREA_COLORS: Record<string, number> = {
  farm: 0x6b7c3a,
  town_square: 0x8a7a5a,
  park: 0x4a6b3a,
  market_square: 0x9a8562,
  farmyard: 0x7a6a42,
  alley: 0x4a4238,
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
  /** Whole building shell (base + floor sprite + walls), or the patch for open areas. */
  wallGraphic: PIXI.Container;
  interiorContainer: PIXI.Container | null;
  label: PIXI.Text;
  position: { x: number; y: number; width: number; height: number };
  entryPoint: { x: number; y: number };
}

const TOOLTIP_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 8,
  fill: 0xe8e0d0,
  lineHeight: 11,
});

/** "town_hall" -> "Town Hall" */
function prettyType(type: string): string {
  return type.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export class BuildingRenderer {
  private container: PIXI.Container;
  private buildingLayer: PIXI.Container;
  private labelLayer: PIXI.Container;
  /** Hover tooltip. Its own layer so `init()` clearing the labels cannot free it. */
  private tooltipLayer: PIXI.Container;
  private tooltipBg: PIXI.Graphics;
  private tooltipText: PIXI.Text;
  /** Outline drawn around the hovered building. World-space, so never scaled. */
  private hoverOutline: PIXI.Graphics;

  private buildings: Map<number, BuildingEntry> = new Map();
  /** How many agents each building currently holds, from the last `update()`. */
  private occupantCounts: Map<number, number> = new Map();

  // Zone/furniture label visibility state (toggled by zoom level)
  private zoneLabelsVisible = true;
  /** Last scale handed to `setZoom`, so `init` can restore it on rebuilt labels. */
  private lastCameraScale = 1;

  // Track hover state for zone-rect suppression (task 3)
  private hoveredBuildingId: number | null = null;
  // Track which building IDs contain the selected agent (task 3)
  private occupiedBuildingIds: Set<number> = new Set();

  constructor(parent: PIXI.Container) {
    this.container = new PIXI.Container();
    // 'passive', not 'none': PixiJS treats 'none' as "ignore events, *even on
    // children*", which silently disabled the per-building hover that fades the
    // interior in. Agent picking is unaffected either way — InteractionLayer
    // listens on the raw canvas element, not through the PixiJS event graph.
    this.container.eventMode = 'passive';
    this.buildingLayer = new PIXI.Container();
    this.labelLayer = new PIXI.Container();

    this.tooltipLayer = new PIXI.Container();
    this.tooltipLayer.visible = false;
    this.tooltipBg = new PIXI.Graphics();
    this.tooltipText = new PIXI.Text({ text: '', style: TOOLTIP_STYLE.clone() });
    this.tooltipLayer.addChild(this.tooltipBg, this.tooltipText);

    this.hoverOutline = new PIXI.Graphics();
    this.hoverOutline.eventMode = 'none';
    this.hoverOutline.visible = false;

    this.container.addChild(this.buildingLayer);
    this.container.addChild(this.hoverOutline);
    this.container.addChild(this.labelLayer);
    this.container.addChild(this.tooltipLayer);

    parent.addChild(this.container);
  }

  /**
   * Show the hover card above a building: what it is and how busy it is. Anchored
   * to the building's top edge in world space, then counter-scaled by `setZoom`
   * along with the name labels so it stays legible at any zoom.
   */
  private showTooltip(id: number): void {
    const entry = this.buildings.get(id);
    if (!entry) return;
    const n = this.occupantCounts.get(id) ?? 0;
    const who = n === 0 ? 'empty' : n === 1 ? '1 person inside' : `${n} people inside`;
    // Derived outdoor spots are named after their type ("Town Square"), so the
    // second line would just repeat the first.
    const kind = prettyType(entry.type);
    const sub = kind === entry.label.text ? who : `${kind} · ${who}`;
    this.tooltipText.text = `${entry.label.text}\n${sub}`;

    const pad = 4;
    const w = this.tooltipText.width + pad * 2;
    const h = this.tooltipText.height + pad * 2;
    this.tooltipBg.clear();
    this.tooltipBg.roundRect(0, 0, w, h, 3).fill({ color: 0x14100c, alpha: 0.88 });
    this.tooltipBg.roundRect(0, 0, w, h, 3).stroke({ width: 1, color: 0x7a6f5a, alpha: 0.9 });
    this.tooltipText.position.set(pad, pad);

    // The layer is scaled, so place its origin such that the *scaled* card is
    // centred on the building and clears its top edge.
    const s = this.tooltipLayer.scale.x;
    this.tooltipLayer.position.set(
      entry.position.x + entry.position.width / 2 - (w * s) / 2,
      entry.position.y - h * s - 6,
    );
    this.tooltipLayer.visible = true;
  }

  private hideTooltip(): void {
    this.tooltipLayer.visible = false;
  }

  /**
   * Warm outline around the hovered building. The interior fade and the card
   * both take a beat to read; a hard edge on the footprint is the immediate
   * "yes, this one" feedback that tells you the cursor is actually on something.
   */
  private showHoverOutline(id: number): void {
    const entry = this.buildings.get(id);
    if (!entry) return;
    const { x, y, width, height } = entry.position;
    this.hoverOutline.clear();
    this.hoverOutline.rect(x - 3, y - 3, width + 6, height + 6)
      .stroke({ width: 2, color: 0xf0d890, alpha: 0.85 });
    this.hoverOutline.rect(x - 1, y - 1, width + 2, height + 2)
      .stroke({ width: 1, color: 0x2a2016, alpha: 0.5 });
    this.hoverOutline.visible = true;
  }

  /** Wire hover on a building's hit graphic: fade the interior in, show the card. */
  private bindHover(g: PIXI.Container, id: number): void {
    g.eventMode = 'static';
    g.cursor = 'default';
    g.on('pointerover', () => {
      this.hoveredBuildingId = id;
      this.syncInteriorVisibility();
      this.showTooltip(id);
      this.showHoverOutline(id);
    });
    g.on('pointerout', () => {
      if (this.hoveredBuildingId !== id) return;
      this.hoveredBuildingId = null;
      this.syncInteriorVisibility();
      this.hideTooltip();
      this.hoverOutline.visible = false;
    });
  }

  /**
   * Counter-scale name labels so they stay ~screen-constant across zoom.
   * Zoomed out: labels grow (up to 2x) instead of shrinking to noise.
   * Zoomed in: labels shrink (down to 0.45x) instead of dominating.
   */
  setZoom(cameraScale: number): void {
    this.lastCameraScale = cameraScale;
    const s = Math.min(2, Math.max(0.45, 1 / cameraScale));
    for (const child of this.labelLayer.children) child.scale.set(s);
    this.tooltipLayer.scale.set(s);
    if (this.hoveredBuildingId !== null) this.showTooltip(this.hoveredBuildingId);

    // Interior zone/furniture labels are simulation detail — only readable
    // when zoomed in. At wide zoom they render as pixel noise, so hide them.
    const showZoneLabels = cameraScale >= 1.3;
    if (showZoneLabels !== this.zoneLabelsVisible) {
      this.zoneLabelsVisible = showZoneLabels;
      for (const b of this.buildings.values()) {
        if (!b.interiorContainer) continue;
        for (const ch of b.interiorContainer.children) {
          if (ch instanceof PIXI.Text) ch.visible = showZoneLabels;
        }
      }
    }
  }

  init(locations: LocationData[]): void {
    // Clear previous
    for (const [, entry] of this.buildings) {
      this.destroyEntry(entry);
    }
    this.buildings.clear();
    // Destroy, don't just detach: the town-square well graphic is added to the
    // building layer without a `buildings` entry, so `destroyEntry` never frees
    // it and a bare `removeChildren` leaks one Graphics per re-init.
    for (const child of this.buildingLayer.removeChildren()) child.destroy({ children: true, style: true });
    for (const child of this.labelLayer.removeChildren()) child.destroy({ children: true, style: true });
    this.hoveredBuildingId = null;
    this.occupiedBuildingIds.clear();
    this.occupantCounts.clear();
    this.hideTooltip();
    this.hoverOutline.visible = false;

    for (const loc of locations) {
      // Main Street's footprint *is* the road, already drawn by TilemapRenderer.
      if (loc.type === 'mainstreet') continue;
      // OUTDOOR_TYPES, not OPEN_AREA_TYPES: the derived locations (alley,
      // farmyard, market_square) have no template so they were absent from
      // OPEN_AREA_TYPES and fell through to `addBuilding`, which drew an opaque
      // roofed rect with walls and a door. Measured over 30 seeds, that covered
      // 30.5% of all road tiles.
      if (OUTDOOR_TYPES.has(loc.type)) {
        this.addOpenArea(loc);
      } else {
        this.addBuilding(loc);
      }
    }

    // Labels were just recreated at scale 1 with default visibility. `setZoom`
    // early-outs on unchanged zone visibility, so without this a re-init after
    // the user zoomed leaves labels mis-sized until they zoom again.
    this.zoneLabelsVisible = true;
    this.setZoom(this.lastCameraScale);
  }

  /**
   * Called per data-tick. Receives a map of agentId -> locationId (or null).
   * We use this to know which buildings are occupied so we can show their
   * interior zone rects (task 3: show when agent is inside).
   */
  update(agentLocations: Map<number, number | null>): void {
    const newOccupied = new Set<number>();
    this.occupantCounts.clear();
    for (const locId of agentLocations.values()) {
      if (locId === null) continue;
      newOccupied.add(locId);
      this.occupantCounts.set(locId, (this.occupantCounts.get(locId) ?? 0) + 1);
    }
    this.occupiedBuildingIds = newOccupied;
    this.syncInteriorVisibility();
    // The hovered building's headcount changes as agents come and go.
    if (this.hoveredBuildingId !== null) this.showTooltip(this.hoveredBuildingId);
  }

  destroy(): void {
    this.container.destroy({ children: true, style: true });
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

  /**
   * Drop a tiled floor texture into `shell` between the base fill and the walls.
   *
   * Async: the texture may still be loading, so this returns immediately and
   * inserts the sprite once resolved. Until then (or forever, if the load fails)
   * the flat `base` floor rect underneath is what shows, which is the same thing
   * the renderer drew before textures existed.
   */
  private addFloorSurface(
    shell: PIXI.Container,
    type: string,
    tint: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const material = FLOOR_MATERIAL[type];
    if (!material) return;
    const p = getFloorTexture(material);
    if (!p) return;
    p.then((tex) => {
      if (shell.destroyed) return;
      const sprite = new PIXI.TilingSprite({ texture: tex, width, height });
      sprite.position.set(x, y);
      sprite.tint = tint;
      // Index 1 = directly above `base`, below `walls`, regardless of which
      // building's texture resolves first.
      shell.addChildAt(sprite, 1);
    }).catch(() => {
      /* flat base floor stays; nothing else to do */
    });
  }

  private addBuilding(loc: LocationData): void {
    const { x, y, width, height } = loc.position;

    const palette = INTERIOR_PALETTE[loc.type] ?? { floor: DEFAULT_FLOOR, wall: DEFAULT_WALL };

    // The building is drawn as three stacked pieces so the tiled floor surface
    // can sit between the flat floor colour and the walls/door/windows. A single
    // Graphics would force the async-loaded texture on top of everything.
    const shell = new PIXI.Container();
    const base = new PIXI.Graphics();
    const walls = new PIXI.Graphics();

    // ── 0a. Ground-contact apron — worn-earth ring plants the building in the
    // terrain instead of floating on untouched grass (fresh-eyes audit r14) ──
    base.rect(x - 5, y - 5, width + 10, height + 10).fill({ color: 0x6b5a3a, alpha: 0.35 });

    // ── 0b. Drop shadow — offset rect under building grounds it on the terrain ──
    base.rect(x + 4, y + 4, width, height).fill({ color: 0x1a1208, alpha: 0.35 });

    // ── 1. Chimney rects — drawn BEFORE floor so walls overlap base naturally ──
    if (CHIMNEY_TYPES.has(loc.type)) {
      this.drawChimney(base, loc.type, x, y, width);
    }

    // ── 2. Floor rect. Doubles as the fallback surface if the tiled floor
    // texture below fails to load. ────────────────────────────────────────────
    base.rect(x, y, width, height).fill({ color: palette.floor, alpha: 1.0 });

    shell.addChild(base);
    this.addFloorSurface(shell, loc.type, palette.floor, x, y, width, height);
    shell.addChild(walls);

    // ── 2b. South wall face band — darkened wall-color strip along bottom edge
    // implies vertical height so buildings read as masses, not painted rects
    // (fresh-eyes audit r19). Door drawn later punches doorway through it. ──
    walls.rect(x, y + height - 6, width, 6).fill({ color: darken(palette.wall, 0.62) });

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

    // ── 5b. Windows on the south facade band — warm-lit apertures break the
    // solid wall face so buildings read as inhabited (fresh-eyes audit r21).
    // Skipped where they'd collide with a south-facing door. ──
    for (const wx of southWindowXs(loc)) {
      walls.rect(Math.round(wx - 5), y + height - 10, 10, 8).fill({ color: 0x1a1510 });
      walls.rect(Math.round(wx - 4), y + height - 9, 8, 6).fill({ color: 0xd8c07a, alpha: 0.9 });
    }
    const doorX = Math.round(ex - doorDef.w / 2);
    const doorY = Math.round(ey - doorDef.h / 2);
    walls.rect(doorX, doorY, doorDef.w, doorDef.h).fill({ color: doorDef.color });
    // Thin outline on door
    walls.rect(doorX, doorY, doorDef.w, doorDef.h).stroke({ width: 1, color: 0x1a1510, alpha: 0.8 });

    // ── 7. Sign plate above door ───────────────────────────────────────────────
    this.drawSign(walls, loc.type, x, y, width, ex);

    // Hover the whole footprint, not just the drawn wall strokes: `walls` only
    // fills its trim/door/window rects now that the floor moved to `base`, so
    // hit-testing it would leave the middle of every building dead.
    shell.hitArea = new PIXI.Rectangle(x, y, width, height);
    this.bindHover(shell, loc.id);

    this.buildingLayer.addChild(shell);

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

      // Zone label. Wrapped to the zone rect: most zones are a single 32px tile
      // and names like "Prep Table" render ~60px wide, so unwrapped labels spilled
      // across their neighbours and the interior read as one smear of text.
      const zoneStyle = ZONE_LABEL_STYLE.clone();
      zoneStyle.wordWrap = true;
      zoneStyle.wordWrapWidth = zone.relativePosition.width;
      zoneStyle.breakWords = true;
      const zoneLabel = new PIXI.Text({ text: zone.name, style: zoneStyle });
      zoneLabel.anchor.set(0.5, 0.5);
      zoneLabel.x = zx + zone.relativePosition.width / 2;
      zoneLabel.y = zy + zone.relativePosition.height / 2;
      interiorContainer.addChild(zoneLabel);
    }

    // ── 9. Furniture labels + sprites ──────────────────────────────────────────
    for (const zone of zones) {
      if ((zone as any).furniture) {
        const furn = (zone as any).furniture as { label: string; tile: [number, number] };

        // `[-1,-1]` is the "no furniture cell in this interior grid" sentinel
        // (homes are all-walkable). Rendering it literally placed the sprite and
        // label one tile above and left of the building's top-left corner —
        // outside the building. Fall back to the zone center, which is where the
        // agent using the furniture actually stands.
        const [ftx, fty] =
          furn.tile[0] < 0 || furn.tile[1] < 0 ? zone.center : furn.tile;

        // Sprite for mapped furniture labels (bed, patient bed) — loaded async.
        const spriteKey = FURNITURE_SPRITE[furn.label];
        if (spriteKey) {
          const px = x + ftx * TILE_SIZE;
          const py = y + fty * TILE_SIZE;
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
              // No-op — the zone label still names the area.
            });
          continue;
        }

        // Text only for furniture with no sprite. Drawing both stacked the label
        // on top of its own picture, and for single-tile zones the zone name sits
        // at the same point (shop:counter drew "Counter" twice, pixel-aligned).
        // 14 of the 30-odd furniture entries repeat their zone's name verbatim
        // ('Oven', 'Prep Table', 'Forge', ...) — the zone label already says it.
        if (furn.label === zone.name) continue;

        const furnStyle = FURNITURE_STYLE.clone();
        furnStyle.wordWrap = true;
        furnStyle.wordWrapWidth = TILE_SIZE;
        furnStyle.breakWords = true;
        const furnText = new PIXI.Text({ text: furn.label, style: furnStyle });
        furnText.anchor.set(0.5, 0.5);
        furnText.x = x + ftx * TILE_SIZE + TILE_SIZE / 2;
        furnText.y = y + fty * TILE_SIZE + TILE_SIZE / 2;
        furnText.alpha = 0.6;
        interiorContainer.addChild(furnText);
      }
    }

    this.buildingLayer.addChild(interiorContainer);

    // Name label centered below the building
    const label = new PIXI.Text({ text: loc.name, style: LABEL_STYLE.clone() });
    label.anchor.set(0.5, 0);
    label.x = x + width / 2;
    label.y = y + height + 2;
    this.labelLayer.addChild(label);

    this.buildings.set(loc.id, {
      id: loc.id,
      type: loc.type,
      wallGraphic: shell,
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

  /**
   * Two rows of covered market stalls with a walkway between them. Stall count
   * follows the square's width, so a small market gets two stalls and a large
   * one gets a proper row rather than the props stretching to fit.
   */
  private drawMarketStalls(g: PIXI.Graphics, x: number, y: number, w: number, h: number): void {
    const STALL_W = 26, STALL_H = 18, STEP = 38;
    const AWNINGS = [0xb04a3a, 0x3a6ab0, 0x4a8a52, 0xb08a3a];
    const cols = Math.floor((w - 24 + (STEP - STALL_W)) / STEP);
    if (cols < 1 || h < STALL_H * 2 + 24) return;
    // Centre the row rather than left-aligning it: an off-centre gap at the
    // right edge reads as "the props ran out".
    const startX = x + (w - (cols * STEP - (STEP - STALL_W))) / 2;

    for (const [rowIdx, sy] of [[0, y + 10], [1, y + h - 10 - STALL_H]] as const) {
      for (let i = 0; i < cols; i++) {
        const sx = startX + i * STEP;
        const awning = AWNINGS[(i + rowIdx) % AWNINGS.length];

        g.rect(sx + 2, sy + 2, STALL_W, STALL_H).fill({ color: 0x1a1208, alpha: 0.3 });
        g.rect(sx, sy + 7, STALL_W, STALL_H - 7).fill({ color: 0x8a6a42 });
        g.rect(sx, sy + 7, STALL_W, STALL_H - 7).stroke({ width: 1, color: 0x3a2a18, alpha: 0.9 });
        // Striped awning over the counter.
        for (let s = 0; s < 4; s++) {
          g.rect(sx + s * 6.5, sy, 6.5, 7).fill({ color: s % 2 === 0 ? awning : 0xe8ddc0 });
        }
        g.rect(sx, sy, STALL_W, 7).stroke({ width: 1, color: 0x3a2a18, alpha: 0.7 });
        // Goods on the counter.
        for (let d = 0; d < 3; d++) {
          g.circle(sx + 6 + d * 7, sy + 12, 2).fill({ color: [0xc8683a, 0x6a9a3a, 0xd0b040][d] });
        }
      }
    }
  }

  /** Fenced yard furniture: rails, hay bales and a water trough. */
  private drawFarmyardProps(g: PIXI.Graphics, x: number, y: number, w: number, h: number): void {
    // Post-and-rail fence around the perimeter.
    for (const railY of [y + 5, y + h - 5]) {
      g.rect(x + 4, railY - 1, w - 8, 2).fill({ color: 0x6a5236, alpha: 0.9 });
    }
    for (let px = x + 4; px <= x + w - 8; px += 26) {
      g.rect(px + 1, y + 3, 3, h - 6).fill({ color: 0x1a1208, alpha: 0.18 });
      g.rect(px, y + 2, 3, h - 4).fill({ color: 0x7a6242 });
    }

    // Hay bales stacked in the upper-left, clear of the fence line.
    for (const [bx, by] of [[x + 14, y + 16], [x + 40, y + 16], [x + 27, y + 34]]) {
      if (bx + 22 > x + w - 8 || by + 16 > y + h - 8) continue;
      g.rect(bx + 2, by + 2, 22, 16).fill({ color: 0x1a1208, alpha: 0.28 });
      g.roundRect(bx, by, 22, 16, 3).fill({ color: 0xc9a94e });
      g.roundRect(bx, by, 22, 16, 3).stroke({ width: 1, color: 0x8a6f2a, alpha: 0.9 });
      for (let b = 1; b < 3; b++) {
        g.rect(bx + b * 7, by + 1, 1, 14).fill({ color: 0x8a6f2a, alpha: 0.6 });
      }
    }

    // Water trough on the right.
    const tx = x + w - 46, ty = y + h - 30;
    if (tx > x + 8) {
      g.rect(tx + 2, ty + 2, 32, 13).fill({ color: 0x1a1208, alpha: 0.28 });
      g.rect(tx, ty, 32, 13).fill({ color: 0x5a4632 });
      g.rect(tx + 2, ty + 2, 28, 9).fill({ color: 0x4a6a72 });
      g.rect(tx, ty, 32, 13).stroke({ width: 1, color: 0x2a2016, alpha: 0.9 });
    }
  }

  /**
   * Crates, barrels and refuse pushed against the alley's long walls, so the
   * middle stays clear — agents path down alleys and props in the lane would
   * look like they were walking through them.
   */
  private drawAlleyProps(g: PIXI.Graphics, x: number, y: number, w: number, h: number): void {
    const horizontal = w >= h;
    const span = horizontal ? w : h;
    // Deterministic per-alley variation without an rng: the alley's own origin.
    let seed = ((x * 73856093) ^ (y * 19349663)) >>> 0;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000;

    for (let d = 16; d < span - 16; d += 22) {
      const nearSide = next() < 0.5;
      // Offset from the near wall, always inside the 8px margin.
      const off = nearSide ? 5 : (horizontal ? h : w) - 19;
      const px = horizontal ? x + d : x + off;
      const py = horizontal ? y + off : y + d;
      const roll = next();

      if (roll < 0.45) {
        g.rect(px + 2, py + 2, 14, 14).fill({ color: 0x1a1208, alpha: 0.3 });
        g.rect(px, py, 14, 14).fill({ color: 0x7a5c38 });
        g.rect(px, py, 14, 14).stroke({ width: 1, color: 0x3a2a18, alpha: 0.9 });
        g.moveTo(px, py).lineTo(px + 14, py + 14).stroke({ width: 1, color: 0x4a3520, alpha: 0.7 });
        g.moveTo(px + 14, py).lineTo(px, py + 14).stroke({ width: 1, color: 0x4a3520, alpha: 0.7 });
      } else if (roll < 0.8) {
        g.ellipse(px + 8, py + 9, 6, 7).fill({ color: 0x1a1208, alpha: 0.3 });
        g.ellipse(px + 6, py + 7, 6, 7).fill({ color: 0x6a4a2e });
        g.ellipse(px + 6, py + 7, 6, 7).stroke({ width: 1, color: 0x3a2a18, alpha: 0.9 });
        for (const hy of [py + 4, py + 10]) {
          g.moveTo(px + 1, hy).lineTo(px + 11, hy).stroke({ width: 1, color: 0x3a2a18, alpha: 0.6 });
        }
      } else {
        // Refuse — a couple of dark scraps on the ground.
        g.ellipse(px + 5, py + 7, 5, 3).fill({ color: 0x33291c, alpha: 0.55 });
        g.ellipse(px + 11, py + 10, 3, 2).fill({ color: 0x33291c, alpha: 0.45 });
      }
    }
  }

  private addOpenArea(loc: LocationData): void {
    const { x, y, width, height } = loc.position;
    const color = OPEN_AREA_COLORS[loc.type] ?? 0x888888;

    const patch = new PIXI.Graphics();
    patch.roundRect(x, y, width, height, 4).fill({ color, alpha: 0.5 });
    patch.roundRect(x, y, width, height, 4).stroke({ width: 1, color, alpha: 0.6 });
    // Worn perimeter band — a darker inner rim softens the crisp rectangular
    // seam where open-area ground meets grass, matching the road edge
    // treatment (fresh-eyes audit r30).
    patch.roundRect(x + 2, y + 2, width - 4, height - 4, 4)
      .stroke({ width: 4, color: darken(color, 0.7), alpha: 0.25 });
    this.bindHover(patch, loc.id);
    this.buildingLayer.addChild(patch);

    // Derived areas (market square, farmyard, back alley) had nothing but this
    // tinted rect and a label, so they read as unfinished ground rather than
    // places. Give each the props that name it.
    if (loc.type === 'market_square' || loc.type === 'farmyard' || loc.type === 'alley') {
      const props = new PIXI.Graphics();
      if (loc.type === 'market_square') this.drawMarketStalls(props, x, y, width, height);
      else if (loc.type === 'farmyard') this.drawFarmyardProps(props, x, y, width, height);
      else this.drawAlleyProps(props, x, y, width, height);
      props.eventMode = 'none';
      this.buildingLayer.addChild(props);
    }

    // Town square landmark: a stone well/fountain at the center gives the
    // open space a focal point instead of reading as an empty patch.
    if (loc.type === 'town_square') {
      const cx = x + Math.floor(width / 2 / 32) * 32;
      const cy = y + Math.floor(height / 2 / 32) * 32;
      const well = new PIXI.Graphics();
      // Worn stone apron ring + benches turn the well into a gathering point
      // instead of a lone mechanism on an empty lot (fresh-eyes audit r23).
      well.circle(cx + 16, cy + 16, 36).stroke({ width: 7, color: 0x8a7a5e, alpha: 0.3 });
      for (const [bx, by, bw, bh] of [
        [cx + 10, cy - 40, 14, 5], // north bench
        [cx + 10, cy + 68, 14, 5], // south bench
        [cx - 40, cy + 10, 5, 14], // west bench
        [cx + 68, cy + 10, 5, 14], // east bench
      ]) {
        well.rect(bx + 1, by + 2, bw, bh).fill({ color: 0x1a1208, alpha: 0.25 }); // bench shadow
        well.rect(bx, by, bw, bh).fill({ color: 0x6a5236 });
        well.rect(bx, by, bw, bh).stroke({ width: 1, color: 0x2a2016, alpha: 0.8 });
      }
      // Contact shadow — offset ellipse grounds the well on the plaza so it
      // doesn't float at night when ambient light flattens (fresh-eyes r20)
      well.ellipse(cx + 19, cy + 20, 21, 18).fill({ color: 0x1a1208, alpha: 0.3 });
      // Stone basin (outer ring) — bright enough to read as the plaza focal point
      well.circle(cx + 16, cy + 16, 20).fill({ color: 0x9a9284 });
      well.circle(cx + 16, cy + 16, 20).stroke({ width: 2, color: 0x1a1510 });
      // Water
      well.circle(cx + 16, cy + 16, 13).fill({ color: 0x4a7a8c });
      well.circle(cx + 16, cy + 16, 13).stroke({ width: 1, color: 0x2a4a56 });
      // Highlight glint
      well.rect(cx + 9, cy + 9, 4, 4).fill({ color: 0x8ab8c8 });
      this.buildingLayer.addChild(well);
    }

    const label = new PIXI.Text({ text: loc.name, style: LABEL_STYLE.clone() });
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
    // `children: true` — the shell holds the base Graphics, the tiled floor
    // sprite and the walls; a bare destroy() would orphan all three.
    entry.wallGraphic.destroy({ children: true });
    entry.interiorContainer?.destroy({ children: true, style: true });
    entry.label.destroy({ style: true });
  }
}
