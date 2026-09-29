/**
 * Organic village road network — the `layoutStyle: 'organic'` branch of the
 * `roads` stage.
 *
 * The grid layout gives every town the same skeleton (two horizontal and two
 * vertical full-span roads at fixed fractions). This grows a network the way
 * Emilien et al. 2012 ("Procedural generation of villages on arbitrary
 * terrains") do, scaled down to a flat tile map with no elevation:
 *
 *   1. a straight main street anchors the town, because the layout contract
 *      needs one axis-aligned `mainstreet` rect;
 *   2. an *interest map* (fBm noise × a falloff around the main street's
 *      midpoint) says where people would want to settle;
 *   3. K *settlement seeds* are drawn from the interest map with a minimum
 *      spacing, so hamlets spread instead of clumping;
 *   4. seeds are connected nearest-to-the-centre first, each by a cheapest path
 *      to whatever network already exists, over a cost field that bends lanes
 *      around "rough" noise patches, charges for turning (long straight runs
 *      with occasional bends rather than staircases), and charges for running
 *      alongside an existing road (so lanes meet the network as T junctions
 *      instead of shadowing it and leaving an unbuildable sliver);
 *   5. one extra link closes a loop between two far-apart parts of the tree
 *      when a short one exists, so the village is not all dead ends.
 *
 * It does *not* place buildings. It emits rectangular zones with the same
 * affinity vocabulary (and value ranges) as the grid's AFFINITIES table, so
 * `layout.ts` and `homes.ts` run unchanged: their road-frontage ordering is what
 * lines buildings up along the lanes.
 *
 * ## Geometry: the 2×2 stamp
 *
 * Paths are searched on *cells* and every cell (x, y) paints the 2×2 block of
 * tiles {x, x+1} × {y, y+1}. Consecutive 4-connected cells overlap by two tiles,
 * so a lane is exactly 2 wide on straights and a bend is a clean 2-wide L — the
 * same top/left-anchored rule the grid uses (`mainStreetY` and `+ 1`). A lane
 * stops at the first cell whose block shares two or more tiles with the
 * existing roads (see `junction`), so every junction is edge-on and the whole
 * network is one 4-connected component by construction.
 *
 * Road cells are confined so that every painted tile keeps BORDER_BUFFER clear
 * of the map edge. The grid's roads run to the edge; these do not, because a
 * village's lanes end where its houses do.
 *
 * ## Determinism and stage independence
 *
 * All randomness comes from the `roads` fork of the master seed, which the grid
 * branch never draws from — so organic worlds are deterministic per seed, and
 * every other stage keeps its own fork exactly as before.
 *
 * Pure module: the client imports worldgen, so no Node/DB imports here.
 */
import type { RNG } from '../rng';
import type { RoadsOutput, Zone } from '../types';
import { BORDER_BUFFER, BUILDING_GAP, ROAD_BUFFER } from '../config';
import { fbm, makeValueNoise2D } from '../noise';
import { buildRoadDistance } from './roads';

type Tile = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

// ─── Tuning ───────────────────────────────────────────────────────────────────
//
// Numbers quoted below are from the track C tuning runs (auto size, 100-800
// seeds per point); `__tests__/organic.test.ts` asserts the floors. "Door
// near" = a public building's door within 2 tiles of a road; the grid measures
// ~53% at every agent count.

/**
 * Main street length as a fraction of map width, uniform in
 * [MIN, MIN + SPAN). It is the one road every public building's zone scoring
 * pulls toward, so its length is a large share of the frontage budget: 0.5-0.7
 * put 51% of public doors near a road at 13 agents, 0.6-0.8 gave 55%. 0.55-0.7
 * keeps the street visibly shorter than the map (a village, not a highway) and
 * measures 53%.
 */
const MAIN_STREET_MIN_FRAC = 0.55;
const MAIN_STREET_FRAC_SPAN = 0.15;
/** Main street horizontal / vertical jitter, as fractions of the map size. */
const MAIN_STREET_X_JITTER = 0.08;
const MAIN_STREET_Y_JITTER = 0.08;
/** Clear rows kept between the main street and the road-able frame on each
 *  side, so both halves of town hold at least one building row. */
const MAIN_STREET_EDGE_ROWS = 7;

/**
 * Map area (tiles²) per settlement seed. Each seed becomes one lane, so this is
 * the knob for how much of the map is street: 56×43 gets 10 seeds, of which ~9
 * become lanes (the rest end up beside an earlier lane). At 420 (6 seeds) road
 * cover was 229 tiles against the grid's 364 and 38% of homes' front doors sat
 * more than 6 tiles from any road; at 240 it is ~315 tiles and ~17%.
 */
const AREA_PER_SEED = 240;
const MIN_SEEDS = 4;
const MAX_SEEDS = 20;
/** Seed spacing as a fraction of the mean spacing `sqrt(innerArea / K)`. */
const SEED_SPACING_FRAC = 0.75;
const SEED_MIN_SPACING = 8;

