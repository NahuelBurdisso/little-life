import * as PIXI from "pixi.js";
import { TILE_SIZE } from "../../lib/spriteConfig";
import { TERRAIN_COLORS } from "../../lib/tileMap";
import { INTERIOR_ZONES } from "../../../server/data/interiors";
import { getTerrainTexture } from "./textures";

import { OPEN_AREA_TYPES } from "../../../server/lib/worldgen/buildingTemplates";

/** Map zone ids to terrain texture keys. Falls back to colored fill when unmapped. */
const ZONE_TEXTURE: Record<string, string> = {
  // Farm
  crops_north: 'crops_summer',
  crops_south: 'crops_summer',
  // Park
  riverside: 'water',
  grove_west: 'grove',
  grove_east: 'grove',
  // Town square
  plaza: 'stone_plaza',
};

// ── Activity dot color map (proposal-readability.md §3d) ─────────────────────
// Green = active/working, yellow = idle/socializing,
// blue = sleeping/resting, red = stressed/in conflict.
// Exported for unit tests.
export function activityDotColor(agent: any): number {
  if (!agent) return 0xeab308; // yellow: unknown → treat as idle
  const action = agent.current_action;
  const actionType: string =
    typeof action === 'string' ? action :
    typeof action === 'object' && action !== null ? (action.type ?? '') : '';

  // Sleeping/resting states
  if (actionType === 'sleep' || actionType === 'rest' || actionType === 'nap') {
    return 0x5a7ac8; // blue
  }
  // Conflict/stress — check active states first
  const states: string[] = (agent.activeStates ?? []).map((s: any) =>
    typeof s === 'string' ? s : s.type,
  );
  if (
    states.includes('angry') || states.includes('stressed') ||
    states.includes('conflict') || actionType === 'fight' || actionType === 'argue'
  ) {
    return 0xcc4444; // red
  }
  // Active / working
  if (
    actionType === 'work' || actionType === 'craft' || actionType === 'farm' ||
    actionType === 'bake' || actionType === 'serve' || actionType === 'treat' ||
    actionType === 'guard' || actionType === 'stock' || actionType === 'cook' ||
    actionType === 'forge' || actionType === 'garden' || actionType === 'fish'
  ) {
    return 0x4a9e6b; // green
  }
  // Idle / socializing / default
  return 0xe8c84a; // yellow
}

export class TilemapRenderer {
  container: PIXI.Container;

  private labelContainer: PIXI.Container;
  private occupancyContainer: PIXI.Container;
  private terrainContainer: PIXI.Container;
  private roadContainer: PIXI.Container;
  private openAreaContainer: PIXI.Container;

  private mapWidth = 0;
  private mapHeight = 0;

  /** Current background child. Null until first resize(). */
  private bg: PIXI.Container | null = null;
  /** Monotonic generation counter — async texture loads compare against this
   *  to detect "I'm stale because resize() was called again". */
  private bgGeneration = 0;

  constructor(_app: PIXI.Application) {
    this.container = new PIXI.Container();
    this.labelContainer = new PIXI.Container();
    this.occupancyContainer = new PIXI.Container();
    this.terrainContainer = new PIXI.Container();
    this.terrainContainer.eventMode = 'none';
    this.roadContainer = new PIXI.Container();
    this.roadContainer.eventMode = 'none';
    this.openAreaContainer = new PIXI.Container();
    this.openAreaContainer.eventMode = 'none';

    // Terrain scatter sits above grass bg but below roads
    this.container.addChild(this.terrainContainer);
    // Road tiles sit above terrain but below open-area zones
    this.container.addChild(this.roadContainer);
    // Open-area zone patches sit above roads but below BuildingRenderer output
    this.container.addChild(this.openAreaContainer);
    this.container.addChild(this.labelContainer);
    this.container.addChild(this.occupancyContainer);
    // Note: renderBackground() is NOT called here; it runs on first resize().
  }

