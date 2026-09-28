import type { Stage, RoadsOutput, Zone } from '../types';
import { ROAD_BUFFER, BORDER_BUFFER } from '../config';

export interface RoadPositions {
  mainStreetY: number;
  crossPathY: number;
  vertWestX: number;
  vertEastX: number;
}

/**
 * Two horizontal roads and two vertical ones, at fixed fractions of the map.
 *
 * The count is deliberately fixed, because it is what defines the 3×3 zone grid
 * every other stage scores against. That used to mean block interiors deepened
 * without bound as the map grew — the widest block went 18×12 at 56×43 to 29×18
 * at 84×59, putting its centre 20 tiles from any pavement. That is fixed in
 * `dimensions`, by not growing the map past what the content needs: the furthest
 * any tile now sits from a road is 15 tiles at 5 agents and 16 at 32, i.e. flat.
 *
 * Adding a road to split an oversized block is the obvious alternative and is a
 * trap at this scale: at the 56×43 minimum the widest column is 16 tiles, and a
 * 2-wide road plus ROAD_BUFFER either side would leave two 6-tile halves — too
 * narrow for the farm (10×7) or the town square (9×8), which would then have
 * nowhere to go.
 *
 * The fractions produce nine near-equal zones and are chosen for that, not for
 * looks. After subtracting the roads, their buffers and the border frame a
 * column spans `fW - 3`, `(g - f)W - 4` and `(1 - g)W - 5` tiles, so evenly
 * spaced fractions do *not* give evenly sized zones. At the old 0.27/0.60 and
 * 0.33/0.70 the largest zone (`em`) was 2.0-2.3× the smallest (`nw`) at every
 * legal map size, and — because `farm` (10×7), `park` (8×6) and `town_hall`
 * (6×5) all peak on the civic/residential affinities that live in the `n*` row,
 * which was also the *shortest* row — the three largest templates were competing
 * for the three smallest zones. The farm alone filled 73% of `nw` at 56×43. The
 * town split into an all-residential south and an institutional north with 10.7%
 * of homes in it. The ratio is now 1.18 across the same size range.
 *
 * `mainStreetY` is deliberately left at 0.33: it is the town's front street and
 * moving it is a visual change, and solving for the other three gets the ratio
 * to within 0.006 of the unconstrained optimum anyway.
 */
export function computeRoadPositions(width: number, height: number): RoadPositions {
  return {
    mainStreetY: Math.floor(height * 0.33),
    crossPathY: Math.floor(height * 0.66),
    vertWestX: Math.floor(width * 0.32),
    vertEastX: Math.floor(width * 0.65),
  };
}

export function deriveZones(r: RoadPositions, width: number, height: number): Zone[] {
  // Zones are the *buildable* rectangles between the roads, so they must exclude
  // the road's own 2 tiles, ROAD_BUFFER either side, and the border frame.
  // They previously stopped one tile short of that on every side, so each zone
  // advertised a ring of tiles no building could ever occupy — which distorted
  // the remaining-area score and truncated slot enumeration.
  const cols = [
    { x1: BORDER_BUFFER, x2: r.vertWestX - 1 - ROAD_BUFFER },
    { x1: r.vertWestX + 2 + ROAD_BUFFER, x2: r.vertEastX - 1 - ROAD_BUFFER },
    { x1: r.vertEastX + 2 + ROAD_BUFFER, x2: width - 1 - BORDER_BUFFER },
  ];
  const rows = [
    { y1: BORDER_BUFFER, y2: r.mainStreetY - 1 - ROAD_BUFFER },
    { y1: r.mainStreetY + 2 + ROAD_BUFFER, y2: r.crossPathY - 1 - ROAD_BUFFER },
    { y1: r.crossPathY + 2 + ROAD_BUFFER, y2: height - 1 - BORDER_BUFFER },
  ];

  const ZONE_IDS = [
    ['sw', 'sc', 'se'],   // row 0 (smallest y)
    ['wm', 'cm', 'em'],   // row 1
    ['nw', 'nc', 'ne'],   // row 2 (largest y)
  ];

  // Zone character weights. Hand-tuned here — the "spec §4.3" citation this
  // comment used to carry pointed at the pipeline-orchestration section, which
  // contains no affinity table. This is the source of truth.
  const AFFINITIES: Record<string, Record<string, number>> = {
    sw: { residential: 5, commercial: 2, mainStreet: 1, civic: 0 },
    sc: { residential: 4, commercial: 3, mainStreet: 2, civic: 0 },
    se: { commercial: 4, mainStreet: 4, residential: 2, civic: 0 },
    wm: { residential: 4, commercial: 3, mainStreet: 2, civic: 0 },
    cm: { commercial: 4, civic: 3, mainStreet: 3, residential: 0 },
    em: { commercial: 5, mainStreet: 3, residential: 1, civic: 0 },
    nw: { civic: 4, residential: 3, commercial: 1, mainStreet: 0 },
    nc: { civic: 5, commercial: 2, residential: 1, mainStreet: 0 },
    ne: { civic: 3, residential: 4, commercial: 1, mainStreet: 0 },
  };

  const zones: Zone[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const id = ZONE_IDS[row][col];
      const bounds = { x1: cols[col].x1, y1: rows[row].y1, x2: cols[col].x2, y2: rows[row].y2 };
      // Skip degenerate zones (can happen on very small maps). Bounds are
      // INCLUSIVE, so a 1-tile-wide zone is x2 === x1 and is legitimate; only
      // x2 < x1 is actually empty. The old `<=` silently dropped 1-wide zones,
      // which never fires at the current MIN size but did not mean what it said.
      if (bounds.x2 < bounds.x1 || bounds.y2 < bounds.y1) continue;
      zones.push({
        id,
        bounds,
        // Copied, not aliased: `AFFINITIES` is a module-level table, so handing
        // the row out by reference shared one object across every world
        // generated in the process.
        affinity: { ...AFFINITIES[id] },
      });
    }
  }
  return zones;
}

