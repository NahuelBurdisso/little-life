import * as PIXI from "pixi.js";
import { SPRITE_CONFIG } from "../../lib/spriteConfig";
import {
  TILE_TYPE_MAP,
  TERRAIN,
  BUILDINGS,
  PROPS,
  MULTI_TILE_PROPS,
  TILESET,
  randomTerrain,
} from "../../lib/tileMap";
import type { TileRef } from "../../lib/tileMap";

// ---- Interfaces ----

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

// ---- Constants ----

const TILE_SIZE = SPRITE_CONFIG.TILE_SIZE; // 32
const NATIVE_TILE = SPRITE_CONFIG.NATIVE_TILE; // 16
const SPRITE_SCALE = SPRITE_CONFIG.SPRITE_SCALE; // 2

const WATER_FRAME_COUNT = 14;
const WATER_FRAME_INTERVAL = 150; // ms per frame
const CAMPFIRE_FRAME_COUNT = 4;
const CAMPFIRE_FRAME_INTERVAL = 180; // ms per frame

const LABEL_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 7,
  fill: 0xffffff,
  stroke: { color: 0x000000, width: 2 },
  align: "center",
});

// ---- Tileset texture cache ----

/** Slice a base texture into a 2D grid of NATIVE_TILE x NATIVE_TILE textures */
function sliceTileset(base: PIXI.Texture): PIXI.Texture[][] {
  const cols = TILESET.columns;
  const rows = TILESET.rows;
  const grid: PIXI.Texture[][] = [];
  for (let r = 0; r < rows; r++) {
    const rowArr: PIXI.Texture[] = [];
    for (let c = 0; c < cols; c++) {
      const frame = new PIXI.Rectangle(c * NATIVE_TILE, r * NATIVE_TILE, NATIVE_TILE, NATIVE_TILE);
      rowArr.push(new PIXI.Texture({ source: base.source, frame }));
    }
    grid.push(rowArr);
  }
  return grid;
}

/** Slice an animation strip (horizontal, each frame NATIVE_TILE x NATIVE_TILE) */
function sliceAnimStrip(base: PIXI.Texture, frameCount: number): PIXI.Texture[] {
  const frames: PIXI.Texture[] = [];
  for (let i = 0; i < frameCount; i++) {
    const frame = new PIXI.Rectangle(i * NATIVE_TILE, 0, NATIVE_TILE, NATIVE_TILE);
    frames.push(new PIXI.Texture({ source: base.source, frame }));
  }
  return frames;
}

// ---- Seeded random for deterministic prop placement ----
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ---- Main class ----

export class TilemapRenderer {
  container: PIXI.Container;

  private terrainContainer: PIXI.Container;
  private buildingContainer: PIXI.Container;
  private propContainer: PIXI.Container;
  private labelContainer: PIXI.Container;
  private occupancyContainer: PIXI.Container;

  private mapData: MapData | null = null;
  private tileGrid: PIXI.Texture[][] | null = null;

  // Animated water
  private waterFrames: PIXI.Texture[] = [];
  private waterSprites: PIXI.Sprite[] = [];
  private waterFrameIndex = 0;
  private waterTimer = 0;

  // Animated campfire
  private campfireFrames: PIXI.Texture[] = [];
  private campfireSprites: PIXI.Sprite[] = [];
  private campfireFrameIndex = 0;
  private campfireTimer = 0;

  private tickerRef: ((ticker: PIXI.Ticker) => void) | null = null;
  private app: PIXI.Application;

  constructor(app: PIXI.Application) {
    this.app = app;
    this.container = new PIXI.Container();

    this.terrainContainer = new PIXI.Container();
    this.buildingContainer = new PIXI.Container();
    this.propContainer = new PIXI.Container();
    this.labelContainer = new PIXI.Container();
    this.occupancyContainer = new PIXI.Container();

    this.container.addChild(this.terrainContainer);
    this.container.addChild(this.buildingContainer);
    this.container.addChild(this.propContainer);
    this.container.addChild(this.labelContainer);
    this.container.addChild(this.occupancyContainer);

    this.loadMap();
  }

