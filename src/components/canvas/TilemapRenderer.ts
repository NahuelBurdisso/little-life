import * as PIXI from "pixi.js";
import { TILE_SIZE } from "../../lib/spriteConfig";
import { TERRAIN_COLORS } from "../../lib/tileMap";
import { INTERIOR_ZONES } from "../../../server/data/interiors";

const MAP_WIDTH_TILES = 60;
const MAP_HEIGHT_TILES = 45;

/** Open-area location types whose interior zones should show as floor textures */
const OPEN_AREA_TYPES = new Set(["farm", "park", "town_square"]);

export class TilemapRenderer {
  container: PIXI.Container;

  private labelContainer: PIXI.Container;
  private occupancyContainer: PIXI.Container;
  private openAreaContainer: PIXI.Container;

  private mapWidth: number;
  private mapHeight: number;

  constructor(_app: PIXI.Application) {
    this.mapWidth = MAP_WIDTH_TILES * TILE_SIZE;
    this.mapHeight = MAP_HEIGHT_TILES * TILE_SIZE;

    this.container = new PIXI.Container();
    this.labelContainer = new PIXI.Container();
    this.occupancyContainer = new PIXI.Container();
    this.openAreaContainer = new PIXI.Container();
    this.openAreaContainer.eventMode = 'none';

    this.renderBackground();

    // Open-area zone patches sit above grass bg but below BuildingRenderer output
    this.container.addChild(this.openAreaContainer);
    this.container.addChild(this.labelContainer);
    this.container.addChild(this.occupancyContainer);
  }

  getMapSize(): { width: number; height: number } {
    return { width: this.mapWidth, height: this.mapHeight };
  }

  /**
   * Draw zone-specific floor patches for open-area locations (farm, park, town_square).
   * Each zone's tiles are rendered with the zone's own color so crop fields, groves,
   * plaza, etc. are visually distinct from the default grass background.
   * Idempotent — re-running replaces prior patches.
   */
  setOpenAreaZones(locations: any[]): void {
    for (const child of this.openAreaContainer.children) child.destroy();
    this.openAreaContainer.removeChildren();

    if (!Array.isArray(locations)) return;

    for (const loc of locations) {
      if (!OPEN_AREA_TYPES.has(loc.type)) continue;
      const zones = INTERIOR_ZONES[loc.type];
      if (!zones || zones.length === 0) continue;

      const pos = loc.position ?? { x: 0, y: 0 };

      for (const zone of zones) {
        if (!zone.tiles || zone.tiles.length === 0) continue;
        const g = new PIXI.Graphics();
        for (const [tx, ty] of zone.tiles) {
          const x = pos.x + tx * TILE_SIZE;
          const y = pos.y + ty * TILE_SIZE;
          g.rect(x, y, TILE_SIZE, TILE_SIZE).fill({ color: zone.color, alpha: 0.55 });
        }
        this.openAreaContainer.addChild(g);
      }
    }
  }

  updateOccupancy(agents: any[], locations: any[]): void {
    for (const child of this.occupancyContainer.children) child.destroy();
    this.occupancyContainer.removeChildren();

    for (const loc of locations) {
      const occupants = loc.current_occupants ?? [];
      if (occupants.length === 0) continue;
      const dotCount = Math.min(occupants.length, 5);
      const pos = loc.position ?? { x: 0, y: 0, width: 0, height: 0 };
      const centerX = pos.x + pos.width / 2;
      const y = pos.y + pos.height + 14;
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

  // ---- Private ----

  private renderBackground(): void {
    const bg = new PIXI.Graphics();
    bg.rect(0, 0, this.mapWidth, this.mapHeight);
    bg.fill({ color: TERRAIN_COLORS.grass });
    this.container.addChild(bg);
  }
}
