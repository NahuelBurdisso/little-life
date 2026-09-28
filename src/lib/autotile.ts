/**
 * Autotiling for the procedural ground layers (roads, dirt patches, junction wear).
 *
 * Pure: no Pixi, no DOM, no Node — the renderer and the unit tests both import it.
 *
 * Two levels live here:
 *
 * 1. Tile level — an 8-neighbour bitmask per tile plus helpers that read it
 *    (exposed edges, convex/concave corners, diagonal "staircase" steps, straight
 *    run classification). This is the classic autotile vocabulary.
 *
 * 2. Cell level — `rasterizeBlobs` turns a tile set into a grid of small square
 *    cells (2px on screen) using those tile-level decisions: rounded convex
 *    corners, chamfered concave corners, bridges across diagonal steps. The
 *    outline classes (`CELL_EDGE`, `CELL_RING`, `CELL_HALO`) then fall out of a
 *    neighbourhood scan, so the dark lip and the edge dither follow *any* outline
 *    — bends, T junctions, staircases — without a hand-written case per shape.
 *    Drawing at a fixed cell size is also what keeps the edges crisp pixel steps
 *    instead of anti-aliased curves, matching the rest of the pixel-art world.
 */

export interface TileXY {
  x: number;
  y: number;
}

// ── Tile sets ────────────────────────────────────────────────────────────────

/** Numeric keys: string keys ("x,y") allocate per lookup, and the renderer does
 *  ~10 lookups per tile per rebuild. The offset keeps negative neighbours
 *  (x - 1 at the map edge) from colliding with real tiles. */
const KEY_OFFSET = 0x8000;
const KEY_STRIDE = 0x10000;

export type TileSet = ReadonlySet<number>;

export function tileKey(x: number, y: number): number {
  return (x + KEY_OFFSET) * KEY_STRIDE + (y + KEY_OFFSET);
}

export function buildTileSet(tiles: Iterable<TileXY>): Set<number> {
  const set = new Set<number>();
  for (const t of tiles) set.add(tileKey(t.x, t.y));
  return set;
}

/** First occurrence of each (x, y), input order kept. Worldgen emits crossing
 *  tiles twice (one per road) and overlapping lanes more; drawn twice, a
 *  translucent rut or wear patch would come out darker there. */
