/**
 * Which prop sprite sits on which tile of which zone.
 *
 * Pure data + tiny helpers (no PIXI import) so the coverage rules are unit-testable and so the
 * renderer only has to walk a list. Sprites are the ones authored in
 * scripts/aseprite/furniture.lua and registered in textures.ts `FURNITURE_URLS`.
 *
 * Why a per-zone table instead of extending `furniture: { label, tile }` in server/data/interiors.ts:
 * that field is the *sim's* notion of the one object an agent walks up to (it feeds the grid's
 * furniture cells). A zone is often several tiles and dressed with several objects (three
 * market stalls, a row of benches), which the sim has no reason to know about.
 *
 * Coordinates are tiles relative to the location's top-left, exactly like `zone.tiles`.
 * Sprites are placed at their natural size (most are 32x32; podium/coop are 2 tiles wide, the
 * barn 2x2), anchored at the tile's top-left.
 */

export interface PropPlacement {
  /** Key in `FURNITURE_URLS`. */
  sprite: string;
  /** Tile column / row inside the location. */
  tile: [number, number];
}

/** `ZONE_PROPS[buildingType][zoneId]` */
export const ZONE_PROPS: Record<string, Record<string, PropPlacement[]>> = {
  home: {
    // Sofa and armchair on the flanks, rug in the middle where the household actually stands.
    living: [
      { sprite: 'sofa', tile: [0, 1] },
      { sprite: 'rug', tile: [1, 1] },
      { sprite: 'armchair', tile: [2, 1] },
    ],
  },
  shop: {
    storage: [{ sprite: 'crates', tile: [1, 2] }],
    // One table, on the side away from the door: [2,2] is the tile customers walk in through.
    display: [{ sprite: 'display_table', tile: [3, 2] }],
  },
  pawnshop: {
    storage: [{ sprite: 'crates', tile: [1, 2] }],
    display: [{ sprite: 'pawn_case', tile: [3, 2] }],
  },
  tavern: {
    tables: [
      { sprite: 'table_chairs', tile: [1, 2] },
      { sprite: 'table_chairs', tile: [2, 2] },
    ],
    // [3,2] is the tile in front of the door; the booth goes on the far side.
    booth: [{ sprite: 'booth_seat', tile: [4, 2] }],
  },
  divebar: {
    tables: [
      { sprite: 'table_stools', tile: [1, 2] },
      { sprite: 'table_stools', tile: [2, 2] },
    ],
  },
  clinic: {
    exam_room: [{ sprite: 'exam_table', tile: [3, 1] }],
    medicine: [{ sprite: 'medicine_cabinet', tile: [1, 2] }],
  },
  town_hall: {
    public_seats: [
      { sprite: 'bench', tile: [1, 2] },
      { sprite: 'bench', tile: [2, 2] },
    ],
  },
  bakery: {
    display: [{ sprite: 'bread_display', tile: [1, 2] }],
    flour: [{ sprite: 'flour_sacks', tile: [3, 2] }],
  },
  workshop: {
    lumber: [{ sprite: 'plank_pile', tile: [1, 2] }],
  },
  prison: {
    cell_1: [{ sprite: 'prison_cell', tile: [3, 1] }],
    cell_2: [{ sprite: 'prison_cell', tile: [3, 2] }],
    hallway: [
      { sprite: 'hall_mat', tile: [1, 2] },
      { sprite: 'hall_mat', tile: [2, 2] },
    ],
  },
  farm: {
    // 64x32: hut + run cover both tiles of the zone.
    coop: [{ sprite: 'chicken_coop', tile: [0, 3] }],
    // 64x64: an open-fronted barn over the 2x2 zone. Its roof only shades the back row.
    barn: [{ sprite: 'barn', tile: [3, 3] }],
    rest_spot: [
      { sprite: 'hay_bale', tile: [7, 4] },
      { sprite: 'stump', tile: [8, 4] },
    ],
  },
  park: {
    benches: [
      { sprite: 'bench', tile: [0, 3] },
      { sprite: 'bench', tile: [1, 3] },
    ],
    garden: [
      { sprite: 'flower_bed_pink', tile: [3, 3] },
      { sprite: 'flower_bed_yellow', tile: [4, 3] },
    ],
    // The tiles are already water; reeds on the two shore corners and rocks to fish from
    // on the zone centre.
    riverside: [
      { sprite: 'reeds', tile: [1, 0] },
      { sprite: 'reeds', tile: [0, 1] },
      { sprite: 'shore_rocks', tile: [1, 1] },
    ],
    grove_west: [{ sprite: 'fallen_log', tile: [3, 1] }],
    grove_east: [{ sprite: 'mushrooms', tile: [5, 1] }],
  },
  town_square: {
    // Stalls on the top row of each 3x2 market zone; the bottom row stays clear for shoppers.
    market_north: [
      { sprite: 'stall_produce', tile: [0, 0] },
      { sprite: 'stall_cloth', tile: [1, 0] },
      { sprite: 'stall_bread', tile: [2, 0] },
    ],
    market_south: [
      { sprite: 'stall_fish', tile: [6, 0] },
      { sprite: 'stall_produce', tile: [7, 0] },
      { sprite: 'stall_cloth', tile: [8, 0] },
    ],
    // Clear of the well (tile 4,3) and its bench ring.
    plaza: [
      { sprite: 'planter', tile: [0, 3] },
      { sprite: 'lamp_post', tile: [2, 3] },
      { sprite: 'lamp_post', tile: [6, 3] },
      { sprite: 'planter', tile: [8, 3] },
    ],
    podium: [{ sprite: 'podium', tile: [0, 5] }],
    seating: [3, 4, 5, 6, 7, 8].map((c): PropPlacement => ({ sprite: 'bench', tile: [c, 5] })),
  },
};

