import * as PIXI from "pixi.js";
import { TILE_SIZE } from "../../lib/spriteConfig";
import { TERRAIN_COLORS } from "../../lib/tileMap";
import { INTERIOR_ZONES } from "../../../server/data/interiors";
import { getTerrainTexture } from "./textures";
import {
  type BlobRaster, type BlobStyle, type Side,
  buildTileSet, classifyRoadTile, connectedComponents, hash2, hasTile, isInsideCell,
  mergeCellRects, rasterizeBlobs,
  CELL_BODY, CELL_EDGE, CELL_HALO, CELL_RING,
} from "../../lib/autotile";

import { OPEN_AREA_TYPES, OUTDOOR_TYPES } from "../../../server/lib/worldgen/buildingTemplates";

// ── Autotiled ground shapes ──────────────────────────────────────────────────
// Roads, dirt patches and junction wear are rasterised on a 2px cell grid
// (src/lib/autotile.ts) and drawn as merged rectangles: every outline is a crisp
// 2px pixel step, which is what the art bible's "2px noise dither at edges" asks
// for, and the cell classes give a lip + dither band that follows bends,
// junctions and staircases without per-shape special cases.
const CELL_PX = 2;
const CELLS_PER_TILE = TILE_SIZE / CELL_PX;

const ROAD_COLOR = 0x6b5a3e;
const ROAD_EDGE_COLOR = 0x4e4029;
const ROAD_DUST_COLOR = 0x85714c;
const DIRT_COLOR = 0x5a4a2e;

/** Roads: square seams, 4px-stepped convex corners, a 4px chamfer on concave
 *  corners (the inside of a bend reads worn-in, and the lip can't notch), and a
 *  10px bridge across diagonal pinches so a staircasing lane stays one band. */
const ROAD_STYLE: BlobStyle = {
  cellsPerTile: CELLS_PER_TILE,
  outerProfile: [2, 1],
  filletSize: 2,
  bridgeSize: 5,
};

/** Junction wear: the old per-tile `roundRect(inset 4, r 8)` patch, but merged
 *  with junction neighbours so a crossing or staircase wears as one patch. */
const WEAR_STYLE: BlobStyle = {
  cellsPerTile: CELLS_PER_TILE,
  inset: () => 2,
  outerProfile: [2, 1],
  filletSize: 2,
  bridgeSize: 0,
};

const SIDE_SALT: Record<Side, number> = { n: 11, e: 23, s: 37, w: 41 };

/** Dirt: exposed sides pull in 4-8px (more top/bottom, so a lone patch reads as
 *  the flattened stain the old ellipse was), jittered per side so merged patches
 *  get a slightly ragged outline instead of a ruled one. */
const DIRT_STYLE: BlobStyle = {
  cellsPerTile: CELLS_PER_TILE,
  inset: (x, y, side) =>
    (side === 'n' || side === 's' ? 3 : 2) + (hash2(x, y, SIDE_SALT[side]) & 1),
  outerProfile: [3, 2, 1],
  filletSize: 2,
  bridgeSize: 0,
};

/** One path + one fill for every raster cell matching `pred` (merged rects never
 *  overlap, so translucent fills don't double up). */
function fillCells(
  g: PIXI.Graphics,
  raster: BlobRaster,
  pred: (cls: number, cx: number, cy: number) => boolean,
  style: { color: number; alpha?: number },
): void {
  const rects = mergeCellRects(raster, pred);
  if (rects.length === 0) return;
  for (const r of rects) g.rect(r.x * CELL_PX, r.y * CELL_PX, r.w * CELL_PX, r.h * CELL_PX);
  g.fill(style);
}

/** Checkerboard parity of a cell: dither only ever lights alternate cells, so
 *  two dithered pixels never touch edge-to-edge and read as texture, not blobs. */
