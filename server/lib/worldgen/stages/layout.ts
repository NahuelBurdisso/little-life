import {
  getTemplatesForAgentCount,
  templateToLocationSeed,
  type BuildingTemplate,
} from '../buildingTemplates';
import { FitError, type Stage, type Zone } from '../types';
import type { LocationSeed } from '../types';
// RNG type used implicitly via stage interface
import { TILE, BUILDING_GAP, ROAD_BUFFER, BORDER_BUFFER } from '../config';
import { buildRoadDistance } from './roadDistance';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Row-major occupancy bitmap. Was a `Set<string>` of "x,y" keys, which allocated
 * a string on every tile test — fine when slot enumeration was a coarse lattice,
 * far too slow now that slots are enumerated at stride 1.
 */
interface BlockedMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Build the blocked mask: border + road tiles + road buffer. */
function buildBlockedMask(
  width: number,
  height: number,
  roadTiles: Array<{ x: number; y: number }>,
): BlockedMask {
  const mask: BlockedMask = {
    width,
    height,
    data: new Uint8Array(width * height),
  };

  // Border frame (BORDER_BUFFER tiles from each edge)
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (
        x < BORDER_BUFFER ||
        x >= width - BORDER_BUFFER ||
        y < BORDER_BUFFER ||
        y >= height - BORDER_BUFFER
      ) {
        mask.data[y * width + x] = 1;
      }
    }
  }

  // Road tiles + ROAD_BUFFER around them
  for (const t of roadTiles) {
    for (let dy = -ROAD_BUFFER; dy <= ROAD_BUFFER; dy++) {
      for (let dx = -ROAD_BUFFER; dx <= ROAD_BUFFER; dx++) {
        const x = t.x + dx;
        const y = t.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        mask.data[y * width + x] = 1;
      }
    }
  }

  return mask;
}


/** Check if a building footprint at (sx, sy) with size (w, h) fits without
 *  hitting any blocked tile. */
function fits(
  sx: number,
  sy: number,
  w: number,
  h: number,
  blocked: BlockedMask,
): boolean {
  // Off-map tiles used to be simply absent from the mask, which read as free —
  // `deriveMarketSquare` could scan past the bottom edge and "fit" a plaza
  // entirely outside the world.
  if (sx < 0 || sy < 0 || sx + w > blocked.width || sy + h > blocked.height) {
    return false;
  }
  for (let y = sy; y < sy + h; y++) {
    for (let x = sx; x < sx + w; x++) {
      if (blocked.data[y * blocked.width + x]) return false;
    }
  }
  return true;
}

/** Mark a building footprint + BUILDING_GAP buffer as blocked. */
function markPlaced(
  sx: number,
  sy: number,
  w: number,
  h: number,
  blocked: BlockedMask,
): void {
  for (let y = sy - BUILDING_GAP; y < sy + h + BUILDING_GAP; y++) {
    if (y < 0 || y >= blocked.height) continue;
    for (let x = sx - BUILDING_GAP; x < sx + w + BUILDING_GAP; x++) {
      if (x < 0 || x >= blocked.width) continue;
      blocked.data[y * blocked.width + x] = 1;
    }
  }
}

/**
 * Zone capacity a placed template consumes, charged against `zoneArea` in
 * `scoreZone`. This is a *desirability* penalty — "this zone is filling up" —
 * not a hard constraint; `fits` is the only thing that decides what can
 * physically go where.
 *
 * Two things used to make it far too aggressive, and because `remainingFraction`
 * multiplies the score linearly, a single early charge could delete a zone for
 * every template placed after it. Templates are placed largest-first, so the
 * three biggest — town_square (9×8), farm (10×7), park (8×6) — always went first
 * and always did the deleting.
 *
 * 1. It charged `(w + GAP) * (h + GAP)`: 110 tiles for a 72-tile town square.
 *    Against cm's 168-tile area at the 56×43 minimum that is
 *    `remainingFraction = 0.345`, which is enough to make cm arithmetically
 *    unwinnable for *every* commercial template even at maximum favourable
 *    jitter — clinic's best possible cm score was 20.7 against a worst possible
 *    em score of 24.6. Measured: clinic reached its declared cm zone in 2% of
 *    seeds at 13 agents and 5% at 5 agents. Same story for town_hall in nc
 *    (20%) once park had claimed it.
 * 2. It charged public plazas at the same rate as a building. The town square
 *    and the park are walkable civic space; a shop *next to the square* is the
 *    intent of the affinity table, not a conflict. Charging them anything at all
 *    is backwards, so they are now free.
 *
 * The MIN_WIDTH/MIN_HEIGHT clamp holds every world with 1-19 agents at 56×43, so
 * this was the normal case rather than an edge case. It self-corrected only on
 * maps you rarely generate: at 84×59 cm's area reaches 432 and clinic found its
 * zone 55% of the time.
 *
 * The farm is open ground too but is deliberately *not* exempt. It is the one
 * open area that wants a buffer rather than a frontage: `deriveFarmyard` claims
 * the strip beside it after all templates are placed, and with the farm charging
 * nothing its zone still read as empty, so neighbours crowded the plot. Measured
 * farmyard generation rate with the farm exempt: 17%, against 98% charged.
 */
const PLAZA_TYPES: ReadonlySet<string> = new Set(['town_square']);

function chargedArea(template: BuildingTemplate): number {
  if (PLAZA_TYPES.has(template.type)) return 0;
  return template.size.w * template.size.h;
}