/** Seeds keep this many cells clear of the road-able frame, so a lane end
 *  still has room for a house beyond it. */
const SEED_EDGE_MARGIN = 4;
/** A seed this close (tiles, Manhattan) to the network when its turn comes is
 *  dropped: its lane would be a 1-5 cell stub that reads as a road-side bump. */
const SEED_MIN_ROAD_DIST = 6;

/**
 * Strength of the interest falloff: interest = fbm × sqrt(1 - FALLOFF × d²),
 * with d the elliptical distance from the main street midpoint (1 at the map
 * edge). At 1.0 the corners get no seeds at all and the outer homes are left
 * without a lane; 0.6 still reads as a village with a centre. Chosen from ASCII
 * samples together with AREA_PER_SEED, not measured in isolation.
 */
const INTEREST_FALLOFF = 0.6;

/** Cost of entering any cell. */
const BASE_COST = 1;
/** Extra cost at the roughest noise, so lanes bend around patches. */
const ROUGH_COST = 6;
/** Charged when the path changes direction. ~5 cells of straight road buys one
 *  bend, which reads as a lane rather than a staircase. */
const TURN_COST = 5;
/**
 * Multiplier on a north/south step. Doors are on the south face of every
 * building, so an east-west lane is fronted by the whole row of lots north of
 * it, while a north-south lane is only ever beside their side walls. At 1.4 the
 * public door-near share was 44% at 13 agents and at 2.0 49% (both measured
 * before the street-aligned zone bands, which lifted each by a few points). The
 * lanes still bend and climb — they have to, seeds are scattered in both axes.
 */
const VERTICAL_STEP_COST = 2;
/**
 * Running close to an existing road. Charged per cell, tapering from
 * NEAR_ROAD_COST at 1 tile to 0 past NEAR_ROAD_RADIUS. A perpendicular approach
 * pays it for a few cells; a parallel run pays it for its whole length, which is
 * what stops two lanes shadowing each other a few tiles apart.
 *
 * The radius is sized to the lots: two parallel lanes whose centrelines are d
 * cells apart leave d - 4 buildable rows between their ROAD_BUFFERs, and the
 * farm needs 7, so the charge reaches out to where a strip stops being able to
 * hold it. Measured against radius 5 / cost 4: frontage and generation rates
 * unchanged, and it did *not* by itself stop the rare farm-has-nowhere-to-go
 * map growth (0.4% of 5-agent worlds either way) — `lotsStillFit` does that.
 */
const NEAR_ROAD_COST = 3;
const NEAR_ROAD_RADIUS = 8;
/** Cells within this many cells of the road-able frame pay an extra cost per
 *  cell of closeness, so lanes do not hug the map edge. */
const EDGE_RADIUS = 4;
const EDGE_COST = 2;

/**
 * Loop closing. A loop is only worth a road if it is a real shortcut: the new
 * link must reach network at least LOOP_MIN_DETOUR tiles (walking the network)
 * away, and add no more than LOOP_MAX_RATIO of that detour and LOOP_MAX_LEN
 * cells of new road.
 */
const LOOP_MIN_DETOUR = 30;
const LOOP_MAX_RATIO = 0.4;
const LOOP_MAX_LEN = 20;
/** A loop may leave its dead end through the lane's own last few tiles. */
const LOOP_EXIT_TILES = 3;

/** Tiles added to each lot's width and height in `lotsStillFit`. */
const LOT_SLACK = 1;

/** Target zone width in tiles: 3 columns at the minimum map, 5 at the cap. */
const ZONE_TARGET_W = 18;
/** Target depth of the outer (map-edge side) zone bands. */
const ZONE_TARGET_H = 14;
/** Rows in the band north of the main street: town square (8) + door + buffer. */
const NORTH_BAND = 10;
/** Rows in the band south of it, not counting the street's own two rows. */
const SOUTH_BAND = 10;
/** mainStreet closeness is scaled by this south of the street: those lots'
 *  south-facing doors open away from it. */
const SOUTH_FACING = 0.8;
/** A strip at the map edge thinner than this joins the band next to it. */
const MIN_BAND = 5;

// ─── Small binary heap (min by priority) ─────────────────────────────────────

class MinHeap {
  private pri: number[] = [];
  private val: number[] = [];
  get size() { return this.val.length; }
  push(p: number, v: number) {
    const pri = this.pri, val = this.val;
    let i = val.length;
    pri.push(p); val.push(v);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      pri[i] = pri[parent]; val[i] = val[parent];
      i = parent;
    }
    pri[i] = p; val[i] = v;
  }
  /** Pops the minimum; returns [priority, value]. Caller checks `size` first. */
  pop(): [number, number] {
    const pri = this.pri, val = this.val;
    const topP = pri[0], topV = val[0];
    const lastP = pri.pop()!, lastV = val.pop()!;
    const n = val.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && pri[r] < pri[l] ? r : l;
        if (pri[c] >= lastP) break;
        pri[i] = pri[c]; val[i] = val[c];
        i = c;
      }
      pri[i] = lastP; val[i] = lastV;
    }
    return [topP, topV];
  }
}