  // ---- Public API ----

  getMapSize(): { width: number; height: number } {
    if (!this.mapData) {
      return {
        width: 40 * TILE_SIZE,
        height: 30 * TILE_SIZE,
      };
    }
    return {
      width: this.mapData.pixelWidth,
      height: this.mapData.pixelHeight,
    };
  }

  /** Stub for Task 15 — occupancy dots on locations */
  updateOccupancy(_occupancy?: Map<string, number>): void {
    // Will be implemented in Task 15
  }

  destroy(): void {
    if (this.tickerRef) {
      this.app.ticker.remove(this.tickerRef);
      this.tickerRef = null;
    }
    this.container.destroy({ children: true });
  }

  // ---- Loading ----

  private async loadMap(): Promise<void> {
    try {
      const resp = await fetch("/maps/default.json");
      this.mapData = await resp.json();
      this.prepareTilesets();
      this.render();
      this.startAnimations();
    } catch (err) {
      console.error("Failed to load map:", err);
    }
  }

  private prepareTilesets(): void {
    // Main tileset
    const base = PIXI.Assets.get<PIXI.Texture>("serene-village");
    if (base) {
      this.tileGrid = sliceTileset(base);
    } else {
      console.warn("serene-village texture not loaded yet");
    }

    // Water animation frames
    const waterBase = PIXI.Assets.get<PIXI.Texture>("water-waves");
    if (waterBase) {
      this.waterFrames = sliceAnimStrip(waterBase, WATER_FRAME_COUNT);
    }

    // Campfire animation frames
    const campfireBase = PIXI.Assets.get<PIXI.Texture>("campfire");
    if (campfireBase) {
      this.campfireFrames = sliceAnimStrip(campfireBase, CAMPFIRE_FRAME_COUNT);
    }
  }

  // ---- Rendering ----

  private render(): void {
    if (!this.mapData) return;

    this.renderTerrain();
    this.renderBuildings();
    this.renderProps();
    this.renderLabels();
  }

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

  private renderTerrain(): void {
    if (!this.mapData) return;
    const { tileLayer } = this.mapData;

    for (let row = 0; row < tileLayer.length; row++) {
      for (let col = 0; col < tileLayer[row].length; col++) {
        const tileId = tileLayer[row][col];
        const terrainKey = TILE_TYPE_MAP[tileId] ?? "grass";
        const x = col * TILE_SIZE;
        const y = row * TILE_SIZE;

        if (terrainKey === "water") {
          // Use base water tile; animated overlay will swap texture
          const waterRef = TERRAIN.water[0];
          const sprite = this.createTileSprite(waterRef, x, y);
          if (sprite) {
            this.terrainContainer.addChild(sprite);
            this.waterSprites.push(sprite);
          }
        } else if (terrainKey === "grass") {
          // Random grass variation (deterministic per position)
          const ref = randomTerrain("grass");
          const sprite = this.createTileSprite(ref, x, y);
          if (sprite) {
            this.terrainContainer.addChild(sprite);
          }
        } else {
          // Path — use center variant
          const variants = TERRAIN[terrainKey];
          const ref = variants ? variants[0] : TERRAIN.grass[0];
          const sprite = this.createTileSprite(ref, x, y);
          if (sprite) {
            this.terrainContainer.addChild(sprite);
          }
        }
      }
    }
  }

  private renderBuildings(): void {
    if (!this.mapData) return;

    for (const loc of this.mapData.locations) {
      const template = BUILDINGS[loc.type];
      if (!template || template.tiles.length === 0) continue;

      for (const tile of template.tiles) {
        const ref = { col: tile.tileCol, row: tile.tileRow };
        const x = loc.x + tile.col * TILE_SIZE;
        const y = loc.y + tile.row * TILE_SIZE;
        const sprite = this.createTileSprite(ref, x, y);
        if (sprite) {
          this.buildingContainer.addChild(sprite);
        }
      }
    }
  }