export function uniqueTiles<T extends TileXY>(tiles: readonly T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const t of tiles) {
    const k = tileKey(t.x, t.y);
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

export function hasTile(set: TileSet, x: number, y: number): boolean {
  return set.has(tileKey(x, y));
}

// ── 8-neighbour bitmask ──────────────────────────────────────────────────────

export const N = 1;
export const NE = 2;
export const E = 4;
export const SE = 8;
export const S = 16;
export const SW = 32;
export const W = 64;
export const NW = 128;

const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [bit: number, dx: number, dy: number]> = [
  [N, 0, -1], [NE, 1, -1], [E, 1, 0], [SE, 1, 1],
  [S, 0, 1], [SW, -1, 1], [W, -1, 0], [NW, -1, -1],
];

/** Map size in tiles. */
export interface MapBounds { width: number; height: number }

/**
 * Bitmask of which of the 8 surrounding tiles are in `set` (N=1 … NW=128,
 * clockwise). With `bounds`, neighbours off the map count as present: a road
 * that runs into the map edge carries on past it rather than ending there, so
 * it must not get a rounded cap, lip or halo along the border.
 */
export function neighbourMask(set: TileSet, x: number, y: number, bounds?: MapBounds): number {
  let mask = 0;
  for (const [bit, dx, dy] of NEIGHBOUR_OFFSETS) {
    const nx = x + dx, ny = y + dy;
    if (set.has(tileKey(nx, ny)) || (bounds && isOffMap(bounds, nx, ny))) mask |= bit;
  }
  return mask;
}

export function isOffMap(bounds: MapBounds, x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= bounds.width || y >= bounds.height;
}

export interface Sides { n: boolean; e: boolean; s: boolean; w: boolean }
export interface Corners { nw: boolean; ne: boolean; se: boolean; sw: boolean }

/** Sides that border a tile outside the set — pulled in by the style's inset
 *  and traced by the lip. */
export function exposedEdges(mask: number): Sides {
  return { n: !(mask & N), e: !(mask & E), s: !(mask & S), w: !(mask & W) };
}

/** Convex corners: both orthogonal neighbours missing, so the tile's own corner
 *  is on the outline and can be rounded. (Diagonal steps are a subset — see
 *  `diagonalSteps` — and must *not* be rounded, or the step pinches shut.) */
export function outerCorners(mask: number): Corners {
  return {
    nw: !(mask & N) && !(mask & W),
    ne: !(mask & N) && !(mask & E),
    se: !(mask & S) && !(mask & E),
    sw: !(mask & S) && !(mask & W),
  };
}

/** Concave corners: both orthogonal neighbours present but the diagonal one
 *  missing. Neither of this tile's sides is exposed, yet the outline turns here
 *  (e.g. the inside of a bend); the rasteriser cuts back to the neighbours'
 *  inset lines and chamfers the turn so it isn't a hard right-angle notch. */
export function innerCorners(mask: number): Corners {
  return {
    nw: !!(mask & N) && !!(mask & W) && !(mask & NW),
    ne: !!(mask & N) && !!(mask & E) && !(mask & NE),
    se: !!(mask & S) && !!(mask & E) && !(mask & SE),
    sw: !!(mask & S) && !!(mask & W) && !(mask & SW),
  };
}

/** Diagonal steps: the diagonal neighbour is present but both orthogonals between
 *  it and this tile are missing — the two tiles touch at a single point. A lane
 *  that staircases diagonally produces these; left alone, rounding both corners
 *  cuts the lane into a string of beads ("confetti"). The renderer instead keeps
 *  those corners square and fills a small bridge across the pinch. */
export function diagonalSteps(mask: number): Corners {
  return {
    nw: !!(mask & NW) && !(mask & N) && !(mask & W),
    ne: !!(mask & NE) && !(mask & N) && !(mask & E),
    se: !!(mask & SE) && !(mask & S) && !(mask & E),
    sw: !!(mask & SW) && !(mask & S) && !(mask & W),
  };
}

// ── Straight runs (wheel ruts) ───────────────────────────────────────────────

/** Length of the contiguous horizontal and vertical runs through (x, y), itself included. */
export function runLengths(set: TileSet, x: number, y: number): { h: number; v: number } {
  let h = 1;
  for (let i = x - 1; set.has(tileKey(i, y)); i--) h++;
  for (let i = x + 1; set.has(tileKey(i, y)); i++) h++;
  let v = 1;
  for (let j = y - 1; set.has(tileKey(x, j)); j--) v++;
  for (let j = y + 1; set.has(tileKey(x, j)); j++) v++;
  return { h, v };
}

export type RoadTileClass = 'h' | 'v' | 'junction' | 'stub';

/** A run this long reads as a road going somewhere. */
const STRAIGHT_MIN_RUN = 3;

/**
 * What kind of road surface a tile is, for ruts and wear.
 *
 * The 3×3 mask can't answer this: the outer tile of an L bend has exactly the
 * neighbourhood of a straight 2-wide road, and ruts drawn from the mask alone
 * ran into the bend and stopped dead mid-corner. Run lengths can: a road tile is
 * a straight 'h' when its row runs on (≥ 3) while its column is only the road's
 * own width (≤ 2, lanes are 2 wide), and vice versa. Long runs both ways mean
 * two roads share the tile — a crossing, T, bend corner block or diagonal
 * staircase — which gets a merged wear patch instead of ruts, so a staircase is
 * one worn band rather than rut fragments every tile. Short both ways: a stub.
 */
export function classifyRoadTile(set: TileSet, x: number, y: number): RoadTileClass {
  const { h, v } = runLengths(set, x, y);
  const longH = h >= STRAIGHT_MIN_RUN;
  const longV = v >= STRAIGHT_MIN_RUN;
  if (longH && longV) return 'junction';
  if (longH) return 'h';
  if (longV) return 'v';
  return 'stub';
}

// ── Components ───────────────────────────────────────────────────────────────

/**
 * 4-connected components (diagonal contact does not merge). Duplicate tiles are
 * dropped. Deterministic: components come in order of their first tile in the
 * input, and tiles inside a component are sorted by y then x.
 */
export function connectedComponents<T extends TileXY>(tiles: readonly T[]): T[][] {
  const byKey = new Map<number, T>();
  for (const t of tiles) {
    const k = tileKey(t.x, t.y);
    if (!byKey.has(k)) byKey.set(k, t);
  }
  const seen = new Set<number>();
  const out: T[][] = [];
  for (const [startKey, start] of byKey) {
    if (seen.has(startKey)) continue;
    seen.add(startKey);
    const comp: T[] = [];
    const stack: T[] = [start];
    while (stack.length > 0) {
      const t = stack.pop()!;
      comp.push(t);
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
        const k = tileKey(t.x + dx, t.y + dy);
        const n = byKey.get(k);
        if (n && !seen.has(k)) {
          seen.add(k);
          stack.push(n);
        }
      }
    }
    comp.sort((a, b) => a.y - b.y || a.x - b.x);
    out.push(comp);
  }
  return out;
}