const onChecker = (cx: number, cy: number) => ((cx + cy) & 1) === 0;

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
   * Draw road tiles as an autotiled surface plus a detail layer (wear, ruts,
   * lip, edge dither), with an optional texture upgrade of the surface.
   * Two Graphics total, built once per road set — nothing runs per frame.
   * Idempotent — re-running replaces prior road graphics.
   */
  setRoadTiles(tiles: Array<{ x: number; y: number }>): void {
    // Detach first: `destroy()` splices the child out of `children`, so
    // iterating the live array skips every second entry and leaks it.
    for (const child of this.roadContainer.removeChildren()) child.destroy();
    const myGeneration = ++this.roadGeneration;

    if (!Array.isArray(tiles) || tiles.length === 0) return;

    const roadSet = buildTileSet(tiles);
    const raster = rasterizeBlobs(tiles, ROAD_STYLE);

    // Road surface: the autotiled shape (rounded ends, chamfered bend insides,
    // bridged diagonal steps) as merged rects — a straight road is a few rects.
    const fallback = new PIXI.Graphics();
    fallback.eventMode = 'none';
    fillCells(fallback, raster, isInsideCell, { color: ROAD_COLOR });
    this.roadContainer.addChild(fallback);

    const edges = new PIXI.Graphics();
    edges.eventMode = 'none';

    // Junction wear first so the lip/dither sit on top of it: turning traffic
    // churns crossings, bend corners and staircases into one darker worn patch
    // (r28), merged across neighbouring junction tiles instead of a rounded
    // square per tile.
    const junctions: Array<{ x: number; y: number }> = [];
    const ruts: Array<{ x: number; y: number; axis: 'h' | 'v' }> = [];
    for (const t of tiles) {
      const cls = classifyRoadTile(roadSet, t.x, t.y);
      if (cls === 'junction') junctions.push(t);
      else if (cls === 'h' || cls === 'v') ruts.push({ x: t.x, y: t.y, axis: cls });
    }
    if (junctions.length > 0) {
      fillCells(edges, rasterizeBlobs(junctions, WEAR_STYLE), isInsideCell,
        { color: ROAD_EDGE_COLOR, alpha: 0.18 });
    }

    // Wheel ruts: two worn tracks per lane along straight runs distinguish
    // constructed roads from generic dirt bands (fresh-eyes audit r22). Only on
    // tiles classified straight (long run one way, road-width the other), so
    // ruts run unbroken along a road and stop where it bends or meets another,
    // instead of flickering on and off tile by tile through a staircase. They
    // stop short of a dead end's rounded cap. 10/20px keeps them on the 2px grid.
    const RUT_OFFSET = 10;
    const RUT_END_GAP = 6;
    for (const r of ruts) {
      const px = r.x * TILE_SIZE;
      const py = r.y * TILE_SIZE;
      if (r.axis === 'h') {
        const x0 = px + (hasTile(roadSet, r.x - 1, r.y) ? 0 : RUT_END_GAP);
        const x1 = px + TILE_SIZE - (hasTile(roadSet, r.x + 1, r.y) ? 0 : RUT_END_GAP);
        edges.rect(x0, py + RUT_OFFSET, x1 - x0, 2);
        edges.rect(x0, py + TILE_SIZE - RUT_OFFSET - 2, x1 - x0, 2);
      } else {
        const y0 = py + (hasTile(roadSet, r.x, r.y - 1) ? 0 : RUT_END_GAP);
        const y1 = py + TILE_SIZE - (hasTile(roadSet, r.x, r.y + 1) ? 0 : RUT_END_GAP);
        edges.rect(px + RUT_OFFSET, y0, 2, y1 - y0);
        edges.rect(px + TILE_SIZE - RUT_OFFSET - 2, y0, 2, y1 - y0);
      }
    }
    if (ruts.length > 0) edges.fill({ color: ROAD_EDGE_COLOR, alpha: 0.35 });

    // Carved lip: a solid 2px dark line on the outermost cells, so roads read
    // as cut into the ground rather than as flat colour bands. It follows the
    // rasterised outline, so concave corners close up instead of notching.
    fillCells(edges, raster, (c) => c === CELL_EDGE, { color: ROAD_EDGE_COLOR, alpha: 0.8 });
    // Inner dither band (art bible: "2px noise dither at edges"): a sparse,
    // hash-thinned checkerboard of darker grit and lighter dust just inside the
    // lip softens the step from lip to surface.
    fillCells(edges, raster, (c, cx, cy) =>
      c === CELL_RING && onChecker(cx, cy) && (hash2(cx, cy) & 3) !== 0,
    { color: ROAD_EDGE_COLOR, alpha: 0.4 });
    fillCells(edges, raster, (c, cx, cy) =>
      c === CELL_RING && !onChecker(cx, cy) && hash2(cx, cy, 1) % 3 === 0,
    { color: ROAD_DUST_COLOR, alpha: 0.35 });
    // Outer dither: occasional road-coloured grit kicked onto the verge breaks
    // the ruled line between road and grass.
    fillCells(edges, raster, (c, cx, cy) =>
      c === CELL_HALO && onChecker(cx, cy) && (hash2(cx, cy, 2) & 3) === 0,
    { color: ROAD_COLOR, alpha: 0.6 });

    this.roadContainer.addChild(edges);

    // Async texture upgrade — replace color fill with sprites if a road texture exists
    const container = this.roadContainer;
    const tilesSnapshot = tiles.slice();
    getTerrainTexture('road')
      ?.then((texture) => {
        if (container.destroyed || this.roadGeneration !== myGeneration) return;
        // Sprites are square per tile, so a textured road loses the rounded
        // caps and the fillet/bridge cells outside its tiles; the lip still
        // traces the autotiled outline on top.
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
   * Draw terrain variety tiles. Idempotent — re-running replaces prior terrain
   * graphics. One Graphics for the whole layer.
   *
   * Kinds: `flowers`, `grass_tuft` and `dirt_patch` are flat ground; `tree`,
   * `bush` and `rock` are props placed explicitly by worldgen (trees Poisson-
   * spaced). `tall_grass` is legacy — no longer generated, but worlds saved
   * before worldgen v2 still carry it, and it keeps deriving its trees, bushes
   * and blotches client-side exactly as before. Rocks are also still derived
   * from ~22% of dirt tiles. Worldgen guarantees every terrain tile misses
   * roads, footprints and doorways, so derived props inherit that safety.
   *
   * Two passes: all flat ground first, then every prop sorted by row, so a
   * canopy leaning into the row above always covers that row's ground cover,
   * and a nearer tree covers the trunk of the one behind it.
   */
  setTerrainTiles(tiles: Array<{ x: number; y: number; kind: string }>): void {
    // Detach first: `destroy()` splices the child out of `children`, so
    // iterating the live array skips every second entry and leaks it.
    for (const child of this.terrainContainer.removeChildren()) child.destroy();

    if (!Array.isArray(tiles) || tiles.length === 0) return;

    const g = new PIXI.Graphics();
    g.eventMode = 'none';
    const ordered = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);

    type PropKind = 'tree' | 'bush' | 'rock';
    const props: Array<{ x: number; y: number; kind: PropKind; h: number }> = [];
    const dirt: Array<{ x: number; y: number }> = [];

    // ── Ground pass ──
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
      } else if (tile.kind === 'grass_tuft') {
        this.drawTuft(g, px, py, h);
      } else if (tile.kind === 'tall_grass') {
        // Legacy: ~42% of tall grass grows into a tree, ~40% into a bush, rest
        // stays as the flat blotch — a mix of heights keeps the fields from
        // reading as a uniform stamp.
        const roll = (h >>> 3) % 100;
        if (roll < 42) props.push({ x: tile.x, y: tile.y, kind: 'tree', h });
        else if (roll < 82) props.push({ x: tile.x, y: tile.y, kind: 'bush', h });
        else this.drawBlotch(g, px, py, h, 0x3a5a2a, 0.3);
      } else if (tile.kind === 'dirt_patch') {
        dirt.push(tile);
        // A boulder on some patches gives the bare earth a reason to be bare.
        if ((h >>> 17) % 100 < 22) props.push({ x: tile.x, y: tile.y, kind: 'rock', h });
      } else if (tile.kind === 'tree' || tile.kind === 'bush' || tile.kind === 'rock') {
        props.push({ x: tile.x, y: tile.y, kind: tile.kind, h });
      }
    }

    // Dirt as merged blobs: worldgen clusters dirt into worn patches, and the
    // old per-tile ellipse turned a patch into a string of beads. Each 4-connected
    // patch is rasterised as one shape (autotile inset/rounding/chamfer) with a
    // dithered rim. Flat ground kinds never share a tile, so drawing dirt after
    // the flowers/tufts in this pass doesn't hide anything.
    for (const patch of connectedComponents(dirt)) {
      // Per-patch tone jitter so neighbouring patches aren't identical stamps.
      const first = patch[0];
      const alpha = 0.36 + (hash2(first.x, first.y, 7) % 3) * 0.03;
      const raster = rasterizeBlobs(patch, DIRT_STYLE);
      // Body at full strength; the rim cells alternate full/faded on a
      // checkerboard and a few stray cells land just outside — a soft, dithered
      // edge instead of a ruled one.
      fillCells(g, raster, (c, cx, cy) =>
        c === CELL_BODY || c === CELL_RING || (c === CELL_EDGE && onChecker(cx, cy)),
      { color: DIRT_COLOR, alpha });
      fillCells(g, raster, (c, cx, cy) => c === CELL_EDGE && !onChecker(cx, cy),
        { color: DIRT_COLOR, alpha: alpha * 0.5 });
      fillCells(g, raster, (c, cx, cy) =>
        c === CELL_HALO && onChecker(cx, cy) && hash2(cx, cy, 3) % 3 === 0,
      { color: DIRT_COLOR, alpha: alpha * 0.5 });
    }

    // ── Prop pass ── painter's order by row (stable sort keeps x order within a row).
    props.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const p of props) {
      const px = p.x * TILE_SIZE;
      const py = p.y * TILE_SIZE;
      if (p.kind === 'tree') this.drawTree(g, px, py, p.h);
      else if (p.kind === 'bush') this.drawBush(g, px, py, p.h);
      else this.drawRock(g, px, py, p.h);
    }

    this.terrainContainer.addChild(g);
  }

  /**
   * A small grass tuft: a few 2px blades of uneven height in alternating dark
   * and sun-hit greens over a faint contact shade. Deliberately tiny and
   * low-alpha — tufts are ground texture, not props (art bible: terrain stays
   * background). Every coordinate is on the 2px grid so blades stay crisp.
   */
  private drawTuft(g: PIXI.Graphics, px: number, py: number, h: number): void {
    const clumps = (h >>> 20) % 100 < 45 ? 2 : 1;
    for (let k = 0; k < clumps; k++) {
      const hk = k === 0 ? h : hash2(px, py, 5);
      const baseX = px + 4 + 2 * ((hk >>> 4) % 10);   // 4-22
      const baseY = py + 12 + 2 * ((hk >>> 9) % 8);   // 12-26
      const blades = 3 + ((hk >>> 14) & 1);
      g.rect(baseX - 2, baseY, blades * 2 + 4, 2).fill({ color: 0x2e4a22, alpha: 0.18 });
      for (let i = 0; i < blades; i++) {
        const bh = 2 * (2 + ((hk >>> (16 + i * 2)) & 3)); // 4-10px
        g.rect(baseX + i * 2, baseY - bh, 2, bh).fill(
          i % 2 === 0 ? { color: 0x2e4a22, alpha: 0.5 } : { color: 0x5f7d3c, alpha: 0.4 },
        );
      }
    }
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
