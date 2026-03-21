import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { SPRITE_CONFIG } from "../../lib/spriteConfig";

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

const TILE_COLORS: Record<string, number> = {
  grass: 0x4a8c3f,
  path: 0xc2a66b,
  water: 0x3a7ebf,
};

const LOCATION_COLORS: Record<string, number> = {
  home: 0x8b6f47,
  shop: 0xb8860b,
  tavern: 0xa0522d,
  farm: 0x6b8e23,
  clinic: 0xcd5c5c,
  town_hall: 0x708090,
  town_square: 0xbdb76b,
  park: 0x228b22,
};

const LABEL_STYLE = new TextStyle({
  fontFamily: "monospace",
  fontSize: 10,
  fill: 0xffffff,
  stroke: { color: 0x000000, width: 2 },
  align: "center",
});

export class TilemapRenderer {
  container: Container;
  private mapData: MapData | null = null;

  constructor(_app: Application) {
    this.container = new Container();
    this.loadMap();
  }

  private async loadMap() {
    try {
      const resp = await fetch("/maps/default.json");
      this.mapData = await resp.json();
      this.render();
    } catch (err) {
      console.error("Failed to load map:", err);
    }
  }

  private render() {
    if (!this.mapData) return;

    const { tileLayer, tileTypes, tileSize, locations } = this.mapData;

    // Render ground tiles
    const groundGfx = new Graphics();
    for (let row = 0; row < tileLayer.length; row++) {
      for (let col = 0; col < tileLayer[row].length; col++) {
        const tileId = tileLayer[row][col];
        const tileType = tileTypes[String(tileId)];
        const color = TILE_COLORS[tileType?.name ?? "grass"] ?? 0x4a8c3f;

        // Add subtle variation per tile
        const variation = ((row * 7 + col * 13) % 5) * 0x010101;
        const finalColor = color + variation;

        groundGfx.rect(col * tileSize, row * tileSize, tileSize, tileSize).fill(finalColor);
      }
    }
    this.container.addChild(groundGfx);

    // Render location buildings
    for (const loc of locations) {
      const buildingGfx = new Graphics();
      const color = LOCATION_COLORS[loc.type] ?? 0x808080;

      // Building body
      buildingGfx.rect(loc.x, loc.y, loc.width, loc.height).fill(color);

      // Building outline
      buildingGfx
        .rect(loc.x, loc.y, loc.width, loc.height)
        .stroke({ color: 0x000000, width: 1, alpha: 0.4 });

      // Roof accent (darker top strip)
      const roofHeight = Math.min(8, loc.height * 0.15);
      buildingGfx.rect(loc.x, loc.y, loc.width, roofHeight).fill({ color: 0x000000, alpha: 0.3 });

      // Entry marker
      buildingGfx.circle(loc.entryX, loc.entryY, 3).fill(0xffff00);

      this.container.addChild(buildingGfx);

      // Location label
      const label = new Text({ text: loc.name, style: LABEL_STYLE });
      label.anchor.set(0.5, 0);
      label.x = loc.x + loc.width / 2;
      label.y = loc.y + loc.height + 2;
      this.container.addChild(label);
    }
  }

  getMapSize(): { width: number; height: number } {
    if (!this.mapData) {
      return {
        width: 40 * SPRITE_CONFIG.TILE_SIZE,
        height: 30 * SPRITE_CONFIG.TILE_SIZE,
      };
    }
    return {
      width: this.mapData.pixelWidth,
      height: this.mapData.pixelHeight,
    };
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