// ── Deterministic hash ───────────────────────────────────────────────────────

/** Well-mixed uint32 of integer coordinates. The renderer's legacy
 *  `(x*73856093)^(y*19349663)` has near-periodic low bits, which shows up as
 *  visible stripes when used for per-2px dither decisions. */
export function hash2(x: number, y: number, salt = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// ── Cell raster ──────────────────────────────────────────────────────────────

export const CELL_OUT = 0;
/** Inside, away from the outline. */
export const CELL_BODY = 1;
/** Inside, touching the outside (8-neighbourhood) — the lip. 8-neighbourhood so
 *  the lip is a closed 4-connected line even around concave corners. */
export const CELL_EDGE = 2;
/** Inside, one cell in from the lip — the inner dither band. */
export const CELL_RING = 3;
/** Outside, orthogonally touching the shape — the outer dither band. */
export const CELL_HALO = 4;

export function isInsideCell(cls: number): boolean {
  return cls === CELL_BODY || cls === CELL_EDGE || cls === CELL_RING;
}

export type Side = 'n' | 'e' | 's' | 'w';

export interface BlobStyle {
  /** Cells per tile edge (TILE_SIZE / cell px). */
  cellsPerTile: number;
  /** Cells to pull an *exposed* side in from the tile edge. Must be a pure
   *  function of (x, y, side): concave corners read their neighbours' insets so
   *  the outline stays continuous across tiles. Defaults to 0. */
  inset?: (x: number, y: number, side: Side) => number;
  /** Convex-corner rounding: cells removed from the corner, one entry per cell
   *  row counting inward (e.g. [2, 1] = a 2-then-1 cell step). */
  outerProfile: readonly number[];
  /** Concave-corner chamfer: a stepped triangle of this many cells per leg added
   *  into the outside quadrant at the concave vertex. 0 = sharp. */
  filletSize: number;
  /** Diagonal-step bridge: stepped triangle legs (cells) filled into the two
   *  empty tiles of the pinch. 0 = treat diagonal steps as plain outer corners.
   *  Assumes zero inset: the triangles are anchored at the two tiles' shared
   *  corner point, so with an inset they would float free of both shapes. Inset
   *  styles (dirt, wear) use 0. */
  bridgeSize: number;
  /** Map size in tiles. Tiles off the map count as present (see
   *  `neighbourMask`), and off-map cells count as inside when classifying, so a
   *  shape touching the border gets no cap, lip or halo along it. */
  bounds?: MapBounds;
}

export interface BlobRaster {
  /** Absolute cell coordinates of cells[0] (tile x * cellsPerTile). */
  x0: number;
  y0: number;
  width: number;
  height: number;
  /** One CELL_* class per cell, row-major. */
  cells: Uint8Array;
  cellsPerTile: number;
  /** Per tile of the raster (row-major, `width / cellsPerTile` wide): 1 if the
   *  tile may hold a non-OUT cell (a shape tile or one of its 8 neighbours).
   *  Lets scans skip the empty bulk of the map. */
  active: Uint8Array;
}

interface CornerDef {
  key: keyof Corners;
  dx: -1 | 1;
  dy: -1 | 1;
  hSide: Side;
  vSide: Side;
}

const CORNER_DEFS: readonly CornerDef[] = [
  { key: 'nw', dx: -1, dy: -1, hSide: 'w', vSide: 'n' },
  { key: 'ne', dx: 1, dy: -1, hSide: 'e', vSide: 'n' },
  { key: 'se', dx: 1, dy: 1, hSide: 'e', vSide: 's' },
  { key: 'sw', dx: -1, dy: 1, hSide: 'w', vSide: 's' },
];

const EMPTY_RASTER: BlobRaster = {
  x0: 0, y0: 0, width: 0, height: 0, cells: new Uint8Array(0), cellsPerTile: 1, active: new Uint8Array(0),
};

/** `inside` values while rasterising. VIRTUAL = off the map: inside for the
 *  outline scan (no lip/halo against the border) but never emitted. */
const IN_NONE = 0;
const IN_REAL = 1;
const IN_VIRTUAL = 2;

/**
 * Rasterise a tile set into outline-classified cells.
 *
 * Per tile, each row of cells spans [left, right) where exposed sides
 * (`exposedEdges`) are pulled in by `inset`. Then per corner:
 * - diagonal step (`diagonalSteps`, and `bridgeSize` > 0): keep the corner
 *   square and fill a stepped triangle into each empty orthogonal tile at the
 *   pinch;
 * - otherwise convex (`outerCorners`): shave `outerProfile` off the corner;
 * - concave (`innerCorners`): the neighbours' insets meet at a vertex inside
 *   (or, with no inset, at the corner of) this tile; cut back to that vertex
 *   and add a `filletSize` chamfer into the outside quadrant.
 * The raster spans the tiles' bounding box plus one tile of margin, which holds
 * every fillet, bridge and halo cell. Duplicate tiles are ignored.
 */
export function rasterizeBlobs(tiles: readonly TileXY[], style: BlobStyle): BlobRaster {
  const unique = uniqueTiles(tiles);
  if (unique.length === 0) return EMPTY_RASTER;
  const C = style.cellsPerTile;
  const inset = style.inset ?? (() => 0);
  const bounds = style.bounds;
  const set = buildTileSet(unique);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of unique) {
    if (t.x < minX) minX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.x > maxX) maxX = t.x;
    if (t.y > maxY) maxY = t.y;
  }
  const tx0 = minX - 1;
  const ty0 = minY - 1;
  const tw = maxX - minX + 3;
  const th = maxY - minY + 3;
  const x0 = tx0 * C;
  const y0 = ty0 * C;
  const width = tw * C;
  const height = th * C;
  const inside = new Uint8Array(width * height);

  if (bounds) {
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        if (!isOffMap(bounds, tx0 + tx, ty0 + ty)) continue;
        for (let r = 0; r < C; r++) inside.fill(IN_VIRTUAL, (ty * C + r) * width + tx * C, (ty * C + r) * width + tx * C + C);
      }
    }
  }

  // The raster's outermost cell ring is never marked, so every real inside cell
  // has its full 8-neighbourhood in bounds and classification indexes blindly.
  // (Fillets and bridges are clamped well inside the one-tile margin anyway.)
  const mark = (cx: number, cy: number) => {
    const lx = cx - x0;
    const ly = cy - y0;
    if (lx < 1 || ly < 1 || lx >= width - 1 || ly >= height - 1) return;
    const i = ly * width + lx;
    if (inside[i] === IN_NONE) inside[i] = IN_REAL;
  };
  const bridgeSize = Math.min(style.bridgeSize, C - 2);
  const filletSize = Math.min(style.filletSize, C - 2);

  const left = new Int32Array(C);
  const right = new Int32Array(C);
  const active = new Uint8Array(tw * th);

  for (const { x, y } of unique) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) active[(y - ty0 + dy) * tw + (x - tx0 + dx)] = 1;
    }
    const m = neighbourMask(set, x, y, bounds);
    const exposed = exposedEdges(m);
    const outer = outerCorners(m);
    const inner = innerCorners(m);
    const steps = diagonalSteps(m);
    const ox = x * C;
    const oy = y * C;
    const iN = exposed.n ? inset(x, y, 'n') : 0;
    const iE = exposed.e ? inset(x, y, 'e') : 0;
    const iS = exposed.s ? inset(x, y, 's') : 0;
    const iW = exposed.w ? inset(x, y, 'w') : 0;
    left.fill(iW);
    right.fill(C - iE);

    for (const c of CORNER_DEFS) {
      if (steps[c.key] && bridgeSize > 0) {
        // Bridge the pinch at this tile's corner point P.
        const K = bridgeSize;
        const px = c.dx < 0 ? 0 : C;
        const py = c.dy < 0 ? 0 : C;
        for (let i = 0; i < K; i++) {
          for (let j = 0; i + j < K; j++) {
            // Into the vertical orthogonal tile (x, y+dy), on the side toward dx.
            mark(ox + (c.dx < 0 ? px + i : px - 1 - i), oy + (c.dy < 0 ? py - 1 - j : py + j));
            // Into the horizontal orthogonal tile (x+dx, y), on the side toward dy.
            mark(ox + (c.dx < 0 ? px - 1 - i : px + i), oy + (c.dy < 0 ? py + j : py - 1 - j));
          }
        }
      } else if (outer[c.key]) {
        const iV = c.dy < 0 ? iN : iS;
        style.outerProfile.forEach((cut, k) => {
          const r = c.dy < 0 ? iV + k : C - 1 - iV - k;
          if (r < 0 || r >= C) return;
          if (c.dx < 0) left[r] = Math.max(left[r], iW + cut);
          else right[r] = Math.min(right[r], C - iE - cut);
        });
      } else if (inner[c.key]) {
        // The vertical neighbour's inset on our horizontal side, and the
        // horizontal neighbour's inset on our vertical side, meet at vertex V.
        // (Both neighbours are on the map: an off-map diagonal counts as present.)
        const cutX = inset(x, y + c.dy, c.hSide);
        const cutY = inset(x + c.dx, y, c.vSide);
        const r0 = c.dy < 0 ? 0 : C - cutY;
        const r1 = c.dy < 0 ? cutY : C;
        for (let r = Math.max(0, r0); r < Math.min(C, r1); r++) {
          if (c.dx < 0) left[r] = Math.max(left[r], cutX);
          else right[r] = Math.min(right[r], C - cutX);
        }
        const vx = c.dx < 0 ? cutX : C - cutX;
        const vy = c.dy < 0 ? cutY : C - cutY;
        for (let i = 0; i < filletSize; i++) {
          for (let j = 0; i + j < filletSize; j++) {
            mark(ox + (c.dx < 0 ? vx - 1 - i : vx + i), oy + (c.dy < 0 ? vy - 1 - j : vy + j));
          }
        }
      }
    }

    for (let r = iN; r < C - iS; r++) {
      const base = (oy + r - y0) * width + (ox - x0);
      inside.fill(IN_REAL, base + left[r], base + Math.max(left[r], right[r]));
    }
  }

  // Real inside cells, gathered from active tiles only (every shape, fillet,
  // bridge and halo cell lies in a shape tile or one of its 8 neighbours).
  let count = 0;
  const forActiveCells = (fn: (i: number) => void) => {
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        if (!active[ty * tw + tx]) continue;
        for (let r = 0; r < C; r++) {
          const base = (ty * C + r) * width + tx * C;
          for (let k = 0; k < C; k++) if (inside[base + k] === IN_REAL) fn(base + k);
        }
      }
    }
  };
  forActiveCells(() => { count++; });
  const insideIdx = new Int32Array(count);
  count = 0;
  forActiveCells((i) => { insideIdx[count++] = i; });

  // Classify: EDGE/BODY from `inside`, RING from EDGE, HALO by stamping the
  // outside 4-neighbours of lip cells. No bounds checks needed — see `mark`.
  const cells = new Uint8Array(width * height);
  const n8 = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
  const n4 = [-width, -1, 1, width];
  for (let k = 0; k < insideIdx.length; k++) {
    const i = insideIdx[k];
    let edge = false;
    for (let d = 0; d < 8; d++) if (inside[i + n8[d]] === IN_NONE) { edge = true; break; }
    cells[i] = edge ? CELL_EDGE : CELL_BODY;
  }
  for (let k = 0; k < insideIdx.length; k++) {
    const i = insideIdx[k];
    if (cells[i] !== CELL_BODY) continue;
    for (let d = 0; d < 8; d++) if (cells[i + n8[d]] === CELL_EDGE) { cells[i] = CELL_RING; break; }
  }
  for (let k = 0; k < insideIdx.length; k++) {
    const i = insideIdx[k];
    if (cells[i] !== CELL_EDGE) continue; // only lip cells can touch the outside
    for (let d = 0; d < 4; d++) {
      const j = i + n4[d];
      if (inside[j] === IN_NONE) cells[j] = CELL_HALO;
    }
  }

  return { x0, y0, width, height, cells, cellsPerTile: C, active };
}