// ─── Network state ────────────────────────────────────────────────────────────

/** Stamp offsets, in the order a horizontal run naturally emits them. */
const STAMP: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 1], [1, 0], [1, 1]];

/** 4-neighbour directions: E, S, W, N (odd = vertical). */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * The growing road network. Tiles are kept both as an ordered list (the output
 * order, which `LightingSystem` samples every 6th tile for street lamps — so it
 * must run *along* lanes, not in scanline order) and as a bitmap for O(1)
 * membership tests. Each tile is emitted once.
 */
class Network {
  readonly tiles: Tile[] = [];
  readonly mask: Uint8Array;
  constructor(readonly width: number, height: number) {
    this.mask = new Uint8Array(width * height);
  }
  /** Paint the 2×2 stamp of each cell, appending only tiles not yet present.
   *  Returns how many tiles were added, for `undo`. */
  paint(cells: Tile[]): number {
    const before = this.tiles.length;
    for (const c of cells) {
      for (const [dx, dy] of STAMP) {
        const x = c.x + dx, y = c.y + dy;
        const i = y * this.width + x;
        if (this.mask[i]) continue;
        this.mask[i] = 1;
        this.tiles.push({ x, y });
      }
    }
    return this.tiles.length - before;
  }
  /** Remove the last `count` tiles painted. */
  undo(count: number) {
    for (let k = 0; k < count; k++) {
      const t = this.tiles.pop()!;
      this.mask[t.y * this.width + t.x] = 0;
    }
  }
}

/** What the generator decided, for tests and probes. Not part of the output. */
export interface OrganicRoadsDebug {
  mainStreet: Rect;
  seeds: Tile[];
  lanes: Tile[][];
  loops: Tile[][];
}

/**
 * Build the organic network for a `width × height` map.
 *
 * `lots` are footprints (tiles) that must still fit on the land the roads
 * leave free — the roads stage passes every building template the town will
 * have. Lanes that would break that are skipped. Empty = no guard.
 *
 * Returns the usual `RoadsOutput` plus `mainStreet` (tiles), which
 * `deriveMainstreet` uses instead of guessing the main row from tile counts.
 */