  private renderProps(): void {
    if (!this.mapData) return;
    const rng = seededRandom(42);

    for (const loc of this.mapData.locations) {
      if (loc.type === "park") {
        this.placeTreesAround(loc, 6, rng);
        this.placeBushesAround(loc, 4, rng);
        this.placeCampfire(loc);
      } else if (loc.type === "town_square") {
        // A few trees and flowers around the square
        this.placeTreesAround(loc, 3, rng);
        this.placeFlowersAround(loc, 6, rng);
      } else if (loc.type === "farm") {
        // Fences along parts of the farm
        this.placeFencesAround(loc, rng);
        this.placeTreesAround(loc, 2, rng);
      } else if (loc.type === "home") {
        // Occasional flower or bush near homes
        this.placeFlowersAround(loc, 2, rng);
      }
    }
  }

  private placeTreesAround(loc: MapLocation, count: number, rng: () => number): void {
    const treeTypes = ["tree_oak", "tree_pine"] as const;
    for (let i = 0; i < count; i++) {
      const treeKey = treeTypes[Math.floor(rng() * treeTypes.length)];
      const multi = MULTI_TILE_PROPS[treeKey];
      if (!multi) continue;

      // Place around the perimeter of the location
      const side = Math.floor(rng() * 4);
      let tx: number, ty: number;
      switch (side) {
        case 0: // top
          tx = loc.x + rng() * (loc.width - multi.widthTiles * TILE_SIZE);
          ty = loc.y - multi.heightTiles * TILE_SIZE;
          break;
        case 1: // bottom
          tx = loc.x + rng() * (loc.width - multi.widthTiles * TILE_SIZE);
          ty = loc.y + loc.height;
          break;
        case 2: // left
          tx = loc.x - multi.widthTiles * TILE_SIZE;
          ty = loc.y + rng() * (loc.height - multi.heightTiles * TILE_SIZE);
          break;
        default: // right
          tx = loc.x + loc.width;
          ty = loc.y + rng() * (loc.height - multi.heightTiles * TILE_SIZE);
          break;
      }

      // Snap to grid
      tx = Math.round(tx / TILE_SIZE) * TILE_SIZE;
      ty = Math.round(ty / TILE_SIZE) * TILE_SIZE;

      // Clamp to map bounds
      const mapW = this.mapData!.pixelWidth;
      const mapH = this.mapData!.pixelHeight;
      if (tx < 0 || ty < 0 || tx + multi.widthTiles * TILE_SIZE > mapW || ty + multi.heightTiles * TILE_SIZE > mapH) {
        continue;
      }

      for (const tile of multi.tiles) {
        const ref = { col: tile.tileCol, row: tile.tileRow };
        const sprite = this.createTileSprite(ref, tx + tile.col * TILE_SIZE, ty + tile.row * TILE_SIZE);
        if (sprite) {
          this.propContainer.addChild(sprite);
        }
      }
    }
  }

  private placeBushesAround(loc: MapLocation, count: number, rng: () => number): void {
    for (let i = 0; i < count; i++) {
      const x = loc.x + rng() * (loc.width - TILE_SIZE);
      const y = loc.y + rng() * (loc.height - TILE_SIZE);
      const snappedX = Math.round(x / TILE_SIZE) * TILE_SIZE;
      const snappedY = Math.round(y / TILE_SIZE) * TILE_SIZE;
      const sprite = this.createTileSprite(PROPS.bush, snappedX, snappedY);
      if (sprite) {
        this.propContainer.addChild(sprite);
      }
    }
  }

