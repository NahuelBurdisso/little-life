import * as PIXI from "pixi.js";
import { TILE_SIZE } from "../../lib/spriteConfig";
import { TERRAIN_COLORS } from "../../lib/tileMap";
import { INTERIOR_ZONES } from "../../../server/data/interiors";
import { getTerrainTexture } from "./textures";
import { loadStrip } from "./stripAtlas";
import { CROP_STAGE_COUNT, CROP_TILE_SIZE, CROP_URL, cropCell } from "./crops";
import { PROPS_URL, PROP_FRAME_COUNT, propFrame, type PropSpriteKind } from "./propFrames";
import {
  type BlobRaster, type BlobStyle, type SoftBlobStyle,
  bucketCellRects, buildTileSet, classifyRoadTile, connectedComponents, hash2, hasTile,
  isInsideCell, isOffMap, rasterizeBlobs, rasterizeSoftBlob, uniqueTiles,
  CELL_EDGE, CELL_HALO, CELL_RING,
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
/** Trodden earth: a notch lighter and warmer than the road so a worn patch
 *  never reads as a stub of street, and near-opaque — at the old 0x5a4a2e/α.4
 *  the grass texture showed through as a muddy grey-olive. */
const DIRT_COLOR = 0x7d6a48;
const DIRT_PEBBLE_COLOR = 0x5c4a32;
const DIRT_DUST_COLOR = 0x9a845c;

/** Terrain kinds only worldgen v2 emits — their presence marks a v2 world. */
const V2_TERRAIN_KINDS: ReadonlySet<string> = new Set(['grass_tuft', 'tree', 'bush', 'rock']);

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

/** Dirt: one organic blob per patch (`rasterizeSoftBlob`). A lone tile comes
 *  out a ~26px lopsided oval; neighbours melt into one shape with soft inside
 *  curves. Tuned on ASCII rasters: at threshold .9 lone tiles shrank to specks;
 *  a 3-cell bleed cap cut ruler-straight edges along clusters; and a ±.14
 *  wobble on 5-cell noise left a 2×2 patch a rounded square with 18-cell
 *  straight sides. ±.24 on 7-cell noise makes it lopsided. */
const DIRT_STYLE: SoftBlobStyle = {
  cellsPerTile: CELLS_PER_TILE,
  radius: 1.3,
  threshold: 0.74,
  noiseAmp: 0.24,
  noiseCells: 7,
  maxBleed: 4,
  salt: 29,
};

/** Sort raster cells into buckets in one scan, then one path + one fill per
 *  bucket (`styles[i]` fills bucket i + 1). Merged rects never overlap, so
 *  translucent fills don't double up. */
function fillCellBuckets(
  g: PIXI.Graphics,
  raster: BlobRaster,
  bucket: (cls: number, cx: number, cy: number) => number,
  styles: ReadonlyArray<{ color: number; alpha?: number }>,
): void {
  const buckets = bucketCellRects(raster, bucket, styles.length);
  buckets.forEach((rects, i) => {
    if (rects.length === 0) return;
    for (const r of rects) g.rect(r.x * CELL_PX, r.y * CELL_PX, r.w * CELL_PX, r.h * CELL_PX);
    g.fill(styles[i]);
  });
}

const insideBucket = (cls: number) => (isInsideCell(cls) ? 1 : 0);

/** Checkerboard parity of a cell: dither only ever lights alternate cells, so
 *  two dithered pixels never touch edge-to-edge and read as texture, not blobs. */
const onChecker = (cx: number, cy: number) => ((cx + cy) & 1) === 0;

/** Map zone ids to terrain texture keys. Falls back to colored fill when unmapped. */
const ZONE_TEXTURE: Record<string, string> = {
  // Farm crops are not here: their tile follows the season (see `setCropSeason`).
  // Park
  riverside: 'river',
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
  // A plain loop: this runs for every occupant on every data refresh.
  const activeStates: any[] = agent.activeStates ?? [];
  for (let i = 0; i < activeStates.length; i++) {
    const s = activeStates[i];
    const state: string = typeof s === 'string' ? s : s.type;
    if (state === 'angry' || state === 'stressed' || state === 'conflict') {
      return 0xcc4444; // red
    }
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

/** Dots drawn per building; further occupants still count as inside but get no dot. */
const OCCUPANCY_MAX_DOTS = 5;

export class TilemapRenderer {
  container: PIXI.Container;

  private labelContainer: PIXI.Container;
  private occupancyContainer: PIXI.Container;
  /** Pooled dot Graphics (children of `occupancyContainer`), grown on demand, hidden when unused. */
  private occupancyDots: PIXI.Graphics[] = [];
  /** Fill colour each pooled dot currently shows, so a dot only redraws when its colour changes. */
  private occupancyDotColors: number[] = [];
  private occupantScratch: any[] = [];
  private terrainContainer: PIXI.Container;
  private roadContainer: PIXI.Container;
  private doorPathContainer: PIXI.Container;
  private openAreaContainer: PIXI.Container;

  /** Tile sprites of the farm's crop fields, retextured whenever the season's stage changes. */
  private cropSprites: PIXI.Sprite[] = [];
  private cropTextures: PIXI.Texture[] | null = null;
  private cropTexturesRequested = false;
  /** Cell of the crop strip on show; summer until the world says otherwise. */
  private cropCellIdx = cropCell('summer', 14);

  private mapWidth = 0;
  private mapHeight = 0;

  /** Current background child. Null until first resize(). */
  private bg: PIXI.Container | null = null;
  /** Grass value micro-variation overlay — rebuilt with the background. */
  private grassNoise: PIXI.Graphics | null = null;
  /** Monotonic generation counter — async texture loads compare against this
   *  to detect "I'm stale because resize() was called again". */
  private bgGeneration = 0;
  /** Same guard as `bgGeneration`, for the zone layer's async texture upgrade:
   *  a redraw while a texture fetch is in flight would otherwise let the stale
   *  callback add a duplicate tile group to the freshly cleared container. */
  private zoneGeneration = 0;
  /** Bumped per `setTerrainTiles`, so a prop atlas that resolves late skips stale tiles. */
  private terrainGeneration = 0;

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
    this.cropSprites = [];
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

        if (loc.type === 'farm' && zone.id.startsWith('crops_')) {
          this.addCropField(pos, zone, zoneAlpha);
          continue;
        }

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
   * One crop field: a flat colour first (what shows until the strip loads, or forever if it
   * fails), then a tile sprite per zone tile that `applyCrops` textures for the current season.
   */
  private addCropField(pos: { x: number; y: number }, zone: { tiles: [number, number][]; color: number }, alpha: number): void {
    const fallback = new PIXI.Graphics();
    const group = new PIXI.Container();
    for (const [tx, ty] of zone.tiles) {
      const x = pos.x + tx * TILE_SIZE;
      const y = pos.y + ty * TILE_SIZE;
      fallback.rect(x, y, TILE_SIZE, TILE_SIZE).fill({ color: zone.color, alpha });
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.position.set(x, y);
      sprite.width = TILE_SIZE;
      sprite.height = TILE_SIZE;
      sprite.visible = false;
      group.addChild(sprite);
      this.cropSprites.push(sprite);
    }
    this.openAreaContainer.addChild(fallback);
    this.openAreaContainer.addChild(group);
    this.ensureCropTextures();
    this.applyCrops();
  }

  private ensureCropTextures(): void {
    if (this.cropTextures || this.cropTexturesRequested) return;
    this.cropTexturesRequested = true;
    loadStrip(CROP_URL, CROP_STAGE_COUNT, CROP_TILE_SIZE)
      .then((tex) => { this.cropTextures = tex; this.applyCrops(); })
      // Allow a retry on the next redraw instead of pinning the flat colour for the session.
      .catch(() => { this.cropTexturesRequested = false; });
  }

  private applyCrops(): void {
    const tex = this.cropTextures?.[this.cropCellIdx];
    if (!tex) return;
    for (const sprite of this.cropSprites) {
      if (sprite.destroyed) continue;
      sprite.texture = tex;
      sprite.visible = true;
    }
  }

  /**
   * Point the farm's fields at the season: bare rows and sprouts in spring, green through
   * summer, gold then stubble in autumn, snow in winter, three stages each. Cheap and
   * idempotent — it only touches the sprites when the stage actually changes.
   */
  setCropSeason(season: unknown, seasonDay?: number | null): void {
    const cell = cropCell(season, seasonDay);
    if (cell === this.cropCellIdx) return;
    this.cropCellIdx = cell;
    this.applyCrops();
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
   * lip, edge dither). Two Graphics total, built once per road set — nothing
   * runs per frame. Idempotent — re-running replaces prior road graphics.
   *
   * Roads are procedural only. There used to be a per-tile texture upgrade
   * here, but no road texture ever shipped, and square tile sprites would undo
   * the autotiled shape (caps, chamfers, diagonal bridges) anyway.
   */
  setRoadTiles(rawTiles: Array<{ x: number; y: number }>): void {
    // Detach first: `destroy()` splices the child out of `children`, so
    // iterating the live array skips every second entry and leaks it.
    for (const child of this.roadContainer.removeChildren()) child.destroy();

    if (!Array.isArray(rawTiles) || rawTiles.length === 0) return;
    // Worldgen lists crossing tiles once per road; drawn twice, a translucent
    // rut would come out darker on exactly those tiles.
    const tiles = uniqueTiles(rawTiles);

    // Off-map neighbours count as road, so a road meeting the map edge runs
    // off it instead of ending in a rounded, lipped cap. Unknown until resize().
    const bounds = this.mapWidth > 0 && this.mapHeight > 0
      ? { width: Math.round(this.mapWidth / TILE_SIZE), height: Math.round(this.mapHeight / TILE_SIZE) }
      : undefined;
    const roadSet = buildTileSet(tiles);
    const roadAt = (x: number, y: number) =>
      hasTile(roadSet, x, y) || (bounds !== undefined && isOffMap(bounds, x, y));
    const raster = rasterizeBlobs(tiles, { ...ROAD_STYLE, bounds });

    // Road surface: the autotiled shape (rounded ends, chamfered bend insides,
    // bridged diagonal steps) as merged rects — a straight road is a few rects.
    const surface = new PIXI.Graphics();
    surface.eventMode = 'none';
    fillCellBuckets(surface, raster, insideBucket, [{ color: ROAD_COLOR }]);
    this.roadContainer.addChild(surface);

    const edges = new PIXI.Graphics();
    edges.eventMode = 'none';

    // Junction wear first so the lip/dither sit on top of it: turning traffic
    // churns crossings, bend corners and staircases into one darker worn patch
    // (r28), merged across neighbouring junction tiles instead of a rounded
    // square per tile.
    const junctions: Array<{ x: number; y: number }> = [];
    const ruts: Array<{ x: number; y: number; axis: 'h' | 'v' }> = [];
    for (const t of tiles) {
      const cls = classifyRoadTile(roadSet, t.x, t.y, bounds);
      if (cls === 'junction') junctions.push(t);
      else if (cls === 'h' || cls === 'v') ruts.push({ x: t.x, y: t.y, axis: cls });
    }
    if (junctions.length > 0) {
      fillCellBuckets(edges, rasterizeBlobs(junctions, { ...WEAR_STYLE, bounds }), insideBucket,
        [{ color: ROAD_EDGE_COLOR, alpha: 0.18 }]);
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
        const x0 = px + (roadAt(r.x - 1, r.y) ? 0 : RUT_END_GAP);
        const x1 = px + TILE_SIZE - (roadAt(r.x + 1, r.y) ? 0 : RUT_END_GAP);
        edges.rect(x0, py + RUT_OFFSET, x1 - x0, 2);
        edges.rect(x0, py + TILE_SIZE - RUT_OFFSET - 2, x1 - x0, 2);
      } else {
        const y0 = py + (roadAt(r.x, r.y - 1) ? 0 : RUT_END_GAP);
        const y1 = py + TILE_SIZE - (roadAt(r.x, r.y + 1) ? 0 : RUT_END_GAP);
        edges.rect(px + RUT_OFFSET, y0, 2, y1 - y0);
        edges.rect(px + TILE_SIZE - RUT_OFFSET - 2, y0, 2, y1 - y0);
      }
    }
    if (ruts.length > 0) edges.fill({ color: ROAD_EDGE_COLOR, alpha: 0.35 });

    // Outline detail, one raster scan for all four buckets:
    // 1. Carved lip: a solid 2px dark line on the outermost cells, so roads read
    //    as cut into the ground rather than as flat colour bands. It follows the
    //    rasterised outline, so concave corners close up instead of notching.
    // 2-3. Inner dither band (art bible: "2px noise dither at edges"): a sparse,
    //    hash-thinned checkerboard of darker grit and lighter dust just inside
    //    the lip softens the step from lip to surface.
    // 4. Outer dither: occasional road-coloured grit kicked onto the verge
    //    breaks the ruled line between road and grass.
    fillCellBuckets(edges, raster, (c, cx, cy) => {
      if (c === CELL_EDGE) return 1;
      if (c === CELL_RING) {
        if (onChecker(cx, cy)) return (hash2(cx, cy) & 3) !== 0 ? 2 : 0;
        return hash2(cx, cy, 1) % 3 === 0 ? 3 : 0;
      }
      if (c === CELL_HALO) return onChecker(cx, cy) && (hash2(cx, cy, 2) & 3) === 0 ? 4 : 0;
      return 0;
    }, [
      { color: ROAD_EDGE_COLOR, alpha: 0.8 },
      { color: ROAD_EDGE_COLOR, alpha: 0.4 },
      { color: ROAD_DUST_COLOR, alpha: 0.35 },
      { color: ROAD_COLOR, alpha: 0.6 },
    ]);

    this.roadContainer.addChild(edges);
  }

  /**
   * Draw terrain variety tiles. Idempotent — re-running replaces prior terrain
   * graphics. One Graphics for the whole layer.
   *
   * Kinds: `flowers`, `grass_tuft` and `dirt_patch` are flat ground; `tree`,
   * `bush` and `rock` are props placed explicitly by worldgen (trees Poisson-
   * spaced). `tall_grass` is legacy — no longer generated, but worlds saved
   * before worldgen v2 still carry it, and it keeps deriving its trees, bushes
   * and blotches client-side exactly as before. Legacy worlds (no v2-only kind
   * anywhere) also still derive rocks from ~22% of dirt tiles; v2 worlds place
   * their own rocks beside dirt, so they don't. Worldgen guarantees every
   * terrain tile misses roads, footprints and doorways, so derived props
   * inherit that safety.
   *
   * Two passes: all flat ground first, then every prop sorted by row, so a
   * canopy leaning into the row above always covers that row's ground cover,
   * and a nearer tree covers the trunk of the one behind it.
   */
  setTerrainTiles(tiles: Array<{ x: number; y: number; kind: string }>): void {
    // Detach first: `destroy()` splices the child out of `children`, so
    // iterating the live array skips every second entry and leaks it.
    for (const child of this.terrainContainer.removeChildren()) child.destroy({ children: true });
    const generation = ++this.terrainGeneration;

    if (!Array.isArray(tiles) || tiles.length === 0) return;

    const g = new PIXI.Graphics();
    g.eventMode = 'none';
    // Flowers and props: drawn as Graphics right away, then swapped for the Aseprite
    // sprites (scripts/aseprite/nature-props.lua) once the atlas loads — or kept for
    // good if it never does.
    const pg = new PIXI.Graphics();
    pg.eventMode = 'none';
    const flowerTiles: Array<{ x: number; y: number; h: number }> = [];
    const ordered = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);

    type PropKind = 'tree' | 'bush' | 'rock';
    const props: Array<{ x: number; y: number; kind: PropKind; h: number }> = [];
    // Only a tile list with none of the kinds worldgen v2 introduced predates
    // it; only then keep growing boulders out of dirt patches. Keyed on every
    // v2-only kind, not `rock` alone: a v2 world can roll zero rocks and would
    // otherwise sprout derived ones.
    const deriveDirtRocks = !tiles.some((t) => V2_TERRAIN_KINDS.has(t.kind));

    // ── Dirt, first ── worldgen clusters dirt into worn patches; each
    // 4-connected patch is one organic blob (`rasterizeSoftBlob`) instead of a
    // stack of per-tile rounded squares, which read as rubble on the 32px grid.
    // Drawn before the rest of the ground because a blob spills up to 8px into
    // neighbouring tiles: flowers and tufts there then sit on its fringe instead
    // of being painted over.
    const dirt = ordered.filter((t) => t.kind === 'dirt_patch');
    for (const patch of connectedComponents(dirt)) {
      const raster = rasterizeSoftBlob(patch, DIRT_STYLE);
      // Per-patch tone jitter so neighbouring patches aren't identical stamps.
      const first = patch[0];
      const alpha = 0.8 + (hash2(first.x, first.y, 7) % 3) * 0.04;
      // A solid body with a lighter-alpha lip (soft edge, no checkerboard — the
      // old checkered rim read as a dotted grid), sparse single-cell pebbles and
      // dust for grain, and a few specks of earth kicked just past the edge.
      fillCellBuckets(g, raster, (c, cx, cy) => {
        if (c === CELL_HALO) return hash2(cx, cy, 3) % 7 === 0 ? 5 : 0;
        if (c === CELL_EDGE) return 2;
        const r = hash2(cx, cy, 5) % 29;
        if (r === 0 || r === 1) return 3;
        if (r === 2) return 4;
        return 1;
      }, [
        { color: DIRT_COLOR, alpha },
        { color: DIRT_COLOR, alpha: alpha * 0.55 },
        { color: DIRT_PEBBLE_COLOR, alpha: 0.7 },
        { color: DIRT_DUST_COLOR, alpha: 0.6 },
        { color: DIRT_COLOR, alpha: alpha * 0.35 },
      ]);
    }

    // ── Ground pass ──
    for (const tile of ordered) {
      const px = tile.x * TILE_SIZE;
      const py = tile.y * TILE_SIZE;
      const h = (tile.x * 73856093) ^ (tile.y * 19349663);

      if (tile.kind === 'flowers') {
        // Small pink dots at tile center for a subtle flower look
        flowerTiles.push({ x: tile.x, y: tile.y, h });
        pg.rect(px, py, TILE_SIZE, TILE_SIZE).fill({ color: 0x3a5a2a, alpha: 0.15 });
        pg.circle(px + TILE_SIZE / 2 - 4, py + TILE_SIZE / 2 - 2, 3).fill({ color: 0xc75a8a, alpha: 0.35 });
        pg.circle(px + TILE_SIZE / 2 + 4, py + TILE_SIZE / 2 + 2, 3).fill({ color: 0xc75a8a, alpha: 0.35 });
        pg.circle(px + TILE_SIZE / 2, py + TILE_SIZE / 2 - 5, 2.5).fill({ color: 0xd98aaa, alpha: 0.3 });
      } else if (tile.kind === 'grass_tuft') {
        this.drawTuft(g, px, py, tile.x, tile.y);
      } else if (tile.kind === 'tall_grass') {
        // Legacy: ~42% of tall grass grows into a tree, ~40% into a bush, rest
        // stays as the flat blotch — a mix of heights keeps the fields from
        // reading as a uniform stamp.
        const roll = (h >>> 3) % 100;
        if (roll < 42) props.push({ x: tile.x, y: tile.y, kind: 'tree', h });
        else if (roll < 82) props.push({ x: tile.x, y: tile.y, kind: 'bush', h });
        else this.drawBlotch(g, px, py, h, 0x3a5a2a, 0.3);
      } else if (tile.kind === 'dirt_patch') {
        // Drawn above as merged blobs. A boulder on some patches gives the bare earth a reason to be bare —
        // legacy worlds only. Worldgen v2 places explicit `rock` tiles, mostly
        // beside dirt, so deriving more here would double them up.
        if (deriveDirtRocks && (h >>> 17) % 100 < 22) props.push({ x: tile.x, y: tile.y, kind: 'rock', h });
      } else if (tile.kind === 'tree' || tile.kind === 'bush' || tile.kind === 'rock') {
        props.push({ x: tile.x, y: tile.y, kind: tile.kind, h });
      }
    }

    // ── Prop pass ── painter's order by row (stable sort keeps x order within a row).
    props.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const p of props) {
      const px = p.x * TILE_SIZE;
      const py = p.y * TILE_SIZE;
      if (p.kind === 'tree') this.drawTree(pg, px, py, p.h);
      else if (p.kind === 'bush') this.drawBush(pg, px, py, p.h);
      else this.drawRock(pg, px, py, p.h);
    }

    this.terrainContainer.addChild(g);
    this.terrainContainer.addChild(pg);

    loadStrip(PROPS_URL, PROP_FRAME_COUNT).then((frames) => {
      if (generation !== this.terrainGeneration || pg.destroyed) return;
      const layer = new PIXI.Container();
      layer.eventMode = 'none';
      // Same order as the Graphics pass: flat flowers first, then props by row.
      const place = (kind: PropSpriteKind, tx: number, ty: number, h: number, dx: number, dy: number) => {
        const sprite = new PIXI.Sprite(frames[propFrame(kind, h)]);
        sprite.anchor.set(0.5, 0);
        sprite.position.set(tx * TILE_SIZE + TILE_SIZE / 2 + dx, ty * TILE_SIZE + dy);
        // Mirror half of them: doubles the apparent variety, and the light still reads
        // as top-down because every cell is lit from straight above-ish.
        if ((h >>> 27) & 1) sprite.scale.x = -1;
        layer.addChild(sprite);
      };
      for (const f of flowerTiles) place('flowers', f.x, f.y, f.h, 0, 0);
      for (const p of props) {
        // Jitter uses the same bits as the Graphics versions so a prop doesn't move
        // when its sprite arrives.
        if (p.kind === 'tree') place('tree', p.x, p.y, p.h, ((p.h >>> 5) % 7) - 3, 0);
        else if (p.kind === 'bush') place('bush', p.x, p.y, p.h, ((p.h >>> 5) % 9) - 4, ((p.h >>> 11) % 5) - 4);
        else place('rock', p.x, p.y, p.h, ((p.h >>> 21) % 7) - 3, ((p.h >>> 25) % 5) - 4);
      }
      const at = this.terrainContainer.getChildIndex(pg);
      this.terrainContainer.removeChild(pg);
      pg.destroy();
      this.terrainContainer.addChildAt(layer, at);
    }).catch(() => { /* Graphics props stay */ });
  }

  /**
   * A small grass tuft: a few 2px blades of uneven height in alternating dark
   * and sun-hit greens over a faint contact shade. Deliberately tiny and
   * low-alpha — tufts are ground texture, not props (art bible: terrain stays
   * background). Every coordinate is on the 2px grid so blades stay crisp.
   */
  private drawTuft(g: PIXI.Graphics, px: number, py: number, tx: number, ty: number): void {
    // hash2, not the legacy per-tile hash: tufts are new (no saved look to
    // preserve) and that hash's near-periodic bits line clustered tufts up.
    const clumps = hash2(tx, ty, 4) % 100 < 45 ? 2 : 1;
    for (let k = 0; k < clumps; k++) {
      const hk = hash2(tx, ty, 5 + k);
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
    // Dots live in a pool that is repositioned, recoloured and shown/hidden in place: this runs on
    // every data refresh (~1 Hz) and used to destroy and recreate every Graphics each time.
    let used = 0;

    // Occupancy comes from the live agent list, not `loc.current_occupants`:
    // `locations.getAll` is fetched once and never invalidated, so that column
    // is a permanently empty snapshot and these dots never rendered at all.
    for (const loc of locations) {
      // The first (up to) five agents inside, in roster order — collected without a per-location list.
      let dotCount = 0;
      const occupants = this.occupantScratch;
      for (let a = 0; a < agents.length && dotCount < OCCUPANCY_MAX_DOTS; a++) {
        if (agents[a].current_location === loc.id) occupants[dotCount++] = agents[a];
      }
      if (dotCount === 0) continue;
      const pos = loc.position ?? { x: 0, y: 0, width: 0, height: 0 };
      const centerX = pos.x + pos.width / 2;
      // Clear of the building name label, which BuildingRenderer anchors at
      // `height + 2` and runs ~10px tall — at +14 the dots clipped its descenders
      // from behind (the tilemap layer draws under the label layer).
      const y = pos.y + pos.height + 20;
      const startX = centerX - (dotCount * 6) / 2;
      for (let i = 0; i < dotCount; i++) {
        // Activity-colored dots (proposal-readability.md §3d):
        //   green = active/working, yellow = idle/socializing,
        //   blue = sleeping/resting, red = stressed/conflict
        const color = activityDotColor(occupants[i]);
        let dot = this.occupancyDots[used];
        if (!dot) {
          dot = new PIXI.Graphics();
          this.occupancyDots.push(dot);
          this.occupancyDotColors.push(-1);
          this.occupancyContainer.addChild(dot);
        }
        if (this.occupancyDotColors[used] !== color) {
          dot.clear().circle(0, 0, 3).fill(color);
          this.occupancyDotColors[used] = color;
        }
        dot.x = startX + i * 6;
        dot.y = y;
        dot.visible = true;
        used++;
      }
    }

    for (let i = used; i < this.occupancyDots.length; i++) this.occupancyDots[i].visible = false;
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