/** Score a template against a zone. */
function scoreZone(
  template: BuildingTemplate,
  zone: Zone,
  usedAreaByZone: Map<string, number>,
  mapWidth: number,
  mapHeight: number,
  maxZoneDist: number,
): number {
  const zoneArea =
    (zone.bounds.x2 - zone.bounds.x1 + 1) *
    (zone.bounds.y2 - zone.bounds.y1 + 1);
  const used = usedAreaByZone.get(zone.id) ?? 0;
  const remainingFraction = Math.max(0, 1 - used / zoneArea);

  let score = 0;
  for (const [key, weight] of Object.entries(template.zoneWeights)) {
    score += weight * (zone.affinity[key] ?? 0);
  }

  // Zone affinity alone is blind to geometry, so the highest-traffic venues
  // (park, town square) kept winning a corner zone whose civic affinity happened
  // to be one point higher than the middle's. `centrality` re-weights toward the
  // map centre for venues everyone walks to, and leaves the deliberately
  // peripheral ones (farm, prison, divebar) at 0.
  //
  // `maxZoneDist` is the distance from the map centre to the furthest zone
  // centre. It used to be `hypot(mapWidth / 2, mapHeight / 2)` — the distance to
  // a map *corner*, which is not a value this expression can ever be fed, since
  // the only inputs are the nine zone centres. The factor therefore never
  // reached either end of its documented `1 .. 1 + centrality` range: at
  // centrality 1.0 the realised spread across zones was 1.28-1.90 rather than
  // 1.00-2.00, and at 0.5 it was 1.27× rather than 1.50×. Five of the nine
  // non-zero `centrality` values in BUILDING_TEMPLATES — town_square, bakery,
  // clinic, pawnshop, workshop — could not flip a single placement in 300
  // sampled worlds as a result.
  const centrality = template.centrality ?? 0;
  let centralityFactor = 1;
  if (centrality > 0 && maxZoneDist > 0) {
    const zcx = (zone.bounds.x1 + zone.bounds.x2) / 2;
    const zcy = (zone.bounds.y1 + zone.bounds.y2) / 2;
    const dist = Math.hypot(zcx - mapWidth / 2, zcy - mapHeight / 2);
    centralityFactor = 1 + centrality * (1 - Math.min(dist / maxZoneDist, 1));
  }

  return score * remainingFraction * centralityFactor;
}

/** Generate candidate slots within a zone for a building. */
function generateSlots(
  zone: Zone,
  w: number,
  h: number,
): Array<{ x: number; y: number }> {
  const slots: Array<{ x: number; y: number }> = [];
  const { x1, y1, x2, y2 } = zone.bounds;

  // Stride 1 over the whole zone. The old lattice stepped by `size + gap` from
  // an inset origin, which yielded exactly one candidate per zone for the large
  // templates — so the slot shuffle had nothing to choose and every seed
  // produced the same town. Separation is already enforced by `markPlaced`
  // writing a BUILDING_GAP ring, and the border/road margins by the mask, so
  // neither the inset nor the stride was load-bearing.
  for (let sy = y1; sy + h <= y2 + 1; sy++) {
    for (let sx = x1; sx + w <= x2 + 1; sx++) {
      slots.push({ x: sx, y: sy });
    }
  }
  return slots;
}

/**
 * Organic-layout slots: every origin whose footprint's *centre* tile lies in the
 * zone, rather than every origin whose whole footprint does.
 *
 * On the grid the zones are the blocks between the roads, so "wholly inside"
 * is exactly "on this block". Organic zones are plain rect cells laid over a
 * map that lanes cross at arbitrary places, so the wholly-inside rule threw away
 * the lots that matter most: a lane usually runs near a cell edge or through
 * it, and the strip that fronts it is cut in two by the cell boundary. A 9×8
 * town square or an 8×6 park fitted in neither half and went to the back of the
 * cell, or to the whole-map fallback zone — measured, the park's door ended up
 * more than 6 tiles from any road in 24.5% of 13-agent towns (grid: 1.5%).
 *
 * Every origin still belongs to exactly one cell (the cells tile the inner map
 * and each origin has one centre), so no lot is offered twice, and the zone
 * still decides the neighbourhood — a building sits mostly in the cell whose
 * affinities placed it. `fits` alone decides what is physically buildable, as
 * it always did.
 */
function generateCentredSlots(
  zone: Zone,
  w: number,
  h: number,
): Array<{ x: number; y: number }> {
  const slots: Array<{ x: number; y: number }> = [];
  const { x1, y1, x2, y2 } = zone.bounds;
  const ox = Math.floor(w / 2), oy = Math.floor(h / 2);
  for (let sy = y1 - oy; sy <= y2 - oy; sy++) {
    for (let sx = x1 - ox; sx <= x2 - ox; sx++) {
      slots.push({ x: sx, y: sy });
    }
  }
  return slots;
}

// ─── Outdoor location derivation ──────────────────────────────────────────────

function deriveMainstreet(
  roadTiles: Array<{ x: number; y: number }>,
  known?: { x: number; y: number; width: number; height: number },
): LocationSeed | null {
  // A road generator that knows where its main street is says so. The organic
  // layout's lanes put road tiles on the main street's rows outside the street
  // itself, so the inference below would be guessing.
  if (known) return mainstreetSeed(known.x, known.y, known.width, known.height);
  if (roadTiles.length === 0) return null;

  // Find the main street row: the y value that appears most in road tiles.
  // Main street is horizontal, so group by y.
  const yCount = new Map<number, number>();
  for (const t of roadTiles) {
    yCount.set(t.y, (yCount.get(t.y) ?? 0) + 1);
  }
  // Pick the y with most tiles (main street spans full width)
  let bestY = roadTiles[0].y;
  let bestCount = 0;
  for (const [y, count] of yCount) {
    if (count > bestCount) {
      bestCount = count;
      bestY = y;
    }
  }

  // The longest contiguous run on that row, leftmost on a tie. This used to span
  // min..max x of *every* tile on the row, which is only the street when the row
  // holds one unbroken run: two unrelated stretches of road on the same row
  // would have produced one rect covering the ground (and any buildings)
  // between them. On the grid the row is a single full-width run, so this picks
  // exactly the span it always did.
  const xs = [...new Set(roadTiles.filter((t) => t.y === bestY).map((t) => t.x))].sort((a, b) => a - b);
  let minX = xs[0], maxX = xs[0];
  for (let i = 0, runStart = xs[0]; i < xs.length; i++) {
    if (i > 0 && xs[i] !== xs[i - 1] + 1) runStart = xs[i];
    if (xs[i] - runStart > maxX - minX) { minX = runStart; maxX = xs[i]; }
  }

  return mainstreetSeed(minX, bestY, maxX - minX + 1, 2);
}