export function generateOrganicRoads(
  width: number,
  height: number,
  rng: RNG,
  lots: ReadonlyArray<{ w: number; h: number }> = [],
  debug?: (d: OrganicRoadsDebug) => void,
): RoadsOutput {
  // Fields are created first and in a fixed order: each consumes a fixed slice
  // of the stream (see makeValueNoise2D), so reordering them — or drawing
  // anything before them — changes every organic town.
  const interestNoise = makeValueNoise2D(rng);
  const roughNoise = makeValueNoise2D(rng);

  // Road cells live in [lo, hi] on each axis, so the 2×2 stamp's far tile
  // (cell + 1) still keeps BORDER_BUFFER clear of the edge.
  const loX = BORDER_BUFFER, hiX = width - 2 - BORDER_BUFFER;
  const loY = BORDER_BUFFER, hiY = height - 2 - BORDER_BUFFER;

  // ── 1. Main street ──────────────────────────────────────────────────────────
  const len = Math.round(width * (MAIN_STREET_MIN_FRAC + MAIN_STREET_FRAC_SPAN * rng.next()));
  const xJitter = Math.round((rng.next() * 2 - 1) * width * MAIN_STREET_X_JITTER);
  // Tiles x0 .. x0+len-1 must stay within [loX, hiX + 1].
  const x0 = clamp(Math.round((width - len) / 2) + xJitter, loX, hiX + 2 - len);
  const yJitter = (rng.next() * 2 - 1) * height * MAIN_STREET_Y_JITTER;
  const my = clamp(
    Math.round(height / 2 - 1 + yJitter),
    loY + MAIN_STREET_EDGE_ROWS,
    hiY - MAIN_STREET_EDGE_ROWS,
  );
  const mainCells: Tile[] = [];
  for (let x = x0; x <= x0 + len - 2; x++) mainCells.push({ x, y: my });
  const mainStreet: Rect = { x: x0, y: my, width: len, height: 2 };

  const net = new Network(width, height);
  net.paint(mainCells);

  // Town centre = main street midpoint. The interest falloff, zone civic
  // affinity and the outward growth order all measure from here rather than the
  // map centre, because the street is what the town is built around.
  const cx = x0 + len / 2;
  const cy = my + 1;

  // ── 2. Interest map ─────────────────────────────────────────────────────────
  // fBm alone would put hamlets anywhere, including the corners; the elliptical
  // falloff keeps the village a village.
  const interest = new Float32Array(width * height);
  const rx = width / 2, ry = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = fbm(interestNoise, x, y, { octaves: 3, lacunarity: 2, gain: 0.5, scale: 12 });
      const d2 = ((x + 1 - cx) / rx) ** 2 + ((y + 1 - cy) / ry) ** 2;
      interest[y * width + x] = n * Math.sqrt(Math.max(0, 1 - INTEREST_FALLOFF * d2));
    }
  }

  // ── 3. Settlement seeds ─────────────────────────────────────────────────────
  const k = clamp(Math.round((width * height) / AREA_PER_SEED), MIN_SEEDS, MAX_SEEDS);
  const innerArea = (hiX - loX + 1) * (hiY - loY + 1);
  const spacing = Math.max(SEED_MIN_SPACING, Math.round(Math.sqrt(innerArea / k) * SEED_SPACING_FRAC));

  let roadDist = buildRoadDistance(width, height, net.tiles);
  /** Distance from a cell's 2×2 stamp to the network; 0 = it touches a road. */
  const stampDist = (x: number, y: number): number => {
    const i = y * width + x;
    return Math.min(roadDist[i], roadDist[i + 1], roadDist[i + width], roadDist[i + width + 1]);
  };

  // Weighted sampling without replacement (exponential race, as in homes.ts):
  // key = -ln(U) / w draws candidates in proportion to w. Interest is squared
  // for contrast — value noise bunches around 0.5, so the raw field is too flat
  // to steer anything. One draw per cell whether or not it is eligible, so the
  // stream does not depend on the eligibility rules.
  const candidates: Array<{ x: number; y: number; key: number }> = [];
  for (let y = loY + SEED_EDGE_MARGIN; y <= hiY - SEED_EDGE_MARGIN; y++) {
    for (let x = loX + SEED_EDGE_MARGIN; x <= hiX - SEED_EDGE_MARGIN; x++) {
      const u = rng.next();
      const w = interest[y * width + x];
      if (w <= 0 || stampDist(x, y) < SEED_MIN_ROAD_DIST) continue;
      candidates.push({ x, y, key: -Math.log(1 - u) / (w * w) });
    }
  }
  candidates.sort((a, b) => a.key - b.key || a.y - b.y || a.x - b.x);
  const seeds: Tile[] = [];
  for (const c of candidates) {
    if (seeds.length >= k) break;
    if (seeds.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < spacing)) continue;
    seeds.push({ x: c.x, y: c.y });
  }

  // ── 4. Cost field ───────────────────────────────────────────────────────────
  const baseCost = new Float32Array(width * height).fill(Infinity);
  for (let y = loY; y <= hiY; y++) {
    for (let x = loX; x <= hiX; x++) {
      const r = fbm(roughNoise, x, y, { octaves: 3, lacunarity: 2, gain: 0.5, scale: 7 });
      const edge = Math.min(x - loX, hiX - x, y - loY, hiY - y);
      baseCost[y * width + x] =
        BASE_COST +
        ROUGH_COST * smoothstep(0.4, 0.7, r) +
        (edge < EDGE_RADIUS ? (EDGE_RADIUS - edge) * EDGE_COST : 0);
    }
  }

  // ── 5. Growth: outward from the centre, each seed to the existing network ──
  const ordered = seeds
    .map((s, i) => ({ s, i, d: Math.hypot(s.x + 1 - cx, s.y + 1 - cy) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((e) => e.s);

  const lanes: Tile[][] = [];
  const deadEnds: Tile[] = [];
  for (const seed of ordered) {
    // Re-checked here, not only at sampling: an earlier lane may have passed
    // right by this seed.
    if (stampDist(seed.x, seed.y) < SEED_MIN_ROAD_DIST) continue;
    const path = cheapestPath(seed, width, loX, hiX, loY, hiY, (x, y) => {
      const d = stampDist(x, y);
      if (d === 0) return junction(net, x, y);
      return baseCost[y * width + x] + nearRoadCost(d);
    });
    if (!path) continue;
    // Painted from the junction outward, so the tile order walks away from the
    // network the way a street is actually laid (and lamps follow it).
    path.reverse();
    const added = net.paint(path);
    // A lane that leaves no room for the buildings is not built. See
    // `lotsStillFit` — without this the lanes occasionally carve the map into
    // pieces too small for what the layout stage has to place.
    if (lots.length > 0 && !lotsStillFit(net, width, height, lots)) {
      net.undo(added);
      continue;
    }
    lanes.push(path);
    deadEnds.push(seed);
    roadDist = buildRoadDistance(width, height, net.tiles);
  }

  // ── 6. One loop ─────────────────────────────────────────────────────────────
  const loops: Tile[][] = [];
  const loop = closeLoop(deadEnds, net, roadDist, width, height, loX, hiX, loY, hiY, baseCost);
  if (loop) {
    // From the far junction back to the dead end, like the lanes.
    loop.reverse();
    const added = net.paint(loop);
    if (lots.length > 0 && !lotsStillFit(net, width, height, lots)) {
      net.undo(added);
    } else {
      loops.push(loop);
    }
  }

  // ── 7. Zones ────────────────────────────────────────────────────────────────
  const zones = deriveOrganicZones(width, height, interest, mainStreet, cx, cy);

  debug?.({ mainStreet, seeds, lanes, loops });
  return { tiles: net.tiles, zones, mainStreet };
}

function nearRoadCost(d: number): number {
  return d > NEAR_ROAD_RADIUS ? 0 : (NEAR_ROAD_COST * (NEAR_ROAD_RADIUS + 1 - d)) / NEAR_ROAD_RADIUS;
}

// ─── Lot guard ────────────────────────────────────────────────────────────────

/**
 * Whether `lots` can still be packed, first-fit and largest first, onto the land
 * the network leaves buildable: off the BORDER_BUFFER frame, off every road tile
 * and its ROAD_BUFFER ring, each lot LOT_SLACK tiles bigger than its template
 * and kept BUILDING_GAP from the others — the same rules `layout.ts` places by.
 *
 * Why it exists: `layout.ts` throws FitError when a template fits no zone, and
 * the pipeline then grows the whole map by 20% (or, on the `custom` size tier,
 * fails outright). The grid's blocks are fixed and known to hold the content;
 * lanes are not. Without the guard 0.4% of 5-agent and 0.1% of 13-agent auto
 * worlds grew (800 seeds each; the farm had nowhere to go); guarding only the
 * three largest templates still left a 5×4 workshop homeless in 0.5% of fixed
 * 56×43 worlds. Guarding every template: 0 grown in 800 seeds at 1 and 13
 * agents and 1 in 800 at 5, and 0 failures at 56×43 custom for 1-20 agents
 * (200 seeds). It skips under one lane in a hundred (0.4% at 13 agents).
 *
 * First-fit is optimistic (layout spreads buildings out for frontage and
 * centrality — the one remaining 5-agent miss is the farm boxed out by a
 * centrally placed town square), which is what LOT_SLACK partly buys back. It
 * is a cheap proxy, not a proof: `layout.ts` can still FitError, and the
 * pipeline's expand ladder is still the backstop. A slack of 2 closes that last
 * miss but skips one lane in seven and a third of the loops at 13 agents —
 * far too high a price for a 0.1% map growth.
 */
function lotsStillFit(
  net: Network,
  width: number,
  height: number,
  lots: ReadonlyArray<{ w: number; h: number }>,
): boolean {
  const blocked = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < BORDER_BUFFER || y < BORDER_BUFFER || x >= width - BORDER_BUFFER || y >= height - BORDER_BUFFER) {
        blocked[y * width + x] = 1;
      }
    }
  }
  for (const t of net.tiles) {
    for (let dy = -ROAD_BUFFER; dy <= ROAD_BUFFER; dy++) {
      for (let dx = -ROAD_BUFFER; dx <= ROAD_BUFFER; dx++) {
        const x = t.x + dx, y = t.y + dy;
        if (x >= 0 && y >= 0 && x < width && y < height) blocked[y * width + x] = 1;
      }
    }
  }
  // Summed-area table over `blocked`, rebuilt after each placement, so every
  // candidate origin is an O(1) rect test.
  const sat = new Int32Array((width + 1) * (height + 1));
  const rebuild = () => {
    for (let y = 0; y < height; y++) {
      let row = 0;
      for (let x = 0; x < width; x++) {
        row += blocked[y * width + x];
        sat[(y + 1) * (width + 1) + x + 1] = sat[y * (width + 1) + x + 1] + row;
      }
    }
  };
  const rectSum = (x: number, y: number, w: number, h: number) =>
    sat[(y + h) * (width + 1) + x + w] - sat[y * (width + 1) + x + w] -
    sat[(y + h) * (width + 1) + x] + sat[y * (width + 1) + x];

  const sorted = [...lots].sort((a, b) => b.w * b.h - a.w * a.h);
  rebuild();
  for (const lot of sorted) {
    const w = lot.w + LOT_SLACK, h = lot.h + LOT_SLACK;
    let placed = false;
    for (let y = 0; y + h <= height && !placed; y++) {
      for (let x = 0; x + w <= width; x++) {
        if (rectSum(x, y, w, h) !== 0) continue;
        for (let yy = Math.max(0, y - BUILDING_GAP); yy < Math.min(height, y + h + BUILDING_GAP); yy++) {
          for (let xx = Math.max(0, x - BUILDING_GAP); xx < Math.min(width, x + w + BUILDING_GAP); xx++) {
            blocked[yy * width + xx] = 1;
          }
        }
        rebuild();
        placed = true;
        break;
      }
    }
    if (!placed) return false;
  }
  return true;
}

