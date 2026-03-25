import * as PIXI from "pixi.js";
import { SPRITE_CONFIG } from "../../lib/spriteConfig";
import { BUILDINGS, TILESET } from "../../lib/tileMap";
import type { TileRef } from "../../lib/tileMap";

interface MapLocation {
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  entryX: number;
  entryY: number;
  capacity: number;
  description: string;
}

interface MapData {
  mapWidth: number;
  mapHeight: number;
  tileSize: number;
  pixelWidth: number;
  pixelHeight: number;
  tileLayer: number[][];
  tileTypes: Record<string, { name: string; tileset: string; tileIndex: number }>;
  locations: MapLocation[];
}

const TILE_SIZE = SPRITE_CONFIG.TILE_SIZE;
const NATIVE_TILE = SPRITE_CONFIG.NATIVE_TILE;
const SPRITE_SCALE = SPRITE_CONFIG.SPRITE_SCALE;

const LABEL_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 7,
  fill: 0xffffff,
  stroke: { color: 0x000000, width: 2 },
  align: "center",
});

function sliceTileset(base: PIXI.Texture): PIXI.Texture[][] {
  const grid: PIXI.Texture[][] = [];
  for (let r = 0; r < TILESET.rows; r++) {
    const rowArr: PIXI.Texture[] = [];
    for (let c = 0; c < TILESET.columns; c++) {
      rowArr.push(new PIXI.Texture({
        source: base.source,
        frame: new PIXI.Rectangle(c * NATIVE_TILE, r * NATIVE_TILE, NATIVE_TILE, NATIVE_TILE),
      }));
    }
    grid.push(rowArr);
  }
  return grid;
}

export class TilemapRenderer {
  container: PIXI.Container;

  private buildingContainer: PIXI.Container;
  private labelContainer: PIXI.Container;
  private occupancyContainer: PIXI.Container;

  private mapData: MapData | null = null;
  private tileGrid: PIXI.Texture[][] | null = null;

  constructor(_app: PIXI.Application) {
    this.container = new PIXI.Container();
    this.buildingContainer = new PIXI.Container();
    this.labelContainer = new PIXI.Container();
    this.occupancyContainer = new PIXI.Container();

    this.container.addChild(this.buildingContainer);
    this.container.addChild(this.labelContainer);
    this.container.addChild(this.occupancyContainer);

    this.loadMap();
  }

  getMapSize(): { width: number; height: number } {
    if (!this.mapData) return { width: 40 * TILE_SIZE, height: 30 * TILE_SIZE };
    return { width: this.mapData.pixelWidth, height: this.mapData.pixelHeight };
  }

  updateOccupancy(agents: any[], locations: any[]): void {
    for (const child of this.occupancyContainer.children) child.destroy();
    this.occupancyContainer.removeChildren();

    for (const loc of locations) {
      const occupants = loc.current_occupants ?? [];
      if (occupants.length === 0) continue;
      const dotCount = Math.min(occupants.length, 5);
      const centerX = loc.position.x + (loc.position.width * 32) / 2;
      const y = loc.position.y + loc.position.height * 32 + 14;
      const startX = centerX - (dotCount * 6) / 2;
      for (let i = 0; i < dotCount; i++) {
        const occupantId = occupants[i];
        const agent = agents.find((a: any) => a.id === occupantId);
        const mood = agent?.needs?.mood ?? 50;
        const color = mood > 60 ? 0x22c55e : mood > 40 ? 0xeab308 : 0xef4444;
        const dot = new PIXI.Graphics();
        dot.circle(0, 0, 3).fill(color);
        dot.x = startX + i * 6;
        dot.y = y;
        this.occupancyContainer.addChild(dot);
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  // ---- Loading ----

  private async loadMap(): Promise<void> {
    try {
      const resp = await fetch("/maps/default.json");
      this.mapData = await resp.json();
      const base = PIXI.Assets.get<PIXI.Texture>("serene-village");
      if (base) this.tileGrid = sliceTileset(base);
      this.renderBuildings();
      this.renderLabels();
    } catch (err) {
      console.error("Failed to load map:", err);
    }
  }

  // ---- Helpers ----

  private getTileTexture(ref: TileRef): PIXI.Texture | null {
    if (!this.tileGrid) return null;
    if (ref.row < 0 || ref.row >= this.tileGrid.length) return null;
    if (ref.col < 0 || ref.col >= this.tileGrid[ref.row].length) return null;
    return this.tileGrid[ref.row][ref.col];
  }

  private createTileSprite(ref: TileRef, x: number, y: number): PIXI.Sprite | null {
    const tex = this.getTileTexture(ref);
    if (!tex) return null;
    const sprite = new PIXI.Sprite(tex);
    sprite.scale.set(SPRITE_SCALE);
    sprite.x = x;
    sprite.y = y;
    return sprite;
  }

  // ---- Buildings & open areas ----

  private renderBuildings(): void {
    if (!this.mapData) return;

    for (const loc of this.mapData.locations) {
      const template = BUILDINGS[loc.type];

      if (!template || template.tiles.length === 0) {
        // Open area (town_square, park) — draw a visible ground patch
        this.renderOpenArea(loc);
        continue;
      }

      const bx = Math.round(loc.x / TILE_SIZE) * TILE_SIZE;
      const by = Math.round(loc.y / TILE_SIZE) * TILE_SIZE;

      for (const tile of template.tiles) {
        const sprite = this.createTileSprite(
          { col: tile.tileCol, row: tile.tileRow },
          bx + tile.col * TILE_SIZE,
          by + tile.row * TILE_SIZE,
        );
        if (sprite) this.buildingContainer.addChild(sprite);
      }
    }
  }

  /** Draw a lighter green rectangle with a subtle border for parks / town squares */
  private renderOpenArea(loc: MapLocation): void {
    const g = new PIXI.Graphics();
    // Lighter green fill to distinguish from plain grass
    g.roundRect(loc.x, loc.y, loc.width, loc.height, 4)
      .fill({ color: 0x5a9c4f, alpha: 0.5 });
    // Subtle border
    g.roundRect(loc.x, loc.y, loc.width, loc.height, 4)
      .stroke({ color: 0x3d7a2e, width: 1, alpha: 0.6 });
    this.buildingContainer.addChild(g);
  }

  // ---- Labels ----

  private renderLabels(): void {
    if (!this.mapData) return;

    for (const loc of this.mapData.locations) {
      const template = BUILDINGS[loc.type];
      const bx = Math.round(loc.x / TILE_SIZE) * TILE_SIZE;
      const by = Math.round(loc.y / TILE_SIZE) * TILE_SIZE;
      const footW = template && template.widthTiles > 0 ? template.widthTiles * TILE_SIZE : loc.width;
      const footH = template && template.heightTiles > 0 ? template.heightTiles * TILE_SIZE : loc.height;

      const label = new PIXI.Text({ text: loc.name, style: LABEL_STYLE });
      label.anchor.set(0.5, 0);
      label.x = bx + footW / 2;
      label.y = by + footH + 2;
      this.labelContainer.addChild(label);
    }
  }
}