/** The `mainstreet` location for a street occupying the given tile rect. */
function mainstreetSeed(minX: number, y: number, streetLen: number, rows: number): LocationSeed {
  const midX = Math.floor((minX + minX + streetLen - 1) / 2);
  return {
    name: 'Main Street',
    type: 'mainstreet',
    position: {
      x: minX * TILE,
      y: y * TILE,
      width: streetLen * TILE,
      height: rows * TILE,
    },
    entry_point: { x: midX * TILE, y: y * TILE },
    capacity: Math.max(20, streetLen),
    current_occupants: [],
    operating_hours: null,
    services: [],
    description:
      'The main thoroughfare through town, where most commerce and socializing happens.',
    owner: null,
  };
}

/** Widest an alley may be, in tiles, however far apart its two buildings are. */
const ALLEY_MAX_SPAN = 3;

/** The buildings a Back Alley may run between. */
const COMMERCIAL_TYPES: ReadonlySet<string> = new Set(['shop', 'tavern', 'bakery', 'pawnshop', 'divebar']);

/** Lexicographic `a < b` over equal-length number tuples. */
function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * Organic towns build along their lanes: before settling for a back lot in its
 * best zone, a venue takes a lot whose door is at most this many tiles from a
 * road in any zone scoring at least LANE_FRONT_SCORE_RATIO of the best. See
 * the zone choice in `layoutStage`.
 *
 * 0.6 is loose on purpose — the organic zones are cut from an interest map,
 * not from blocks, and neighbouring cells often score within a few percent of
 * each other, so a tighter bar mostly re-asks the one zone that had no lane.
 */
const LANE_FRONT_DOOR = 2;
const LANE_FRONT_SCORE_RATIO = 0.6;

/**
 * How far from a road a commercial lot's door may be and still count toward a
 * row of shops (`rowLot` / `rowKey` in `layoutStage`). Looser than
 * LANE_FRONT_DOOR because a lane that bends leaves the lot next door a tile or
 * two further back than its neighbour — with the row lot at 2 the alley
 * generated in 82.5% of 13-agent organic towns, at 4 in 86.5%.
 */
const ROW_FRONT_DOOR = 4;
/** Footprint of the smallest commercial template (shop, bakery, pawnshop,
 *  divebar): the lot a row must keep free beside it for the next shop. */
const ROW_NEIGHBOUR = { w: 5, h: 4 };

/**
 * Fractional +/- noise applied to every zone score, so towns differ per seed.
 *
 * The scores are *multiplied* by `1 ± this`, so the widest lead the noise can
 * overturn is `(1 + j) / (1 - j)` — which at the previous 0.3 was 1.86×, not the
 * "clear affinity winner still wins" the call site claimed. Measured over 4,800
 * placements at 13 and 30 agents, 0.3 overturned the affinity argmax in 7.3% of
 * the placements where it led the runner-up by more than 1.25×, and 1.4% of
 * those where it led by more than 1.5×. Zone affinity is the whole mechanism by
 * which a town reads as zoned, so those are placements where the town quietly
 * stopped being one.
 *
 * 0.22 caps the overturnable lead at 1.56×, and over the same 4,800 placements
 * overturns 2.2% of the >1.25× leads and none of the >1.5× ones. The flips it
 * keeps are mostly the near-ties the jitter exists to break: 12.1% of the
 * 1.1-1.25× band.
 *
 * It is a floor, not a preference — lower is better for zoning and was tried
 * first. Narrowing the jitter concentrates every venue into its argmax zone,
 * where they then compete for that one zone's road frontage, so the share of
 * public buildings whose door is within 2 tiles of a road falls off: 54% at 0.3,
 * 52% at 0.22, 50.0% at 0.20, 47% at 0.18 (13 agents). Frontage is the more
 * visible property of the two, so this sits at the smallest value that holds it
 * above half: re-measured over 200 seeds, 0.22 gives 52.7% at 13 agents and
 * 54.3% at 30. layout.test.ts asserts >48% over 60 seeds — the bar is set below
 * the measured rate for sampling headroom, NOT as licence to spend the
 * difference by narrowing this constant.
 *
 * Do not *raise* it to buy variety, though. Variety within a zone is the slot
 * shuffle's job and is far cheaper: at 0 jitter every venue still lands on 4-16
 * distinct origins across seeds, it is only the choice of zone that freezes.
 */
const ZONE_SCORE_JITTER = 0.22;

/**
 * Slots are grouped into bands this many tiles deep by the distance from their
 * doorway to the nearest road, and the shallowest band is tried first. A band of
 * 2 keeps everything that fronts directly onto the street in one pool, so the
 * shuffle and the centrality tiebreak still choose freely among them.
 */
const ROAD_FRONTAGE_BUCKET = 2;

/**
 * Past this distance a doorway is simply "off the street" and further does not
 * mean worse, so the band is clamped and the centrality tiebreak takes over. Left
 * uncapped, a remote-but-central slot always lost to a nearer-to-road one on the
 * far edge of the map.
 */
const ROAD_FRONTAGE_CAP = 8;

/**
 * How far `ringCandidates` may walk from its anchor, in tiles. Both need to reach
 * past the anchor's own reserved gap and the adjacent road buffers; Market Square
 * needs more because the town square usually fills its zone.
 *
 * Farmyard: radius 2 generated 13/30 seeds, 4 → 24/30, 6 → 30/30. (A later
 * 200-seed sample put radius 6 at 92.5% rather than 100% — the 30/30 was a
 * small-sample artifact, but 6 is still the right knee of the curve.)
 */
const MARKET_SQUARE_SEARCH_RADIUS = 10;
const FARMYARD_SEARCH_RADIUS = 6;