// ─── Path search ──────────────────────────────────────────────────────────────

/**
 * How a path may end on a cell whose stamp touches the network: GOAL when the
 * stamp shares at least two tiles with it — a proper junction, meeting a road
 * edge-on — and BLOCKED when it shares only one.
 *
 * A single shared tile is a corner touch: typically a lane arriving alongside
 * another lane's dead end one row off. Accepted as a goal, it chained lanes
 * end to end with a one-row jog at each join, and three or four of those in a
 * row read as a diagonal smear rather than streets. Blocking the corner makes
 * the search either line up with the lane end or meet it side-on.
 */
function junction(net: Network, x: number, y: number): number {
  let shared = 0;
  for (const [dx, dy] of STAMP) shared += net.mask[(y + dy) * net.width + x + dx];
  return shared >= 2 ? GOAL : BLOCKED;
}

/** Cost-function sentinels: the cell ends the search / cannot be entered. */
const GOAL = -1;
const BLOCKED = -2;
/** Memo sentinel for "not computed yet". */
const UNSET = -3;

/**
 * Dijkstra over (cell, heading) states from `start` to the first cell for which
 * `cost` returns GOAL (BLOCKED cells are never entered). Heading is part of the
 * state because the turn charge depends on it; without it the search cannot
 * tell a straight run from a zigzag of the same length. Returns the cell path
 * start → goal (inclusive), or null.
 *
 * No heuristic: the goal is "any cell touching the network", whose nearest
 * member is not known in advance, and the map is small (≤ 90×70 cells × 5
 * states), so plain Dijkstra costs a millisecond or two.
 */