  private placeFlowersAround(loc: MapLocation, count: number, rng: () => number): void {
    const flowerKeys = [PROPS.flower, PROPS.flower_red, PROPS.flower_blue];
    for (let i = 0; i < count; i++) {
      const ref = flowerKeys[Math.floor(rng() * flowerKeys.length)];
      // Place near the edges
      const offsetX = (rng() - 0.5) * (loc.width + TILE_SIZE * 2);
      const offsetY = (rng() - 0.5) * (loc.height + TILE_SIZE * 2);
      const cx = loc.x + loc.width / 2 + offsetX;
      const cy = loc.y + loc.height / 2 + offsetY;
      const snappedX = Math.round(cx / TILE_SIZE) * TILE_SIZE;
      const snappedY = Math.round(cy / TILE_SIZE) * TILE_SIZE;

      if (snappedX < 0 || snappedY < 0) continue;

      const sprite = this.createTileSprite(ref, snappedX, snappedY);
      if (sprite) {
        this.propContainer.addChild(sprite);
      }
    }
  }

  private placeFencesAround(loc: MapLocation, rng: () => number): void {
    // Horizontal fences along top and bottom
    const topY = loc.y - TILE_SIZE;
    const bottomY = loc.y + loc.height;
    const tilesWide = Math.floor(loc.width / TILE_SIZE);

    for (let i = 0; i < tilesWide; i++) {
      const x = loc.x + i * TILE_SIZE;
      if (rng() > 0.7) continue; // skip some for variation
      if (topY >= 0) {
        const sprite = this.createTileSprite(PROPS.fence_h, x, topY);
        if (sprite) this.propContainer.addChild(sprite);
      }
      if (bottomY + TILE_SIZE <= (this.mapData?.pixelHeight ?? 960)) {
        const sprite = this.createTileSprite(PROPS.fence_h, x, bottomY);
        if (sprite) this.propContainer.addChild(sprite);
      }
    }
  }

  private placeCampfire(loc: MapLocation): void {
    if (this.campfireFrames.length === 0) return;

    // Place campfire near center of the park
    const cx = loc.x + Math.floor(loc.width / 2 / TILE_SIZE) * TILE_SIZE;
    const cy = loc.y + Math.floor(loc.height / 2 / TILE_SIZE) * TILE_SIZE;

    const sprite = new PIXI.Sprite(this.campfireFrames[0]);
    sprite.scale.set(SPRITE_SCALE);
    sprite.x = cx;
    sprite.y = cy;
    this.propContainer.addChild(sprite);
    this.campfireSprites.push(sprite);
  }

  private renderLabels(): void {
    if (!this.mapData) return;

    for (const loc of this.mapData.locations) {
      const label = new PIXI.Text({ text: loc.name, style: LABEL_STYLE });
      label.anchor.set(0.5, 0);
      label.x = loc.x + loc.width / 2;
      label.y = loc.y + loc.height + 2;
      this.labelContainer.addChild(label);
    }
  }

  // ---- Animations ----

  private startAnimations(): void {
    const tickFn = (ticker: PIXI.Ticker) => {
      const dt = ticker.deltaMS;
      this.animateWater(dt);
      this.animateCampfire(dt);
    };
    this.tickerRef = tickFn;
    this.app.ticker.add(tickFn);
  }

  private animateWater(dtMs: number): void {
    if (this.waterFrames.length === 0 || this.waterSprites.length === 0) return;
    this.waterTimer += dtMs;
    if (this.waterTimer >= WATER_FRAME_INTERVAL) {
      this.waterTimer -= WATER_FRAME_INTERVAL;
      this.waterFrameIndex = (this.waterFrameIndex + 1) % this.waterFrames.length;
      const tex = this.waterFrames[this.waterFrameIndex];
      for (const sprite of this.waterSprites) {
        sprite.texture = tex;
      }
    }
  }

  private animateCampfire(dtMs: number): void {
    if (this.campfireFrames.length === 0 || this.campfireSprites.length === 0) return;
    this.campfireTimer += dtMs;
    if (this.campfireTimer >= CAMPFIRE_FRAME_INTERVAL) {
      this.campfireTimer -= CAMPFIRE_FRAME_INTERVAL;
      this.campfireFrameIndex = (this.campfireFrameIndex + 1) % this.campfireFrames.length;
      const tex = this.campfireFrames[this.campfireFrameIndex];
      for (const sprite of this.campfireSprites) {
        sprite.texture = tex;
      }
    }
  }
}