/**
 * Past this many tiles from the town square, Market Square stops being "beside
 * the town center" and reads as a detached lot, so it gets an honest description
 * instead. Shrinking the radius instead would just lose those worlds.
 *
 * The floor is 4, not 0: the town square fills its zone, so the nearest lot that
 * `fits` is across the adjacent road, which is 2 road tiles plus a ROAD_BUFFER
 * either side. Anything from 4 to 6 is therefore "across the street" and 7+ is a
 * block away, which is what this threshold is drawing the line between.
 *
 * Measured over 300 seeds per size, this fires far more often in bigger towns —
 * the extra homes fill the near ring and push the lot outward. Share landing
 * beyond the radius: 15% at 13 agents, 82% at 20, 87% at 30, with the modal gap
 * moving 6 → 7 → 8. Do not read the 13-agent figure as typical; the comment here
 * used to quote it alone and it is the best case, not the common one.
 */
const MARKET_SQUARE_ADJACENT_RADIUS = 6;

/**
 * Candidate origins for a `w`×`h` plot placed around an anchor building, walking
 * all four sides. Offsets start at BUILDING_GAP because `markPlaced` reserves
 * that ring around the anchor — anything closer is blocked by construction.
 */
function ringCandidates(
  anchor: { tileX: number; tileY: number; w: number; h: number },
  w: number,
  h: number,
  maxOffset = FARMYARD_SEARCH_RADIUS,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];

  // Rings at growing distance, nearest first, so the plot stays as close to its
  // anchor as the surrounding roads and buildings allow.
  for (let off = BUILDING_GAP; off <= maxOffset; off++) {
    const south = anchor.tileY + anchor.h + off;
    const north = anchor.tileY - off - h;
    const east = anchor.tileX + anchor.w + off;
    const west = anchor.tileX - off - w;

    // Slide along each face so a single blocked column doesn't veto the side.
    for (let x = anchor.tileX - w + 1; x <= anchor.tileX + anchor.w - 1; x++) {
      out.push({ x, y: south });
      out.push({ x, y: north });
    }
    for (let y = anchor.tileY - h + 1; y <= anchor.tileY + anchor.h - 1; y++) {
      out.push({ x: east, y });
      out.push({ x: west, y });
    }
  }
  return out;
}

function deriveMarketSquare(
  placedBuildings: Array<{ type: string; tileX: number; tileY: number; w: number; h: number }>,
  blocked: BlockedMask,
): LocationSeed | null {
  const townSquare = placedBuildings.find((b) => b.type === 'town_square');
  if (!townSquare) return null;

  const minW = 4;
  const minH = 4;

  // The old scan started at `tileY + h + 1` — one row inside the town square's
  // own BUILDING_GAP ring, so its first row was always blocked — and only looked
  // south, straight into the cross-path road buffer. Market Square therefore
  // never generated on the default map size. The town square fills most of its
  // zone, so the search has to reach past the adjacent roads.
  for (const c of ringCandidates(townSquare, minW, minH, MARKET_SQUARE_SEARCH_RADIUS)) {
    if (fits(c.x, c.y, minW, minH, blocked)) {
      // `ringCandidates` walks outward, so the first fit is the nearest one.
      const gap = Math.max(
        Math.max(townSquare.tileX - (c.x + minW), c.x - (townSquare.tileX + townSquare.w), 0),
        Math.max(townSquare.tileY - (c.y + minH), c.y - (townSquare.tileY + townSquare.h), 0),
      );
      const adjacent = gap <= MARKET_SQUARE_ADJACENT_RADIUS;
      return {
        name: 'Market Square',
        type: 'market_square',
        position: {
          x: c.x * TILE,
          y: c.y * TILE,
          width: minW * TILE,
          height: minH * TILE,
        },
        entry_point: { x: (c.x + minW / 2) * TILE, y: (c.y + minH) * TILE },
        capacity: 15,
        current_occupants: [],
        operating_hours: null,
        services: [],
        description: adjacent
          ? 'An open square beside the town center, where vendors and performers gather.'
          : 'An open market lot a short walk from the town center, where vendors and performers gather.',
        owner: null,
      };
    }
  }
  return null;
}