function cheapestPath(
  start: Tile,
  width: number,
  loX: number, hiX: number, loY: number, hiY: number,
  cost: (x: number, y: number) => number,
): Tile[] | null {
  const cells = width * (hiY + 2);
  const states = cells * 5; // 4 headings + "none" for the start
  const dist = new Float64Array(states).fill(Infinity);
  const prev = new Int32Array(states).fill(-1);
  const heap = new MinHeap();
  const startState = (start.y * width + start.x) * 5 + 4;
  dist[startState] = 0;
  heap.push(0, startState);
  // Memoised per cell: `cost` does noise and distance lookups and would
  // otherwise run once per incoming edge.
  const memo = new Float64Array(cells).fill(UNSET);
  const costAt = (x: number, y: number) => {
    const i = y * width + x;
    if (memo[i] === UNSET) memo[i] = cost(x, y);
    return memo[i];
  };

  while (heap.size > 0) {
    const [d, s] = heap.pop();
    if (d > dist[s]) continue;
    const cell = (s / 5) | 0;
    const heading = s % 5;
    const x = cell % width, y = (cell - x) / width;
    if (s !== startState && costAt(x, y) === GOAL) {
      const out: Tile[] = [];
      for (let t = s; t !== -1; t = prev[t]) {
        const c = (t / 5) | 0;
        const tx = c % width;
        out.push({ x: tx, y: (c - tx) / width });
      }
      return out.reverse();
    }
    for (let dir = 0; dir < 4; dir++) {
      // No U-turns: they only ever produce a 2×3 blob.
      if (heading !== 4 && dir === (heading + 2) % 4) continue;
      const nx = x + DX[dir], ny = y + DY[dir];
      if (nx < loX || nx > hiX || ny < loY || ny > hiY) continue;
      const c = costAt(nx, ny);
      if (c === BLOCKED) continue;
      const step = (c === GOAL ? BASE_COST : c) * (dir % 2 === 1 ? VERTICAL_STEP_COST : 1);
      const nd = d + step + (heading !== 4 && heading !== dir ? TURN_COST : 0);
      const ns = (ny * width + nx) * 5 + dir;
      if (nd < dist[ns]) {
        dist[ns] = nd;
        prev[ns] = s;
        heap.push(nd, ns);
      }
    }
  }
  return null;
}

/**
 * Close one loop: from some lane's dead end, find a short link to a part of the
 * network that is a long *walk* away. Every dead end is tried; the link that
 * saves the most walking and passes the LOOP_* limits is built. Nearly every
 * town has one (98% at 56×43); when none qualifies the village stays a tree.
 */