  /** Called when worldState dimensions become available or change. Idempotent. */
  resize(widthTiles: number, heightTiles: number): void {
    const newW = widthTiles * TILE_SIZE;
    const newH = heightTiles * TILE_SIZE;
    if (newW === this.mapWidth && newH === this.mapHeight) return;
    this.mapWidth = newW;
    this.mapHeight = newH;
    this.renderBackground();
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

      // Town square: unified sandstone base so zone patches read as markings
      // on a plaza floor instead of an abstract color mosaic.
      const zoneAlpha = loc.type === 'town_square' ? 0.25 : 0.55;
      if (loc.type === 'town_square' && loc.position?.width) {
        const base = new PIXI.Graphics();
        base.rect(pos.x, pos.y, loc.position.width, loc.position.height)
          .fill({ color: 0xC9B37E, alpha: 0.5 });
        this.openAreaContainer.addChild(base);
      }

      for (const zone of zones) {
        if (!zone.tiles || zone.tiles.length === 0) continue;

        const textureKey = ZONE_TEXTURE[zone.id];
        if (textureKey) {
          // Textured zone: place a sprite per tile. Use a holder container that
          // we can splice into on async load (sprites start invisible, fallback
          // color fill under them).
          const fallback = new PIXI.Graphics();
          for (const [tx, ty] of zone.tiles) {
            const x = pos.x + tx * TILE_SIZE;
            const y = pos.y + ty * TILE_SIZE;
            fallback.rect(x, y, TILE_SIZE, TILE_SIZE).fill({ color: zone.color, alpha: zoneAlpha });
          }
          this.openAreaContainer.addChild(fallback);

          const container = this.openAreaContainer;
          const tilesSnapshot = zone.tiles.slice();
          getTerrainTexture(textureKey)
            ?.then((texture) => {
              if (container.destroyed) return;
              container.removeChild(fallback);
              fallback.destroy();
              const tileGroup = new PIXI.Container();
              for (const [tx, ty] of tilesSnapshot) {
                const sprite = new PIXI.Sprite(texture);
                sprite.x = pos.x + tx * TILE_SIZE;
                sprite.y = pos.y + ty * TILE_SIZE;
                sprite.width = TILE_SIZE;
                sprite.height = TILE_SIZE;
                tileGroup.addChild(sprite);
              }
              container.addChild(tileGroup);
            })
            .catch(() => {
              // Fallback stays.
            });
        } else {
          // Unmapped zone — keep color fill.
          const g = new PIXI.Graphics();
          for (const [tx, ty] of zone.tiles) {
            const x = pos.x + tx * TILE_SIZE;
            const y = pos.y + ty * TILE_SIZE;
            g.rect(x, y, TILE_SIZE, TILE_SIZE).fill({ color: zone.color, alpha: zoneAlpha });
          }
          this.openAreaContainer.addChild(g);
        }
      }
    }
  }

  /**
   * Draw road tiles as colored rectangles (with optional texture upgrade).
   * Idempotent — re-running replaces prior road graphics.
   */
  setRoadTiles(tiles: Array<{ x: number; y: number }>): void {
    for (const child of this.roadContainer.children) child.destroy();
    this.roadContainer.removeChildren();

    if (!Array.isArray(tiles) || tiles.length === 0) return;

    const ROAD_COLOR = 0x6b5a3e;
    const ROAD_EDGE_COLOR = 0x4e4029;

    // Immediate fallback — colored rectangles
    const fallback = new PIXI.Graphics();
    for (const tile of tiles) {
      fallback.rect(tile.x * TILE_SIZE, tile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE)
        .fill({ color: ROAD_COLOR });
    }
    this.roadContainer.addChild(fallback);

    // Edge strips: darker 3px band on any side bordering non-road, so roads
    // read as carved paths instead of flat color bands.
    const roadSet = new Set(tiles.map((t) => `${t.x},${t.y}`));
    const edges = new PIXI.Graphics();
    for (const tile of tiles) {
      const px = tile.x * TILE_SIZE;
      const py = tile.y * TILE_SIZE;
      if (!roadSet.has(`${tile.x},${tile.y - 1}`)) edges.rect(px, py, TILE_SIZE, 3).fill({ color: ROAD_EDGE_COLOR, alpha: 0.8 });
      if (!roadSet.has(`${tile.x},${tile.y + 1}`)) edges.rect(px, py + TILE_SIZE - 3, TILE_SIZE, 3).fill({ color: ROAD_EDGE_COLOR, alpha: 0.8 });
      if (!roadSet.has(`${tile.x - 1},${tile.y}`)) edges.rect(px, py, 3, TILE_SIZE).fill({ color: ROAD_EDGE_COLOR, alpha: 0.8 });
      if (!roadSet.has(`${tile.x + 1},${tile.y}`)) edges.rect(px + TILE_SIZE - 3, py, 3, TILE_SIZE).fill({ color: ROAD_EDGE_COLOR, alpha: 0.8 });
    }
    this.roadContainer.addChild(edges);

    // Async texture upgrade — replace color fill with sprites if a road texture exists
    const container = this.roadContainer;
    const tilesSnapshot = tiles.slice();
    getTerrainTexture('road')
      ?.then((texture) => {
        if (container.destroyed) return;
        container.removeChild(fallback);
        fallback.destroy();
        const tileGroup = new PIXI.Container();
        for (const tile of tilesSnapshot) {
          const sprite = new PIXI.Sprite(texture);
          sprite.x = tile.x * TILE_SIZE;
          sprite.y = tile.y * TILE_SIZE;
          sprite.width = TILE_SIZE;
          sprite.height = TILE_SIZE;
          tileGroup.addChild(sprite);
        }
        container.addChild(tileGroup);
        // Keep edge strips on top of the texture sprites.
        if (!edges.destroyed) container.addChild(edges);
      })
      .catch(() => {
        // Fallback stays.
      });
  }

  /**
   * Draw terrain variety tiles (dirt patches, flowers, tall grass) as colored overlays.
   * Idempotent — re-running replaces prior terrain graphics.
   */
  setTerrainTiles(tiles: Array<{ x: number; y: number; kind: string }>): void {
    for (const child of this.terrainContainer.children) child.destroy();
    this.terrainContainer.removeChildren();

    if (!Array.isArray(tiles) || tiles.length === 0) return;

    const g = new PIXI.Graphics();
    for (const tile of tiles) {
      const px = tile.x * TILE_SIZE;
      const py = tile.y * TILE_SIZE;

      if (tile.kind === 'flowers') {
        // Small pink dots at tile center for a subtle flower look
        g.rect(px, py, TILE_SIZE, TILE_SIZE).fill({ color: 0x3a5a2a, alpha: 0.15 });
        g.circle(px + TILE_SIZE / 2 - 4, py + TILE_SIZE / 2 - 2, 3).fill({ color: 0xc75a8a, alpha: 0.35 });
        g.circle(px + TILE_SIZE / 2 + 4, py + TILE_SIZE / 2 + 2, 3).fill({ color: 0xc75a8a, alpha: 0.35 });
        g.circle(px + TILE_SIZE / 2, py + TILE_SIZE / 2 - 5, 2.5).fill({ color: 0xd98aaa, alpha: 0.3 });
      } else if (tile.kind === 'tall_grass') {
        g.rect(px, py, TILE_SIZE, TILE_SIZE).fill({ color: 0x3a5a2a, alpha: 0.3 });
      } else if (tile.kind === 'dirt_patch') {
        g.rect(px, py, TILE_SIZE, TILE_SIZE).fill({ color: 0x5a4a2e, alpha: 0.4 });
      }
    }
    this.terrainContainer.addChild(g);
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
        // Activity-colored dots (proposal-readability.md §3d):
        //   green = active/working, yellow = idle/socializing,
        //   blue = sleeping/resting, red = stressed/conflict
        const color = activityDotColor(agent);
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
    this.bgGeneration++;
    const myGeneration = this.bgGeneration;

    // Remove previous background child.
    if (this.bg) {
      this.container.removeChild(this.bg);
      this.bg.destroy();
      this.bg = null;
    }

    if (this.mapWidth === 0 || this.mapHeight === 0) return;

    // Immediate fallback — solid color fill so there's something visible before
    // the grass texture finishes loading.
    const fallback = new PIXI.Graphics();
    fallback.rect(0, 0, this.mapWidth, this.mapHeight);
    fallback.fill({ color: TERRAIN_COLORS.grass });
    this.bg = fallback;
    this.container.addChildAt(fallback, 0);

    // Async swap: replace fallback with a TilingSprite once grass texture loads.
    const grass = getTerrainTexture('grass');
    if (!grass) return;
    grass
      .then((texture) => {
        if (this.bgGeneration !== myGeneration) return;
        if (this.container.destroyed) return;
        if (this.bg) {
          this.container.removeChild(this.bg);
          this.bg.destroy();
          this.bg = null;
        }
        const tiling = new PIXI.TilingSprite({
          texture,
          width: this.mapWidth,
          height: this.mapHeight,
        });
        tiling.eventMode = 'none';
        this.bg = tiling;
        this.container.addChildAt(tiling, 0);
      })
      .catch(() => {
        // Keep fallback — no-op on failure.
      });
  }
}