function deriveAlley(
  placedBuildings: Array<{ type: string; tileX: number; tileY: number; w: number; h: number }>,
  roadTiles: Array<{ x: number; y: number }>,
): LocationSeed | null {
  const commercial = placedBuildings.filter((b) => COMMERCIAL_TYPES.has(b.type));

  const roads = new Set(roadTiles.map((t) => `${t.x},${t.y}`));

  // Door tile of every placed building. `entry_point` is south-centre, i.e. the
  // row immediately *below* the footprint — which for a stacked pair is exactly
  // the row `deriveAlley` wants to start the alley on.
  const doors = placedBuildings.map((b) => ({
    x: b.tileX + Math.floor(b.w / 2),
    y: b.tileY + b.h,
  }));

  /**
   * The gap between two commercial buildings is only *theirs* if nothing else is
   * in it. Once arbitrary gap widths became eligible below, a third building or a
   * road could sit between the pair and the alley would be laid straight on top
   * of it (measured: alley×clinic and alley×workshop overlaps).
   */
  const rectClear = (x: number, y: number, w: number, h: number): boolean => {
    for (const b of placedBuildings) {
      if (x < b.tileX + b.w && x + w > b.tileX && y < b.tileY + b.h && y + h > b.tileY) {
        return false;
      }
    }
    // Doorways. A stacked alley's top row *is* the upper building's door row by
    // construction, and footprint checks never caught it because the door sits
    // outside the footprint: 105 of 115 stacked alleys were laid across a shop
    // or tavern doorstep. The renderer paints the alley over the door, and
    // `findContainingLocation` only resolved the ambiguity by array order.
    for (const d of doors) {
      if (d.x >= x && d.x < x + w && d.y >= y && d.y < y + h) return false;
    }
    // Roads, plus the same ROAD_BUFFER every other rect keeps. The alley was the
    // only rect that could sit 1 tile from a road, because it is placed by
    // geometry rather than through the `fits` mask.
    for (let ty = y - ROAD_BUFFER; ty < y + h + ROAD_BUFFER; ty++) {
      for (let tx = x - ROAD_BUFFER; tx < x + w + ROAD_BUFFER; tx++) {
        if (roads.has(`${tx},${ty}`)) return false;
      }
    }
    return true;
  };

  // Best (smallest-gap) candidate rather than the first one found.
  //
  // The span is the *whole* gap, and pairs further apart than ALLEY_MAX_SPAN are
  // rejected outright. The previous revision accepted any gap and clamped the
  // rect to 3 tiles instead, but the clamp always anchored to the lower-
  // coordinate building, so it left open ground before the other one — and since
  // BUILDING_GAP is 2, the clamp could only ever fire when it produced that wrong
  // result. Measured: 67 of 285 alleys (24%) were not flanked by two commercial
  // buildings, worst separation 16 tiles.
  let best: { gap: number; seed: LocationSeed } | null = null;
  const consider = (gap: number, seed: LocationSeed) => {
    if (gap > ALLEY_MAX_SPAN) return;
    const p = seed.position;
    if (!rectClear(p.x / TILE, p.y / TILE, p.width / TILE, p.height / TILE)) return;
    if (!best || gap < best.gap) best = { gap, seed };
  };

  for (let i = 0; i < commercial.length; i++) {
    for (let j = i + 1; j < commercial.length; j++) {
      const a = commercial[i];
      const b = commercial[j];
      const gapX = Math.max(0, Math.max(b.tileX - (a.tileX + a.w), a.tileX - (b.tileX + b.w)));
      const gapY = Math.max(0, Math.max(b.tileY - (a.tileY + a.h), a.tileY - (b.tileY + b.h)));

      // Side by side: the buildings' row ranges overlap, separated horizontally.
      if (gapX > 0 && gapY === 0) {
        const alleyX = Math.min(a.tileX + a.w, b.tileX + b.w);
        const alleyY = Math.max(a.tileY, b.tileY);
        const alleyH = Math.min(a.tileY + a.h, b.tileY + b.h) - alleyY;
        const alleyW = gapX;
        if (alleyH >= 2) {
          consider(gapX, {
            name: 'Back Alley',
            type: 'alley',
            position: {
              x: alleyX * TILE,
              y: alleyY * TILE,
              width: alleyW * TILE,
              height: alleyH * TILE,
            },
            // Midpoint of the alley itself. `alleyY + alleyH` is one row past the
            // alley, inside the neighbouring building's footprint — and
            // pathfinding silently falls back to a straight line when the goal
            // tile is blocked, so agents walked through the wall.
            entry_point: {
              x: (alleyX + Math.floor(alleyW / 2)) * TILE,
              y: (alleyY + Math.floor(alleyH / 2)) * TILE,
            },
            capacity: 4,
            current_occupants: [],
            operating_hours: null,
            services: [],
            description:
              'A narrow alley between two commercial buildings, dimly lit and discreet.',
            owner: null,
          });
        }
      }
      // Stacked: column ranges overlap, separated vertically.
      if (gapY > 0 && gapX === 0) {
        const alleyX = Math.max(a.tileX, b.tileX);
        const top = Math.min(a.tileY + a.h, b.tileY + b.h);
        const alleyW = Math.min(a.tileX + a.w, b.tileX + b.w) - alleyX;
        if (alleyW >= 2) {
          // Two candidates. The first row of the gap *is* the upper building's
          // door row, so `rectClear` rejects the full-gap rect whenever the door
          // column falls inside — which is most of the time. The second candidate
          // gives that row back to the doorway and takes the rest; it still runs
          // between the same two buildings, just tighter against the lower one.
          for (const [alleyY, alleyH] of [[top, gapY], [top + 1, gapY - 1]]) {
            if (alleyH < 1) continue;
            consider(gapY, {
              name: 'Back Alley',
              type: 'alley',
              position: {
                x: alleyX * TILE,
                y: alleyY * TILE,
                width: alleyW * TILE,
                height: alleyH * TILE,
              },
              entry_point: {
                x: (alleyX + Math.floor(alleyW / 2)) * TILE,
                y: (alleyY + Math.floor(alleyH / 2)) * TILE,
              },
              capacity: 4,
              current_occupants: [],
              operating_hours: null,
              services: [],
              description:
                'A narrow alley between two commercial buildings, dimly lit and discreet.',
              owner: null,
            });
          }
        }
      }
    }
  }
  return best ? (best as { gap: number; seed: LocationSeed }).seed : null;
}

function deriveFarmyard(
  placedBuildings: Array<{ type: string; tileX: number; tileY: number; w: number; h: number }>,
  blocked: BlockedMask,
): LocationSeed | null {
  const farm = placedBuildings.find((b) => b.type === 'farm');
  if (!farm) return null;

  const minW = 3;
  const minH = 3;

  // Both old candidates were offset by +1 from the farm's edge, i.e. inside the
  // farm's own BUILDING_GAP=2 ring, so `fits` was false by construction and the
  // farmyard never generated in any world.
  for (const c of ringCandidates(farm, minW, minH)) {
    if (fits(c.x, c.y, minW, minH, blocked)) {
      return {
        name: 'Farmyard',
        type: 'farmyard',
        position: {
          x: c.x * TILE,
          y: c.y * TILE,
          width: minW * TILE,
          height: minH * TILE,
        },
        entry_point: {
          x: (c.x + Math.floor(minW / 2)) * TILE,
          y: (c.y + minH) * TILE,
        },
        capacity: 6,
        current_occupants: [],
        operating_hours: null,
        services: [],
        description:
          'An open yard beside the farm, where chickens scratch and tools lean against the fence.',
        owner: null,
      };
    }
  }
  return null;
}

// ─── Stage ────────────────────────────────────────────────────────────────────