function closeLoop(
  deadEnds: Tile[],
  net: Network,
  roadDist: Int32Array,
  width: number,
  height: number,
  loX: number, hiX: number, loY: number, hiY: number,
  baseCost: Float32Array,
): Tile[] | null {
  let best: { path: Tile[]; gain: number } | null = null;
  for (const end of deadEnds) {
    const walk = networkWalk(net, width, height, end);
    const path = cheapestPath(end, width, loX, hiX, loY, hiY, (x, y) => {
      let touchesFar = false, touchesNear = false, touchesMid = false;
      for (const [dx, dy] of STAMP) {
        const i = (y + dy) * width + x + dx;
        if (!net.mask[i]) continue;
        if (walk[i] >= LOOP_MIN_DETOUR) touchesFar = true;
        else if (walk[i] <= LOOP_EXIT_TILES) touchesNear = true;
        else touchesMid = true;
      }
      // Any contact with network that is neither the far target nor the dead
      // end's own last tiles would be a junction nobody asked for.
      if (touchesMid) return BLOCKED;
      if (touchesFar) return touchesNear ? BLOCKED : junction(net, x, y);
      const i = y * width + x;
      if (touchesNear) return baseCost[i];
      const d = Math.min(roadDist[i], roadDist[i + 1], roadDist[i + width], roadDist[i + width + 1]);
      return baseCost[i] + nearRoadCost(d);
    });
    if (!path) continue;
    // Only cells that add road count toward the link's length.
    const fresh = path.filter((c) => !STAMP.every(([dx, dy]) => net.mask[(c.y + dy) * width + c.x + dx]));
    const last = path[path.length - 1];
    let detour = Infinity;
    for (const [dx, dy] of STAMP) {
      const i = (last.y + dy) * width + last.x + dx;
      if (net.mask[i]) detour = Math.min(detour, walk[i]);
    }
    if (fresh.length > LOOP_MAX_LEN || fresh.length > detour * LOOP_MAX_RATIO) continue;
    const gain = detour - fresh.length;
    if (!best || gain > best.gain) best = { path, gain };
  }
  return best?.path ?? null;
}

/** BFS walking distance (tiles, 4-connected) over road tiles from a cell's stamp. */
function networkWalk(net: Network, width: number, height: number, from: Tile): Int32Array {
  const dist = new Int32Array(width * height).fill(0x7fffffff);
  const queue: number[] = [];
  for (const [dx, dy] of STAMP) {
    const i = (from.y + dy) * width + from.x + dx;
    if (net.mask[i] && dist[i] !== 0) { dist[i] = 0; queue.push(i); }
  }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    const x = i % width, y = (i - x) / width;
    for (let dir = 0; dir < 4; dir++) {
      const nx = x + DX[dir], ny = y + DY[dir];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (!net.mask[j] || dist[j] <= dist[i] + 1) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }
  return dist;
}

// ─── Zones ────────────────────────────────────────────────────────────────────

/**
 * Rect cells over the inner map, with affinities in the same ranges as the
 * grid's AFFINITIES table (0-5, mainStreet 0-4) so every template's
 * `zoneWeights` means what it was tuned to mean:
 *
 * - mainStreet: high on the cells beside the main street, falling off over half
 *   the map height; a little lower south of it, whose doors face away.
 * - commercial: follows mainStreet, lifted a little by interest (busy spots).
 * - civic: near the town centre (the main street midpoint) — the town hall,
 *   square and park want to be where everyone walks past.
 * - residential: away from the main street and the centre.
 *
 * Rows are cut *at the main street*, not evenly. `layout.ts` only places a
 * building wholly inside one zone, and its doors are on the south face, so the
 * lots that front the street are the band of rows directly north of it. Even
 * rows put the street through the middle of a row of cells and cut that band
 * into pieces shorter than the town square: measured, the town square's door
 * then sat more than 6 tiles from any road in 45% of 13-agent worlds (15%
 * after). The band north of the street is therefore its own row of cells,
 * NORTH_BAND rows deep.
 *
 * Unlike the grid's zones these include road tiles — lanes run anywhere, so a
 * road-free rectangle decomposition would be irregular. That is harmless:
 * `layout`'s `fits` and `homes`' candidate filter both test the blocked mask
 * tile by tile, and the zone only scopes and scores the search. It does inflate
 * each zone's area a little in `scoreZone`'s remaining-area term, equally for
 * every zone a lane crosses.
 */