/**
 * Zones drawn by something other than a prop sprite. Listed so the coverage test can tell
 * "forgotten" from "handled elsewhere".
 */
export const ZONES_DRAWN_ELSEWHERE: Readonly<Record<string, ReadonlySet<string>>> = {
  // Crop tiles are TilemapRenderer's (terrain sprites, growth stages).
  farm: new Set(['crops_north', 'crops_south']),
  // The stone well/fountain that BuildingRenderer draws at the square's centre.
  town_square: new Set(['fountain']),
};

export function propsForZone(buildingType: string, zoneId: string): readonly PropPlacement[] {
  return ZONE_PROPS[buildingType]?.[zoneId] ?? [];
}

/**
 * True when a zone reads as an object rather than a label: it either has a furniture sprite
 * for its `furniture.label`, or a prop list here. The renderer drops the zone's text label
 * and dims its tint rect for those, since the picture already says what the area is.
 */
export function isZoneIllustrated(
  buildingType: string,
  zone: { id: string; furniture?: { label: string } },
  furnitureSprites: Readonly<Record<string, string>>,
): boolean {
  if (zone.furniture && furnitureSprites[zone.furniture.label]) return true;
  return propsForZone(buildingType, zone.id).length > 0;
}

// ── Derived open areas (no zones in INTERIOR_ZONES) ────────────────────────────────────────

/** A placement in pixels relative to the location's top-left. */
export interface PixelPlacement {
  sprite: string;
  x: number;
  y: number;
}

const STALL_SPRITES = ['stall_produce', 'stall_cloth', 'stall_bread', 'stall_fish'] as const;
const STALL_W = 32;
const STALL_STEP = 34;

/**
 * Two rows of covered stalls with a walkway between. The stall count follows the square's
 * width (a 4-tile market gets three per row) and the row is centred: an off-centre gap at one
 * end reads as "the props ran out". Empty when the lot is too small to keep a walkway.
 */
export function marketSquareStalls(w: number, h: number): PixelPlacement[] {
  const cols = Math.floor((w - 16 + (STALL_STEP - STALL_W)) / STALL_STEP);
  if (cols < 1 || h < STALL_W * 2 + 24) return [];
  const startX = Math.round((w - (cols * STALL_STEP - (STALL_STEP - STALL_W))) / 2);
  const out: PixelPlacement[] = [];
  for (const [row, y] of [[0, 8], [1, h - 8 - STALL_W]] as const) {
    for (let i = 0; i < cols; i++) {
      out.push({
        sprite: STALL_SPRITES[(i + row * 2) % STALL_SPRITES.length],
        x: startX + i * STALL_STEP,
        y,
      });
    }
  }
  return out;
}

/**
 * Hay bales and the water trough of a fenced farmyard. Kept clear of the fence rails
 * (4px in from each edge); returns only what fits, so a 3x3-tile yard gets two bales, one
 * on the second row, and the trough.
 */
export function farmyardStock(w: number, h: number): PixelPlacement[] {
  const out: PixelPlacement[] = [];
  const bales: Array<[number, number]> = [[4, 6], [34, 6], [18, 26]];
  for (const [bx, by] of bales) {
    if (bx + 30 <= w && by + 28 <= h - 4) out.push({ sprite: 'hay_bale', x: bx, y: by });
  }
  const tx = w - 38;
  const ty = h - 40;
  if (tx > 8 && ty > 8) out.push({ sprite: 'trough', x: tx, y: ty });
  return out;
}

// ── Footprints, for other layers that must keep clear ──────────────────────────────────────

/** Sprites larger than one tile (px). Everything else is 32x32. */
const PROP_SIZE: Readonly<Record<string, readonly [number, number]>> = {
  podium: [64, 32],
  chicken_coop: [64, 32],
  barn: [64, 64],
};

export interface PropBox { x: number; y: number; w: number; h: number }

/**
 * Pixel boxes (relative to the location's top-left) of the always-visible props of an open
 * area — the town square's stalls, podium and benches, the park's beds, the farm's coop and
 * barn, a market square's stalls. Event decorations use them to avoid standing a festival
 * stall on the podium. Empty for buildings: their furniture is indoors, under the roof.
 */
export function openAreaPropBoxes(type: string, w: number, h: number): PropBox[] {
  const box = (sprite: string, x: number, y: number): PropBox => {
    const [bw, bh] = PROP_SIZE[sprite] ?? [32, 32];
    return { x, y, w: bw, h: bh };
  };
  if (type === 'market_square') return marketSquareStalls(w, h).map(p => box(p.sprite, p.x, p.y));
  if (type === 'farmyard') return farmyardStock(w, h).map(p => box(p.sprite, p.x, p.y));
  const zones = ZONE_PROPS[type];
  if (!zones || !['town_square', 'park', 'farm'].includes(type)) return [];
  const out: PropBox[] = [];
  for (const list of Object.values(zones)) {
    for (const p of list) out.push(box(p.sprite, p.tile[0] * 32, p.tile[1] * 32));
  }
  return out;
}