export const layoutStage: Stage<{
  publicBuildings: LocationSeed[];
  warnings: string[];
}> = {
  name: 'layout',
  dependsOn: ['dimensions', 'roads'],
  run(ctx, rng, cfg, agentCount) {
    if (!ctx.dimensions) throw new Error('layout: dimensions not populated');
    if (!ctx.roads) throw new Error('layout: roads not populated');

    const { width, height } = ctx.dimensions;
    const { tiles: roadTiles, zones } = ctx.roads;
    // Everything organic-only below is gated on this, so grid towns stay
    // byte-identical (pinned by the goldens in organic.test.ts).
    const organic = cfg.layoutStyle === 'organic';

    // 1. Select templates
    const templates = getTemplatesForAgentCount(agentCount);

    // 2. Build blocked mask
    const blocked = buildBlockedMask(width, height, roadTiles);
    const roadDist = buildRoadDistance(width, height, roadTiles);

    // 3. Sort templates largest-first by footprint area.
    // The `type` tiebreak is load-bearing: 7 of 12 templates tie at area 20
    // (shop, clinic, bakery, workshop, prison, pawnshop, divebar). `Array.sort`
    // is stable, so without it their placement order is the declaration order in
    // buildingTemplates.ts — and reordering those arrays for readability would
    // silently change every town for every existing seed.
    const sorted = [...templates].sort(
      (a, b) => b.size.w * b.size.h - a.size.w * a.size.h || a.type.localeCompare(b.type),
    );

    // Track used area per zone for remaining-area scoring
    const usedAreaByZone = new Map<string, number>();

    // Normaliser for the centrality term. See `scoreZone`. Fallback zones are
    // left out defensively: the organic one is centred on the map centre, so it
    // never sets the max today, but a fallback shouldn't be able to rescale
    // every real zone's centrality if its shape ever changes.
    const maxZoneDist = zones.filter((z) => !z.fallback).reduce(
      (m, z) =>
        Math.max(
          m,
          Math.hypot(
            (z.bounds.x1 + z.bounds.x2) / 2 - width / 2,
            (z.bounds.y1 + z.bounds.y2) / 2 - height / 2,
          ),
        ),
      0,
    );

    // Track placed buildings for outdoor derivation
    const placedBuildings: Array<{
      type: string;
      tileX: number;
      tileY: number;
      w: number;
      h: number;
    }> = [];
    const locationSeeds: LocationSeed[] = [];

    // Each derived plot is marked before deriving the next, or two of them can
    // claim the same tiles. It also joins `placedBuildings` so later derivations
    // treat it as an obstacle — `blocked` alone is not enough, because
    // `deriveAlley` reasons about footprints rather than the mask (whose gap
    // rings would veto every legitimate alley).
    //
    // `usedAreaByZone` is deliberately not updated: derived plots are open
    // ground, and like the town square (see `chargedArea`) they should not make
    // a zone read as full. That includes the organic market square, the one
    // plot marked while templates are still being placed (below).
    const markSeed = (seed: LocationSeed) => {
      markPlaced(
        seed.position.x / TILE,
        seed.position.y / TILE,
        seed.position.width / TILE,
        seed.position.height / TILE,
        blocked,
      );
      placedBuildings.push({
        type: seed.type,
        tileX: seed.position.x / TILE,
        tileY: seed.position.y / TILE,
        w: seed.position.width / TILE,
        h: seed.position.height / TILE,
      });
    };

    /**
     * Organic towns claim the Market Square as soon as the town square is down,
     * instead of after every template like the grid.
     *
     * Building along the lanes packs the venues around the town square's lane
     * too, and they used to take the ground the market needed: the market
     * generated in 82.5% of 13-agent organic towns once venues fronted the lanes
     * (90% before, grid 99.5%). The grid never needed this — its town square
     * sits in a block of its own with streets on every side. Only the *timing*
     * changes: it is the same `deriveMarketSquare` search and it still lands in
     * the output after Main Street.
     */
    let reservedMarket: LocationSeed | null = null;

    // 4. Place each template
    for (const template of sorted) {
      const { w, h } = template.size;

      // a. Score each zone, with per-seed jitter.
      // `scoreZone` is a pure function of (template, zone, used area), and the
      // shuffle below only reorders *exact* ties — which essentially never
      // happen. So every seed ranked the zones identically and every venue landed
      // in the same ninth of the map in all 40 sampled seeds; only the slot
      // within that zone varied. The jitter lets near-equal zones trade places;
      // see ZONE_SCORE_JITTER for how wide a lead it can and cannot overturn.
      const scoredZones = zones.map((z) => ({
        zone: z,
        score:
          scoreZone(template, z, usedAreaByZone, width, height, maxZoneDist) *
          (1 - ZONE_SCORE_JITTER + 2 * ZONE_SCORE_JITTER * rng.next()),
      }));

      // b. Shuffle, then sort by score desc.
      // The shuffle is near-dead now that ZONE_SCORE_JITTER makes every score a
      // distinct float — 0 exact ties in 4000 sampled adjacent pairs — and only
      // matters when `remainingFraction` drives several zones to exactly 0. It is
      // kept because removing it would change the RNG draw count and reshuffle
      // every existing seed, not because it breaks ties in practice.
      const ranked = rng.shuffle(scoredZones);
      ranked.sort((a, b) => b.score - a.score);
      // Fallback zones go strictly last. Sorting alone did not guarantee it: a
      // real zone whose `remainingFraction` hit 0 scores exactly 0 too, and the
      // shuffle could put the fallback ahead of it. Partitioning keeps the
      // relative order within each group, and with no fallback zone (the grid)
      // this is the identity — no RNG draw moves either way.
      const tryOrder = [
        ...ranked.filter((z) => !z.zone.fallback),
        ...ranked.filter((z) => z.zone.fallback),
      ];

      // Primary slot key: how close the building's doorway lands to a road.
      //
      // Nothing used to pull buildings toward the street network — zones are
      // defined *between* the roads and a slot in the middle of a block scored
      // exactly like one on its edge. Measured share of buildings whose door was
      // within 2 tiles of a road: 50.1% at 13 agents, 38.0% at 20, 25.3% at 30,
      // i.e. the bigger the town the more of it was back-lot. Doors more than 6
      // tiles from any road: 24.3% / 29.2% / 44.4%.
      //
      // This is an ordering preference, not a filter — `fits` still falls back to
      // the interior of the block when the frontage is taken, so no template
      // becomes unplaceable because of it.
      const doorDist = (x: number, y: number, bw: number, bh: number) => {
        const dx = x + Math.floor(bw / 2), dy = y + bh;
        if (dx < 0 || dy < 0 || dx >= width || dy >= height) return Infinity;
        return roadDist[dy * width + dx];
      };
      const frontage = (s: { x: number; y: number }) => doorDist(s.x, s.y, w, h);

      type Pick = { zone: Zone; slot: { x: number; y: number } };

      // Rows of shops — organic towns, commercial templates only.
      //
      // The grid gets its Back Alley for free: every commercial venue fronts
      // the same straight main street, so two of them nearly always end up
      // shoulder to shoulder (alley in 95% of 13-agent towns). Organic lanes
      // scatter them over several streets and the alley came out in 63%.
      //
      // So a shop first looks for a lot in a row with one already placed (see
      // `rowLot`), and where it cannot join a row it prefers a street-front lot
      // that leaves room beside it for the next one (`rowKey`). Measured at 13
      // agents: the row lot alone lifts the alley to 86.5%, the room-leaving
      // preference to ~92%.
      const wantsRow = organic && COMMERCIAL_TYPES.has(template.type);
      /** 0 for a street-front lot with room for a neighbour shop beside it, 1
       *  otherwise. Always 0 on the grid and for every other template, so it
       *  orders nothing there. */
      const rowKey = (s: { x: number; y: number }): number => {
        if (!wantsRow || frontage(s) > ROW_FRONT_DOOR) return wantsRow ? 1 : 0;
        // The neighbour lot, bottom-aligned so the two doors share the lane,
        // just outside the BUILDING_GAP ring this lot will reserve.
        const sy = s.y + h - ROW_NEIGHBOUR.h;
        for (const sx of [s.x - BUILDING_GAP - ROW_NEIGHBOUR.w, s.x + w + BUILDING_GAP]) {
          if (
            fits(sx, sy, ROW_NEIGHBOUR.w, ROW_NEIGHBOUR.h, blocked) &&
            doorDist(sx, sy, ROW_NEIGHBOUR.w, ROW_NEIGHBOUR.h) <= ROW_FRONT_DOOR
          ) return 0;
        }
        return 1;
      };
      /**
       * The best lot in a row with a commercial building already placed: side
       * by side, sharing at least two rows, at a gap `deriveAlley` can turn into
       * an alley, door within ROW_FRONT_DOOR of a road. Enumerated directly —
       * a few dozen lots beside each shop — rather than by scanning every zone's
       * slots, which made the layout stage ~6× slower.
       *
       * Any real zone qualifies, not just the ones scoring near the leader: a
       * shop beside a shop is in the commercial quarter by definition. Among
       * the candidates the best-ranked zone wins, then the narrower gap (a
       * tighter alley), then frontage; position breaks ties. Draws no rng.
       */
      const rowLot = (order: ReadonlyArray<{ zone: Zone }>): Pick | null => {
        const rank = new Map(order.map((z, i) => [z.zone, i]));
        let best: { pick: Pick; key: number[] } | null = null;
        for (const b of placedBuildings) {
          if (!COMMERCIAL_TYPES.has(b.type)) continue;
          for (let gap = BUILDING_GAP; gap <= ALLEY_MAX_SPAN; gap++) {
            for (const x of [b.tileX - gap - w, b.tileX + b.w + gap]) {
              for (let y = b.tileY - h + 2; y <= b.tileY + b.h - 2; y++) {
                const f = frontage({ x, y });
                if (f > ROW_FRONT_DOOR || !fits(x, y, w, h, blocked)) continue;
                const cx = x + Math.floor(w / 2), cy = y + Math.floor(h / 2);
                const zone = zones.find((z) => !z.fallback &&
                  cx >= z.bounds.x1 && cx <= z.bounds.x2 && cy >= z.bounds.y1 && cy <= z.bounds.y2);
                if (!zone) continue;
                const key = [rank.get(zone)!, gap, f, y, x];
                if (!best || lexLess(key, best.key)) best = { pick: { zone, slot: { x, y } }, key };
              }
            }
          }
        }
        return best?.pick ?? null;
      };

      // c. The first fitting slot of a zone, in (row room) → frontage → centrality
      // order. Consumes one `rng.shuffle` per zone that has any slot at all, so
      // the grid, which asks zone after zone until one fits, draws exactly what
      // it always drew.
      const firstFitIn = (zone: Zone): { x: number; y: number } | null => {
        const slots = organic ? generateCentredSlots(zone, w, h) : generateSlots(zone, w, h);
        if (slots.length === 0) return null;

        // `centrality` only steered which *zone* won; the slot inside it was
        // uniform, so a central-by-design venue that lost the middle zone landed
        // anywhere in its fallback — town hall averaged the furthest-from-centre
        // of any venue. Bucket slots by distance to the map centre and keep the
        // shuffle within each bucket: high centrality → narrow buckets → close to
        // strictly nearest-first; centrality 0 → one bucket → the old pure shuffle.
        const shuffledSlots = rng.shuffle(slots);
        const centrality = template.centrality ?? 0;

        // Secondary key: distance to the map centre, for venues everyone walks to.
        // `centrality` only steered which *zone* won; the slot inside it was
        // uniform, so a central-by-design venue that lost the middle zone landed
        // anywhere in its fallback — town hall averaged the furthest-from-centre
        // of any venue. High centrality → narrow buckets → close to strictly
        // nearest-first; centrality 0 → one bucket → no reordering.
        const bucketSize = 1 + 8 * (1 - centrality);
        const dist = (s: { x: number; y: number }) =>
          Math.hypot(s.x + w / 2 - width / 2, s.y + h / 2 - height / 2);
        // Buckets are measured from the *nearest* slot, not from the origin.
        // `Math.round(d / bucketSize)` put the bin edges at fixed multiples of
        // bucketSize measured from the map centre, so whether the nearest slot
        // landed mid-bin or on an edge was arbitrary and a *wider* bucket could
        // give a *smaller* pool (park: bucketSize 1→6 slots, 2→4, 3→13, 4→21,
        // 5→20, 6→4). Anchoring at minD makes the pool monotone in bucketSize
        // and makes the paragraph above actually true.
        const minD = centrality > 0 ? Math.min(...shuffledSlots.map(dist)) : 0;

        // The first fitting slot in (t, f, k, shuffled index) order, found in
        // one pass instead of by sorting every slot and walking the sorted list:
        // the same slot, since the shuffled index breaks every tie exactly as
        // the stable sort did. The sort allocated and ordered every slot of
        // every zone asked — hundreds per zone, and the organic zone choice asks
        // several — only to use the first one that fits. `fits` runs only on a
        // slot that would beat the best found so far.
        let best: { x: number; y: number } | null = null;
        let bt = 0, bf = 0, bk = 0;
        for (const s of shuffledSlots) {
          const t = rowKey(s);
          const f = Math.floor(Math.min(frontage(s), ROAD_FRONTAGE_CAP) / ROAD_FRONTAGE_BUCKET);
          const k = centrality > 0 ? Math.floor((dist(s) - minD) / bucketSize) : 0;
          if (best && (t > bt || (t === bt && (f > bf || (f === bf && k >= bk))))) continue;
          if (!fits(s.x, s.y, w, h, blocked)) continue;
          best = s; bt = t; bf = f; bk = k;
        }
        return best;
      };

      // d. Choose the zone. The grid takes the best-scoring zone with room.
      //
      // Organic towns build along their lanes. The grid's zones are blocks
      // bounded by roads on all four sides, so the best zone always has a
      // street-front lot unless it is full; an organic cell may have no lane
      // anywhere near its free ground, and the grid rule then put the venue at
      // the back of it — the park's and workshop's doors ended up more than 6
      // tiles from any road in 24.5% of 13-agent towns (grid: 1.5% and 0%).
      // So every zone scoring within LANE_FRONT_SCORE_RATIO of the leader is
      // asked for a lot on a lane (door ≤ LANE_FRONT_DOOR tiles out) before
      // settling for the leader's back lot. Zoning still decides among the
      // lane-front lots, and the ratio keeps a venue out of a zone its
      // affinities clearly reject just because a lane runs through it.
      let pick: Pick | null = null;
      if (!organic) {
        for (const { zone } of tryOrder) {
          const slot = firstFitIn(zone);
          if (slot) { pick = { zone, slot }; break; }
        }
      } else {
        pick = wantsRow ? rowLot(tryOrder) : null;
        const bar = (tryOrder[0]?.score ?? 0) * LANE_FRONT_SCORE_RATIO;
        let backLot: Pick | null = null;
        for (const { zone, score } of pick ? [] : tryOrder) {
          if (backLot && (zone.fallback || score < bar)) break;
          const slot = firstFitIn(zone);
          if (!slot) continue;
          if (frontage(slot) <= LANE_FRONT_DOOR) { pick = { zone, slot }; break; }
          backLot ??= { zone, slot };
        }
        pick ??= backLot;
      }

      if (pick) {
        const { zone, slot } = pick;
        markPlaced(slot.x, slot.y, w, h, blocked);

        // Update used area. See `scoreZone` for what this is charged
        // against; `chargedArea` explains the two adjustments.
        const prev = usedAreaByZone.get(zone.id) ?? 0;
        usedAreaByZone.set(zone.id, prev + chargedArea(template));

        locationSeeds.push(templateToLocationSeed(template, slot.x, slot.y));
        placedBuildings.push({ type: template.type, tileX: slot.x, tileY: slot.y, w, h });

        if (organic && template.type === 'town_square') {
          reservedMarket = deriveMarketSquare(placedBuildings, blocked);
          if (reservedMarket) markSeed(reservedMarket);
        }
      } else {
        throw new FitError(
          'layout',
          `cannot place ${template.name} (${w}×${h}) — no space in any zone`,
        );
      }
    }

    // 5. Derive outdoor locations
    const mainstreet = deriveMainstreet(roadTiles, ctx.roads.mainStreet);
    if (mainstreet) locationSeeds.push(mainstreet);

    // Derived plots are best-effort, and a failure used to be a `console.warn` on
    // server stdout and nothing else — `GenResult` had nowhere to put it. The
    // wizard drew the gap as a 2px dashed outline at 40% alpha on a 320px canvas,
    // so in practice nobody could see it. These are cosmetic plots — no services,
    // no interior, no system reads their type — so this is a reroll prompt, not
    // an error.
    //
    // Miss rates, re-measured over 200 seeds per agent count (the previous
    // figures here — 32.5% alley, 1.9% farmyard, 34.2% any — predate the
    // ALLEY_MAX_SPAN and ringCandidates fixes and were wrong by 6× in the alley's
    // case, in both directions):
    //
    //   agents   alley   farmyard   market_square   any
    //   13        5.0%      9.5%            0.0%   13.5%
    //   20        4.0%      7.0%            0.5%   11.0%
    //   30        4.0%      0.5%            0.0%    4.5%
    //
    // The farmyard is the one that gets *easier* as the town grows: the map grows
    // faster than the farm's neighbours do, so FARMYARD_SEARCH_RADIUS finds open
    // ground more often.
    const warnings: string[] = [];

    const marketSquare = reservedMarket ?? deriveMarketSquare(placedBuildings, blocked);
    if (marketSquare) {
      locationSeeds.push(marketSquare);
      if (!reservedMarket) markSeed(marketSquare);
    } else {
      warnings.push('No room for a market square beside the town center.');
    }

    const alley = deriveAlley(placedBuildings, roadTiles);
    if (alley) {
      locationSeeds.push(alley);
      markSeed(alley);
    } else {
      warnings.push('No two commercial buildings ended up close enough to form a back alley.');
    }

    const farmyard = deriveFarmyard(placedBuildings, blocked);
    if (farmyard) {
      locationSeeds.push(farmyard);
      markSeed(farmyard);
    } else {
      warnings.push('No room for a farmyard beside the farm.');
    }

    return { publicBuildings: locationSeeds, warnings };
  },
};
