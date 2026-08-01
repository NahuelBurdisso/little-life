import * as PIXI from "pixi.js";
import { TILE_SIZE } from "../../lib/spriteConfig";
import { TERRAIN_COLORS } from "../../lib/tileMap";
import { INTERIOR_ZONES } from "../../../server/data/interiors";
import { getTerrainTexture } from "./textures";

import { OPEN_AREA_TYPES, OUTDOOR_TYPES } from "../../../server/lib/worldgen/buildingTemplates";

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
  // The verb-like labels (cook, garden, fish…) live here, not in `type`: the
  // server's action types are the closed set in server/lib/types.ts.
  const zoneActivity: string =
    typeof action === 'object' && action !== null ? (action.zoneActivity ?? '') : '';

  // Sleeping/resting states
  if (actionType === 'sleeping' || zoneActivity === 'rest') {
    return 0x5a7ac8; // blue
  }
  // Conflict/stress — check active states first
  const states: string[] = (agent.activeStates ?? []).map((s: any) =>
    typeof s === 'string' ? s : s.type,
  );
  if (
    states.includes('angry') || states.includes('stressed') ||
    states.includes('conflict')
  ) {
    return 0xcc4444; // red
  }
  // Active / working
  if (
    actionType === 'working' ||
    zoneActivity === 'jog' || zoneActivity === 'garden' || zoneActivity === 'fish' ||
    zoneActivity === 'forage' || zoneActivity === 'perform'
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
  private doorPathContainer: PIXI.Container;
  private openAreaContainer: PIXI.Container;

  private mapWidth = 0;
  private mapHeight = 0;

  /** Current background child. Null until first resize(). */
  private bg: PIXI.Container | null = null;
  /** Grass value micro-variation overlay — rebuilt with the background. */
  private grassNoise: PIXI.Graphics | null = null;
  /** Monotonic generation counter — async texture loads compare against this
   *  to detect "I'm stale because resize() was called again". */
  private bgGeneration = 0;
  /** Same guard as `bgGeneration`, for the layers with async texture upgrades:
   *  a redraw while a texture fetch is in flight would otherwise let the stale
   *  callback add a duplicate tile group to the freshly cleared container. */
  private zoneGeneration = 0;
  private roadGeneration = 0;

  constructor(_app: PIXI.Application) {
    this.container = new PIXI.Container();
    this.labelContainer = new PIXI.Container();
    this.occupancyContainer = new PIXI.Container();
    this.terrainContainer = new PIXI.Container();
    this.terrainContainer.eventMode = 'none';
    this.roadContainer = new PIXI.Container();
    this.roadContainer.eventMode = 'none';
    this.doorPathContainer = new PIXI.Container();
    this.doorPathContainer.eventMode = 'none';
    this.openAreaContainer = new PIXI.Container();
    this.openAreaContainer.eventMode = 'none';

    // Terrain scatter sits above grass bg but below roads
    this.container.addChild(this.terrainContainer);
    // Worn door-to-road paths sit above terrain but below road surfaces
    this.container.addChild(this.doorPathContainer);
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
    // Detach first: `destroy()` splices the child out of `children`, so
    // iterating the live array skips every second entry and leaks it.
    for (const child of this.openAreaContainer.removeChildren()) child.destroy();
    const myGeneration = ++this.zoneGeneration;

    if (!Array.isArray(locations)) return;

    for (const loc of locations) {
      if (!OPEN_AREA_TYPES.has(loc.type)) continue;
      const zones = INTERIOR_ZONES[loc.type];
      if (!zones || zones.length === 0) continue;

      const pos = loc.position ?? { x: 0, y: 0 };

      // Town square: unified sandstone base so zone patches read as markings
      // on a plaza floor instead of an abstract color mosaic.
      const zoneAlpha = loc.type === 'town_square' ? 0.14 : 0.55;
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
              if (container.destroyed || this.zoneGeneration !== myGeneration) return;
              // Take the fallback's slot rather than appending: zones drawn
              // later in the same pass are already above it, and adding to the
              // top would let this one cover them once the texture resolves.
              const slot = container.getChildIndex(fallback);
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
              container.addChildAt(tileGroup, Math.min(slot, container.children.length));
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
   * Draw worn dirt paths from each building door to the nearest road tile.
   * Implies foot-traffic history — buildings no longer float on untouched grass.
   * Idempotent — re-running replaces prior paths.
   */
  setDoorPaths(locations: any[], roadTiles: Array<{ x: number; y: number }>): void {
    // Detach first: `destroy()` splices the child out of `children`, so
    // iterating the live array skips every second entry and leaks it.
    for (const child of this.doorPathContainer.removeChildren()) child.destroy();
    if (!Array.isArray(locations) || !Array.isArray(roadTiles) || roadTiles.length === 0) return;

    const g = new PIXI.Graphics();
    const PATH_W = 10;
    const PATH_COLOR = 0x8a7248; // packed earth
    const PATH_ALPHA = 0.5;

    for (const loc of locations) {
      // OUTDOOR_TYPES: the derived locations were drawing a footpath from their
      // door to the nearest road — including Main Street, which drew a path to
      // itself.
      if (OUTDOOR_TYPES.has(loc.type)) continue;
      const pos = loc.position;
      const ep = loc.entry_point;
      if (!pos?.width || !ep) continue;

      // Nearest road tile center (Manhattan)
      let bx = 0, by = 0, bestD = Infinity;
      for (const t of roadTiles) {
        const cx = t.x * TILE_SIZE + TILE_SIZE / 2;
        const cy = t.y * TILE_SIZE + TILE_SIZE / 2;
        const d = Math.abs(cx - ep.x) + Math.abs(cy - ep.y);
        if (d < bestD) { bestD = d; bx = cx; by = cy; }
      }
      if (bestD > TILE_SIZE * 10) continue; // building far from any road — skip

      // Door on top/bottom edge → leave vertically first; else horizontally first
      const vertFirst =
        Math.abs(ep.y - pos.y) < 6 || Math.abs(ep.y - (pos.y + pos.height)) < 6;

      if (vertFirst) {
        // vertical leg at door x, then horizontal leg at road y
        g.rect(ep.x - PATH_W / 2, Math.min(ep.y, by), PATH_W, Math.abs(by - ep.y) + PATH_W / 2)
          .fill({ color: PATH_COLOR, alpha: PATH_ALPHA });
        if (Math.abs(bx - ep.x) > PATH_W / 2) {
          g.rect(Math.min(ep.x, bx) - PATH_W / 2, by - PATH_W / 2, Math.abs(bx - ep.x) + PATH_W, PATH_W)
            .fill({ color: PATH_COLOR, alpha: PATH_ALPHA });
        }
      } else {
        // horizontal leg at door y, then vertical leg at road x
        g.rect(Math.min(ep.x, bx), ep.y - PATH_W / 2, Math.abs(bx - ep.x) + PATH_W / 2, PATH_W)
          .fill({ color: PATH_COLOR, alpha: PATH_ALPHA });
        if (Math.abs(by - ep.y) > PATH_W / 2) {
          g.rect(bx - PATH_W / 2, Math.min(ep.y, by) - PATH_W / 2, PATH_W, Math.abs(by - ep.y) + PATH_W)
            .fill({ color: PATH_COLOR, alpha: PATH_ALPHA });
        }
      }
    }

    this.doorPathContainer.addChild(g);
  }

  /**
   * Draw road tiles as colored rectangles (with optional texture upgrade).
   * Idempotent — re-running replaces prior road graphics.
   */
  setRoadTiles(tiles: Array<{ x: number; y: number }>): void {
    // Detach first: `destroy()` splices the child out of `children`, so
    // iterating the live array skips every second entry and leaks it.
    for (const child of this.roadContainer.removeChildren()) child.destroy();
    const myGeneration = ++this.roadGeneration;

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

      // Wheel ruts: two worn tracks along straight road segments distinguish
      // constructed roads from generic dirt bands (fresh-eyes audit r22).
      // Intersections (road both axes) stay rut-free.
      const horiz = roadSet.has(`${tile.x - 1},${tile.y}`) && roadSet.has(`${tile.x + 1},${tile.y}`);
      const vert = roadSet.has(`${tile.x},${tile.y - 1}`) && roadSet.has(`${tile.x},${tile.y + 1}`);
      if (horiz && !vert) {
        edges.rect(px, py + 9, TILE_SIZE, 2).fill({ color: ROAD_EDGE_COLOR, alpha: 0.35 });
        edges.rect(px, py + TILE_SIZE - 11, TILE_SIZE, 2).fill({ color: ROAD_EDGE_COLOR, alpha: 0.35 });
      } else if (vert && !horiz) {
        edges.rect(px + 9, py, 2, TILE_SIZE).fill({ color: ROAD_EDGE_COLOR, alpha: 0.35 });
        edges.rect(px + TILE_SIZE - 11, py, 2, TILE_SIZE).fill({ color: ROAD_EDGE_COLOR, alpha: 0.35 });
      } else if (vert && horiz) {
        // Intersection wear: turning traffic churns the crossing into a
        // darker worn patch instead of pristine grid squares (r28).
        edges.roundRect(px + 4, py + 4, TILE_SIZE - 8, TILE_SIZE - 8, 8)
          .fill({ color: ROAD_EDGE_COLOR, alpha: 0.18 });
      }
    }
    this.roadContainer.addChild(edges);

    // Async texture upgrade — replace color fill with sprites if a road texture exists
    const container = this.roadContainer;
    const tilesSnapshot = tiles.slice();
    getTerrainTexture('road')
      ?.then((texture) => {
        if (container.destroyed || this.roadGeneration !== myGeneration) return;
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
   * Draw terrain variety tiles (dirt patches, flowers, tall grass, and the trees,
   * bushes and rocks derived from them). Idempotent — re-running replaces prior
   * terrain graphics.
   *
   * Trees and bushes are *derived* client-side from the `tall_grass` tiles rather
   * than being their own worldgen kind, and rocks from `dirt_patch`. Worldgen has
   * already guaranteed those tiles miss every road, footprint and doorway, so the
   * props inherit that placement safety — and worlds generated before props
   * existed grow them without a regenerate.
   */
  setTerrainTiles(tiles: Array<{ x: number; y: number; kind: string }>): void {
    // Detach first: `destroy()` splices the child out of `children`, so
    // iterating the live array skips every second entry and leaks it.
    for (const child of this.terrainContainer.removeChildren()) child.destroy();

    if (!Array.isArray(tiles) || tiles.length === 0) return;

    const g = new PIXI.Graphics();
    // Painter's order: a prop on a lower row must overlap the one above it, or
    // the higher tree's canopy sits on top of the nearer tree's trunk.
    const ordered = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);

    for (const tile of ordered) {
      const px = tile.x * TILE_SIZE;
      const py = tile.y * TILE_SIZE;
      const h = (tile.x * 73856093) ^ (tile.y * 19349663);

      if (tile.kind === 'flowers') {
        // Small pink dots at tile center for a subtle flower look
        g.rect(px, py, TILE_SIZE, TILE_SIZE).fill({ color: 0x3a5a2a, alpha: 0.15 });
        g.circle(px + TILE_SIZE / 2 - 4, py + TILE_SIZE / 2 - 2, 3).fill({ color: 0xc75a8a, alpha: 0.35 });
        g.circle(px + TILE_SIZE / 2 + 4, py + TILE_SIZE / 2 + 2, 3).fill({ color: 0xc75a8a, alpha: 0.35 });
        g.circle(px + TILE_SIZE / 2, py + TILE_SIZE / 2 - 5, 2.5).fill({ color: 0xd98aaa, alpha: 0.3 });
      } else if (tile.kind === 'tall_grass') {
        // ~30% of tall grass grows into a tree, ~35% into a bush, rest stays as
        // the flat blotch — a mix of heights keeps the fields from reading as a
        // uniform stamp.
        const roll = (h >>> 3) % 100;
        if (roll < 42) this.drawTree(g, px, py, h);
        else if (roll < 82) this.drawBush(g, px, py, h);
        else this.drawBlotch(g, px, py, h, 0x3a5a2a, 0.3);
      } else if (tile.kind === 'dirt_patch') {
        this.drawBlotch(g, px, py, h, 0x5a4a2e, 0.4);
        // A boulder on some patches gives the bare earth a reason to be bare.
        if ((h >>> 17) % 100 < 22) this.drawRock(g, px, py, h);
      }
    }
    this.terrainContainer.addChild(g);
  }

  /**
   * Flat ground stain, size/offset jittered so scatter reads as organic growth.
   * Elliptical, not a rounded rect: at 20-32px a radius-4 corner is barely a
   * corner, so the old version stamped visible squares onto the grass.
   */
  private drawBlotch(g: PIXI.Graphics, px: number, py: number, h: number, color: number, alpha: number): void {
    const size = TILE_SIZE * (0.6 + ((h >>> 3) % 40) / 100); // 60-100%
    const ox = (h >>> 8) % (TILE_SIZE - size + 1);
    const oy = (h >>> 13) % (TILE_SIZE - size + 1);
    g.ellipse(px + ox + size / 2, py + oy + size / 2, size / 2, size * 0.4).fill({ color, alpha });
  }

  /**
   * A small deciduous tree, rooted at the bottom of its tile so the canopy leans
   * up into the tile above. Kept under ~26px tall: taller canopies reach far
   * enough to clip the south wall of a building on the row above.
   */
  private drawTree(g: PIXI.Graphics, px: number, py: number, h: number): void {
    const cx = px + TILE_SIZE / 2 + (((h >>> 5) % 7) - 3);
    const rootY = py + TILE_SIZE - 4;
    const r = 8 + ((h >>> 9) % 3); // canopy radius 8-10

    g.ellipse(cx + 3, rootY + 1, r * 0.9, r * 0.34).fill({ color: 0x1a2412, alpha: 0.3 });
    g.rect(cx - 2, rootY - 9, 4, 9).fill({ color: 0x4a3520 });
    // Three overlapping lobes make a fuller silhouette than one circle.
    g.circle(cx - r * 0.55, rootY - 13, r * 0.75).fill({ color: 0x2c4620 });
    g.circle(cx + r * 0.55, rootY - 13, r * 0.75).fill({ color: 0x2c4620 });
    g.circle(cx, rootY - 17, r).fill({ color: 0x35542a });
    // Sun-hit highlight, up-left to match the drop shadows cast down-right.
    g.circle(cx - r * 0.35, rootY - 19, r * 0.45).fill({ color: 0x4d7336, alpha: 0.85 });
  }

  /** Low shrub — two lobes and a contact shadow. */
  private drawBush(g: PIXI.Graphics, px: number, py: number, h: number): void {
    const cx = px + TILE_SIZE / 2 + (((h >>> 5) % 9) - 4);
    const cy = py + TILE_SIZE / 2 + (((h >>> 11) % 9) - 4);
    const r = 5 + ((h >>> 15) % 3);

    g.ellipse(cx + 2, cy + r * 0.7, r * 1.2, r * 0.4).fill({ color: 0x1a2412, alpha: 0.25 });
    g.circle(cx - r * 0.5, cy, r * 0.85).fill({ color: 0x2f4a24 });
    g.circle(cx + r * 0.5, cy, r * 0.85).fill({ color: 0x2f4a24 });
    g.circle(cx, cy - r * 0.4, r * 0.8).fill({ color: 0x3d6029 });
    g.circle(cx - r * 0.3, cy - r * 0.6, r * 0.35).fill({ color: 0x51793a, alpha: 0.8 });
  }

  /** Weathered boulder sitting in a dirt patch. */
  private drawRock(g: PIXI.Graphics, px: number, py: number, h: number): void {
    const cx = px + TILE_SIZE / 2 + (((h >>> 21) % 7) - 3);
    const cy = py + TILE_SIZE / 2 + (((h >>> 25) % 7) - 3);
    const r = 4 + ((h >>> 19) % 3);

    g.ellipse(cx + 2, cy + r * 0.6, r * 1.1, r * 0.35).fill({ color: 0x1a2412, alpha: 0.25 });
    g.ellipse(cx, cy, r, r * 0.8).fill({ color: 0x6b6459 });
    g.ellipse(cx - r * 0.25, cy - r * 0.25, r * 0.5, r * 0.35).fill({ color: 0x8b8377 });
  }

  updateOccupancy(agents: any[], locations: any[]): void {
    // Detach first: `destroy()` splices the child out of `children`, so
    // iterating the live array skips every second entry and leaks it.
    for (const child of this.occupancyContainer.removeChildren()) child.destroy();

    // Occupancy comes from the live agent list, not `loc.current_occupants`:
    // `locations.getAll` is fetched once and never invalidated, so that column
    // is a permanently empty snapshot and these dots never rendered at all.
    const byLocation = new Map<number, any[]>();
    for (const agent of agents) {
      const locId = agent.current_location;
      if (locId == null) continue;
      const list = byLocation.get(locId);
      if (list) list.push(agent);
      else byLocation.set(locId, [agent]);
    }

    for (const loc of locations) {
      const occupants = byLocation.get(loc.id) ?? [];
      if (occupants.length === 0) continue;
      const dotCount = Math.min(occupants.length, 5);
      const pos = loc.position ?? { x: 0, y: 0, width: 0, height: 0 };
      const centerX = pos.x + pos.width / 2;
      // Clear of the building name label, which BuildingRenderer anchors at
      // `height + 2` and runs ~10px tall — at +14 the dots clipped its descenders
      // from behind (the tilemap layer draws under the label layer).
      const y = pos.y + pos.height + 20;
      const startX = centerX - (dotCount * 6) / 2;
      for (let i = 0; i < dotCount; i++) {
        const agent = occupants[i];
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

    // Grass value micro-variation: sparse low-alpha blotches (lighter sun-hit
    // and darker shade tones) break the flat single-hue field so ground reads
    // as ground, not a filled rectangle (fresh-eyes audit r29). Deterministic
    // per-cell hash keeps it stable across rebuilds. Sits just above the bg
    // (index 1) so roads/zones/buildings still cover it.
    if (this.grassNoise) {
      this.container.removeChild(this.grassNoise);
      this.grassNoise.destroy();
      this.grassNoise = null;
    }
    const noise = new PIXI.Graphics();
    const CELL = 64;
    for (let cx = 0; cx < this.mapWidth; cx += CELL) {
      for (let cy = 0; cy < this.mapHeight; cy += CELL) {
        const h = ((cx / CELL) * 73856093) ^ ((cy / CELL) * 19349663);
        if ((h >>> 4) % 10 >= 4) continue; // ~40% of cells get a blotch
        const size = 24 + ((h >>> 7) % 25); // 24-48px
        const ox = (h >>> 11) % (CELL - 16);
        const oy = (h >>> 16) % (CELL - 16);
        const light = ((h >>> 21) & 1) === 0;
        noise.roundRect(cx + ox, cy + oy, size, size, 10).fill({
          color: light ? 0x9ab55a : 0x2e4a22,
          alpha: light ? 0.06 : 0.08,
        });
      }
    }
    // Impassable perimeter. `generateCollisionGridForLocations` blocks the
    // outermost tile ring, but nothing drew it, so agents stopped dead at an
    // invisible wall one tile inside the visible edge. Dark overgrowth band +
    // an inner shadow so the boundary reads as a treeline rather than lawn.
    const R = TILE_SIZE;
    for (const [bx, by, bw, bh] of [
      [0, 0, this.mapWidth, R],
      [0, this.mapHeight - R, this.mapWidth, R],
      [0, 0, R, this.mapHeight],
      [this.mapWidth - R, 0, R, this.mapHeight],
    ]) {
      noise.rect(bx, by, bw, bh).fill({ color: 0x1e3318, alpha: 0.85 });
    }
    noise.rect(R, R, this.mapWidth - 2 * R, this.mapHeight - 2 * R)
      .stroke({ width: 3, color: 0x16260f, alpha: 0.45 });

    this.grassNoise = noise;
    this.container.addChildAt(noise, 1);

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