/**
 * Manhattan distance from every tile to the nearest road tile, by multi-source
 * BFS. Obstacles are deliberately ignored: this measures how close a doorway is
 * to the street network, not how far an agent would have to walk around a
 * building to reach it.
 *
 * Lives here rather than in a stage because both `layout` and `homes` order their
 * candidate positions by it, and two copies would be free to drift.
 *
 * Tiles unreachable from any road (only possible when `roadTiles` is empty) keep
 * the initial sentinel, which sorts last.
 */
export function buildRoadDistance(
  width: number,
  height: number,
  roadTiles: Array<{ x: number; y: number }>,
): Int32Array {
  const dist = new Int32Array(width * height).fill(0x7fffffff);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  for (const t of roadTiles) {
    if (t.x < 0 || t.y < 0 || t.x >= width || t.y >= height) continue;
    const i = t.y * width + t.x;
    if (dist[i] === 0) continue;
    dist[i] = 0;
    queue[tail++] = i;
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width, y = (i - x) / width;
    const d = dist[i] + 1;
    if (x > 0 && dist[i - 1] > d) { dist[i - 1] = d; queue[tail++] = i - 1; }
    if (x < width - 1 && dist[i + 1] > d) { dist[i + 1] = d; queue[tail++] = i + 1; }
    if (y > 0 && dist[i - width] > d) { dist[i - width] = d; queue[tail++] = i - width; }
    if (y < height - 1 && dist[i + width] > d) { dist[i + width] = d; queue[tail++] = i + width; }
  }
  return dist;
}

function generateRoadTiles(r: RoadPositions, width: number, height: number): Array<{ x: number; y: number }> {
  const tiles: Array<{ x: number; y: number }> = [];
  // Horizontal: main street (2 tiles wide)
  for (let x = 1; x < width - 1; x++) {
    tiles.push({ x, y: r.mainStreetY });
    tiles.push({ x, y: r.mainStreetY + 1 });
  }
  // Horizontal: cross path (2 tiles wide)
  for (let x = 1; x < width - 1; x++) {
    tiles.push({ x, y: r.crossPathY });
    tiles.push({ x, y: r.crossPathY + 1 });
  }
  // Vertical: west path (2 tiles wide)
  for (let y = 1; y < height - 1; y++) {
    tiles.push({ x: r.vertWestX, y });
    tiles.push({ x: r.vertWestX + 1, y });
  }
  // Vertical: east path (2 tiles wide)
  for (let y = 1; y < height - 1; y++) {
    tiles.push({ x: r.vertEastX, y });
    tiles.push({ x: r.vertEastX + 1, y });
  }
  return tiles;
}

export const roadsStage: Stage<{ roads: RoadsOutput }> = {
  name: 'roads',
  dependsOn: ['dimensions'],
  run(ctx) {
    if (!ctx.dimensions) throw new Error('roads: dimensions not populated');
    const { width, height } = ctx.dimensions;
    const positions = computeRoadPositions(width, height);
    return {
      roads: {
        tiles: generateRoadTiles(positions, width, height),
        zones: deriveZones(positions, width, height),
      },
    };
  },
};