function deriveOrganicZones(
  width: number,
  height: number,
  interest: Float32Array,
  mainStreet: Rect,
  cx: number,
  cy: number,
): Zone[] {
  const x1 = BORDER_BUFFER, x2 = width - 1 - BORDER_BUFFER;
  const y1 = BORDER_BUFFER, y2 = height - 1 - BORDER_BUFFER;
  const innerW = x2 - x1 + 1;
  const cols = Math.max(3, Math.round(innerW / ZONE_TARGET_W));
  const colEdges = splitEven(x1, innerW, cols);

  // Row edges; band i is [edge_i, edge_i+1). The street's own rows go with the
  // south band so the bands tile the whole inner map and every tile `homes.ts`
  // asks about resolves to a real cell. A leftover strip thinner than MIN_BAND
  // at either end is absorbed by the inner band next to it.
  const my = mainStreet.y;
  let northTop = Math.max(y1, my - NORTH_BAND);
  if (northTop - y1 < MIN_BAND) northTop = y1;
  let southEnd = Math.min(y2 + 1, my + mainStreet.height + SOUTH_BAND);
  if (y2 + 1 - southEnd < MIN_BAND) southEnd = y2 + 1;
  const rowEdges = [
    ...outerBands(y1, northTop),
    northTop,
    my,
    southEnd,
    ...outerBands(southEnd, y2 + 1),
    y2 + 1,
  ].filter((e, i, a) => i === 0 || e > a[i - 1]);

  const maxCentreDist = Math.hypot(Math.max(cx - x1, x2 - cx), Math.max(cy - y1, y2 - cy));
  const cells: Array<{ id: string; bounds: Zone['bounds']; ms: number; cen: number; int: number }> = [];
  for (let r = 0; r + 1 < rowEdges.length; r++) {
    for (let c = 0; c < cols; c++) {
      const b = { x1: colEdges[c], y1: rowEdges[r], x2: colEdges[c + 1] - 1, y2: rowEdges[r + 1] - 1 };
      const zx = (b.x1 + b.x2 + 1) / 2, zy = (b.y1 + b.y2 + 1) / 2;
      // Distance from the zone rect (not its centre) to the street rect: a zone
      // the street runs beside is at ~0 however big it is.
      const gx = Math.max(0, mainStreet.x - (b.x2 + 1), b.x1 - (mainStreet.x + mainStreet.width));
      const gy = Math.max(0, mainStreet.y - (b.y2 + 1), b.y1 - (mainStreet.y + mainStreet.height));
      const south = b.y1 >= my;
      const ms = (1 - Math.min(Math.hypot(gx, gy) / (height / 2), 1)) * (south ? SOUTH_FACING : 1);
      const cen = 1 - Math.min(Math.hypot(zx - cx, zy - cy) / maxCentreDist, 1);
      let sum = 0, n = 0;
      for (let y = b.y1; y <= b.y2; y++) {
        for (let x = b.x1; x <= b.x2; x++) { sum += interest[y * width + x]; n++; }
      }
      cells.push({ id: `o${r}_${c}`, bounds: b, ms, cen, int: n ? sum / n : 0 });
    }
  }
  // Interest by rank across cells, so the term spans [0, 1] on every map
  // whatever the noise's absolute level.
  const byInt = [...cells].sort((a, b) => a.int - b.int || a.id.localeCompare(b.id));
  const intRank = new Map(byInt.map((z, i) => [z.id, cells.length > 1 ? i / (cells.length - 1) : 0.5]));

  const zones: Zone[] = cells.map((z) => {
    const it = intRank.get(z.id)!;
    return {
      id: z.id,
      bounds: z.bounds,
      affinity: {
        mainStreet: round2(4 * z.ms * z.ms),
        commercial: round2(1 + 4 * z.ms * (0.6 + 0.4 * it)),
        civic: round2(5 * z.cen * (1 - 0.3 * z.ms)),
        residential: round2(5 * (1 - z.ms * z.cen) * (0.4 + 0.6 * (1 - z.ms))),
      },
    };
  });

  // Last-resort zone: the whole inner map, with every affinity 0.
  //
  // `layout.ts` only places a building whose footprint lies wholly inside one
  // zone. On the grid that is fine — zones *are* the blocks between the roads.
  // Here lanes cross the cells at arbitrary places, so a cell can be cut into
  // pieces too small for the farm (10×7) or the park (8×6) even when there is a
  // perfectly good lot straddling two cells. Without this zone that surfaced as
  // a layout FitError, and a needlessly grown map, in ~5% of 13-agent worlds.
  //
  // Scoring 0 on every affinity, it sorts after every cell with any affinity at
  // all, so it only receives a template no better zone could hold. It is
  // appended *last* so `homes.ts`'s `zones.find` — which takes the first zone
  // containing a tile — always resolves to a real cell (they tile the same
  // inner map) and never to this one.
  zones.push({
    id: 'o_any',
    bounds: { x1, y1, x2, y2 },
    affinity: { mainStreet: 0, commercial: 0, civic: 0, residential: 0 },
  });
  return zones;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(a: number, b: number, v: number): number {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Edges splitting the rows [start, end) into near-equal bands of about
 * ZONE_TARGET_H, *excluding* `end`. Empty for an empty span.
 */
function outerBands(start: number, end: number): number[] {
  const len = end - start;
  if (len <= 0) return [];
  const n = Math.max(1, Math.round(len / ZONE_TARGET_H));
  return splitEven(start, len, n).slice(0, -1);
}

/** `n + 1` edges splitting [start, start + len) into `n` near-equal parts. */
function splitEven(start: number, len: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(start + Math.round((len * i) / n));
  return out;
}