/** Rectangle in absolute cell coordinates. */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Sort cells into buckets in a single scan and cover each bucket with
 * non-overlapping rectangles: horizontal runs of the same bucket per row,
 * extended downward while the next row has the identical run. A straight road
 * then costs a handful of rects instead of one per cell, and non-overlap
 * matters because the layers are drawn translucent.
 *
 * `bucket` returns 1..bucketCount for a cell, or 0 to skip it; it is only
 * called for non-OUT cells in active tiles. Result: one rect list per bucket
 * (index 0 = bucket 1).
 */
export function bucketCellRects(
  raster: BlobRaster,
  bucket: (cls: number, cx: number, cy: number) => number,
  bucketCount: number,
): CellRect[][] {
  const { x0, y0, width, height, cells, cellsPerTile: C, active } = raster;
  const out: CellRect[][] = Array.from({ length: bucketCount }, () => []);
  if (width === 0) return out;
  const tw = width / C;
  let open = new Map<number, CellRect>();
  for (let ly = 0; ly < height; ly++) {
    const next = new Map<number, CellRect>();
    const rowActive = (ly / C | 0) * tw;
    const rowBase = ly * width;
    const cy = y0 + ly;
    const keyAt = (lx: number) => {
      const cls = cells[rowBase + lx];
      return cls === CELL_OUT ? 0 : bucket(cls, x0 + lx, cy);
    };
    let lx = 0;
    let k = -1; // key of cell lx when already computed by the run scan
    while (lx < width) {
      if (lx % C === 0 && !active[rowActive + lx / C]) { lx += C; k = -1; continue; }
      const b = k >= 0 ? k : keyAt(lx);
      k = -1;
      if (b === 0) { lx++; continue; }
      const start = lx++;
      while (lx < width && (k = keyAt(lx)) === b) lx++;
      if (lx >= width) k = -1;
      const runKey = (start * (width + 1) + lx) * (bucketCount + 1) + b;
      const prev = open.get(runKey);
      if (prev) {
        prev.h++;
        next.set(runKey, prev);
      } else {
        const rect = { x: x0 + start, y: cy, w: lx - start, h: 1 };
        out[b - 1].push(rect);
        next.set(runKey, rect);
      }
    }
    open = next;
  }
  return out;
}
