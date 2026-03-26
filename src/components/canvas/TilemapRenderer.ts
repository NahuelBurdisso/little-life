import * as PIXI from "pixi.js";
import { TILE_SIZE } from "../../lib/spriteConfig";
import { TERRAIN_COLORS } from "../../lib/tileMap";

const MAP_WIDTH_TILES = 40;
const MAP_HEIGHT_TILES = 30;

export class TilemapRenderer {
  container: PIXI.Container;

  private labelContainer: PIXI.Container;
  private occupancyContainer: PIXI.Container;

  private mapWidth: number;
  private mapHeight: number;

  constructor(_app: PIXI.Application) {
    this.mapWidth = MAP_WIDTH_TILES * TILE_SIZE;
    this.mapHeight = MAP_HEIGHT_TILES * TILE_SIZE;

    this.container = new PIXI.Container();
    this.labelContainer = new PIXI.Container();
    this.occupancyContainer = new PIXI.Container();

    this.renderBackground();

    this.container.addChild(this.labelContainer);
    this.container.addChild(this.occupancyContainer);
  }

  getMapSize(): { width: number; height: number } {
    return { width: this.mapWidth, height: this.mapHeight };
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
