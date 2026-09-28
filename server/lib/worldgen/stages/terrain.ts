import type { LocationSeed, Stage, TerrainTile, TerrainKind } from '../types';
import { TILE } from '../config';
import { makeValueNoise2D, fbm, poissonDisk, type FbmOptions, type Noise2D } from '../noise';

/**
 * Ground decoration: meadows of flowers and grass tufts, worn dirt with the odd
 * rock, and groves of trees fringed by bushes. Purely cosmetic — no gameplay
 * impact. The renderer draws default grass for any tile without an entry here.
 *
 * This replaced a per-tile uniform roll (3% flowers, 5% tall grass, 5% dirt)
 * that read as salt sprinkled over the map: nothing clustered, so the eye found
 * no meadows, no worn ground, no woods. Now every kind is placed from a smooth
 * noise field, so it comes in patches, and trees are Poisson-spaced so a grove
 * reads as a grove instead of a wall or a scatter.
 *
 * Border tiles, road tiles, building footprints and doors are skipped — this
 * stage used to run before roads and layout existed, so it had no way to know
 * about them and drew flowers down the middle of Main Street.
 *
 * Kinds emitted: flowers, grass_tuft, dirt_patch, tree, bush, rock. The old
 * `tall_grass` kind is no longer emitted; the renderer still draws it for
 * worlds saved before this change.
 */

/**
 * Share of eligible tiles each layer targets, before the per-world jitter.
 * Chosen so the total lands mid-band of the 10-22% the tests pin, which leaves
 * room for the ±20% jitter. Measured over 30 seeds with real roads, layout and
 * homes: mean 18.0% (16.5-20.1%) at 60×45, 17.3% (15.8-19.6%) at 80×60.
 *
 * Every layer is placed by *rank* (the top-N tiles of its noise field) rather
 * than by a fixed noise threshold. Value noise's histogram bunches around 0.5
 * and its spread varies from seed to seed and with the map's size, so a fixed
 * threshold would swing the coverage per world; ranking makes the share exact
 * and guarantees every kind appears in every world, while the *shape* of what
 * is picked is still the noise's patches.
 */
const SHARE = {
  /** Area handed to the tree sampler. Trees fill it at Poisson spacing (about
   *  one per 6-7 tiles once small-island edge effects are counted), which
   *  measured ~2% trees. */
  treeRegion: 0.13,
  /** Grove fringe handed to the bush sampler. The band is thin and ragged, so
   *  the r=1.5 sampler fills most of it: measured ~2-2.5% bushes. */
  bushBand: 0.035,
  dirt: 0.035,
  rock: 0.005,
  flowers: 0.04,
  grassTuft: 0.055,
} as const;

/** Per-world multiplier range on every share, so towns are not all equally
 *  lush. ±20% keeps the total inside the tested band. */
const JITTER_MIN = 0.8;
const JITTER_SPAN = 0.4;

/** Poisson radius for trees, in tiles. A tree sprite's canopy is roughly two
 *  tiles across; at 2.7 neighbouring canopies nearly touch, which reads as
 *  woodland, without overlapping into a single green mass. */
export const TREE_RADIUS = 2.7;
/** Poisson radius for bushes: just over √2, so no two bushes touch even
 *  diagonally but a fringe can still be dense. */
const BUSH_RADIUS = 1.5;
/** Minimum Chebyshev distance from a tree to any road, footprint or door tile.
 *  Canopies are drawn larger than a tile and above the ground layer, so a tree
 *  on a verge would overhang the road and one beside a door would hide it. */
export const TREE_CLEARANCE = 2;

/** Groves are pulled toward the map edge: the town sits in a clearing, with
 *  woods thickening outward. The pull is added to the grove field and fades
 *  linearly to zero this many tiles in from the border ring. */
const BORDER_FALLOFF = 8;
const BORDER_PULL = 0.25;

/** Extra wear on tiles near a road, fading to zero at `ROAD_WEAR_RANGE` tiles.
 *  Small on purpose — enough that dirt favours verges and doorsteps, not so
 *  much that every road gets a ruler-straight dirt stripe. */
const ROAD_WEAR = 0.03;
const ROAD_WEAR_RANGE = 3;

/** Share of rocks that sit next to dirt; the rest are loose in the grass. */
const ROCK_ON_DIRT = 0.8;

/**
 * Field shapes. Scales are feature sizes in tiles: groves are the broadest,
 * worn patches the smallest. The fine `bloom` field only perturbs which part of
 * a meadow flowers, so flower patches have ragged edges instead of being the
 * clean top of the meadow blob.
 */
const GROVE_FBM: FbmOptions = { octaves: 3, lacunarity: 2, gain: 0.5, scale: 10 };
const MEADOW_FBM: FbmOptions = { octaves: 3, lacunarity: 2, gain: 0.5, scale: 7 };
const WEAR_FBM: FbmOptions = { octaves: 3, lacunarity: 2, gain: 0.5, scale: 5 };
const BLOOM_FBM: FbmOptions = { octaves: 2, lacunarity: 2, gain: 0.5, scale: 2.5 };
const BLOOM_WEIGHT = 0.25;
/**
 * Per-tile white noise added to the meadow and wear fields before ranking.
 * Without it the top-N of a smooth field is a set of solid, perfectly convex
 * blobs (measured: ~90% of flower tiles had a flower 4-neighbour), which reads
 * as a stamped shape. A little dither frays the edges and lets a few strays
 * fall just outside a patch, the way real meadows thin out.
 */
const DITHER = 0.06;

const KIND_CODES: readonly TerrainKind[] = [
  'tree', 'bush', 'dirt_patch', 'rock', 'flowers', 'grass_tuft',
];

export const terrainStage: Stage<{ terrainTiles: TerrainTile[] }> = {
  name: 'terrain',
  dependsOn: ['dimensions', 'roads', 'publicBuildings', 'homes'],
  run(ctx, rng) {
    if (!ctx.dimensions) throw new Error('terrain: dimensions not populated');
    if (!ctx.roads) throw new Error('terrain: roads not populated');
    const { width, height } = ctx.dimensions;

    const occupied = new Uint8Array(width * height);
    const road = new Uint8Array(width * height);
    for (const t of ctx.roads.tiles) {
      if (t.x < 0 || t.y < 0 || t.x >= width || t.y >= height) continue;
      occupied[t.y * width + t.x] = 1;
      road[t.y * width + t.x] = 1;
    }

    const footprints: LocationSeed[] = [
      ...(ctx.publicBuildings ?? []),
      ...(ctx.homes ?? []),
    ];
    for (const loc of footprints) {
      // Main Street's "footprint" is the road itself, already covered above.
      if (loc.type === 'mainstreet') continue;
      // Note this reserves *every* other footprint, including the open-ground
      // ones — park, farm, town_square, market_square, alley, farmyard. Measured:
      // 0 decorations across 91,200 such tiles over 480 worlds, i.e. the park
      // never gets a flower from this stage. That is deliberate:
      // `TilemapRenderer.setOpenAreas` paints those areas from their own zone
      // textures, and a scatter decoration on top would fight it.
      const tx = Math.floor(loc.position.x / TILE);
      const ty = Math.floor(loc.position.y / TILE);
      const tw = Math.ceil(loc.position.width / TILE);
      const th = Math.ceil(loc.position.height / TILE);
      for (let y = ty; y < ty + th; y++) {
        if (y < 0 || y >= height) continue;
        for (let x = tx; x < tx + tw; x++) {
          if (x < 0 || x >= width) continue;
          occupied[y * width + x] = 1;
        }
      }
      // The door sits one row *below* the footprint (entry_point.y = y + height),
      // so the loop above never covered it and ~3 decorations per world were
      // drawn under a doorway.
      const ex = Math.floor(loc.entry_point.x / TILE);
      const ey = Math.floor(loc.entry_point.y / TILE);
      if (ex >= 0 && ex < width && ey >= 0 && ey < height) {
        occupied[ey * width + ex] = 1;
      }
    }

    // `blocked` = may never be decorated: occupied, plus the border ring, which
    // the renderer frames and which used to be skipped by the scatter loop's
    // bounds. Kept separate from `occupied` because tree clearance is measured
    // from buildings and roads only — the border is where trees *should* crowd.
    const blocked = occupied.slice();
    for (let x = 0; x < width; x++) {
      blocked[x] = 1;
      blocked[(height - 1) * width + x] = 1;
    }
    for (let y = 0; y < height; y++) {
      blocked[y * width] = 1;
      blocked[y * width + width - 1] = 1;
    }
    const eligible: number[] = [];
    for (let i = 0; i < width * height; i++) if (!blocked[i]) eligible.push(i);
    if (eligible.length === 0) return { terrainTiles: [] };

    // Independent fields, created in a fixed order from the stage RNG so the
    // whole stage stays a pure function of the seed. Each makeValueNoise2D call
    // consumes a fixed number of draws, so the fields do not shift when the
    // map size changes.
    const groveNoise = makeValueNoise2D(rng);
    const meadowNoise = makeValueNoise2D(rng);
    const wearNoise = makeValueNoise2D(rng);
    const bloomNoise = makeValueNoise2D(rng);
    const jitter = (): number => JITTER_MIN + JITTER_SPAN * rng.next();
    const target = (share: number): number =>
      Math.max(1, Math.round(share * jitter() * eligible.length));
    // Drawn up front, in a fixed order, for the same reason.
    const nTreeRegion = target(SHARE.treeRegion);
    const nBushBand = target(SHARE.bushBand);
    const nDirt = target(SHARE.dirt);
    const nRock = target(SHARE.rock);
    const nFlowers = target(SHARE.flowers);
    const nTuft = target(SHARE.grassTuft);

    const field = (noise: Noise2D, opts: FbmOptions, dither = 0): Float64Array => {
      const out = new Float64Array(width * height);
      for (const i of eligible) {
        out[i] = fbm(noise, i % width, Math.floor(i / width), opts);
        if (dither > 0) out[i] += dither * rng.next();
      }
      return out;
    };

    // --- Groves: trees, then bushes on the fringe -------------------------
    const grove = field(groveNoise, GROVE_FBM);
    for (const i of eligible) {
      const x = i % width;
      const y = Math.floor(i / width);
      // Distance from the border ring (the first decoratable ring is 0).
      const d = Math.min(x, y, width - 1 - x, height - 1 - y) - 1;
      grove[i] += BORDER_PULL * Math.max(0, 1 - d / BORDER_FALLOFF);
    }

    // Kind code per tile: 0 = bare grass, else 1 + index into KIND_CODES.
    const kind = new Uint8Array(width * height);
    const setKind = (i: number, k: TerrainKind): void => {
      kind[i] = KIND_CODES.indexOf(k) + 1;
    };
    const free = (): number[] => eligible.filter((i) => kind[i] === 0);

    const nearOccupied = chebyshevDilate(occupied, width, height, TREE_CLEARANCE);
    const treeMask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) treeMask[i] = blocked[i] | nearOccupied[i];
    const treeRegion = new Uint8Array(width * height);
    // Lowest grove value that made it into the tree region; bushes live just
    // below it.
    let treeCut = Infinity;
    for (const i of topN(eligible.filter((i) => !treeMask[i]), grove, nTreeRegion)) {
      treeRegion[i] = 1;
      treeCut = Math.min(treeCut, grove[i]);
    }
    const trees = poissonDisk({
      width, height, radius: TREE_RADIUS, mask: treeMask, rng,
      accept: (x, y) => treeRegion[y * width + x] === 1,
    });
    for (const p of trees) setKind(p.y * width + p.x, 'tree');

    // Bushes take the next band of grove values *below* the tree cut, so they
    // ring the woods. Tiles above the cut that were refused to trees only for
    // clearance (the strips beside roads and buildings, and — with the border
    // pull — much of the edge ring) are left bare on purpose: when the band was
    // "top of whatever trees did not take" it swallowed exactly those strips,
    // and Poisson spacing turned them into ruler-straight `b.b.b.b` hedges
    // along every road. Tiles touching a trunk are excluded: the canopy covers
    // them.
    const nearTree = chebyshevDilate(kindMask(kind, 'tree'), width, height, 1);
    const bushBand = new Uint8Array(width * height);
    const bushCandidates = free().filter((i) => !treeRegion[i] && !nearTree[i] && grove[i] < treeCut);
    for (const i of topN(bushCandidates, grove, nBushBand)) {
      bushBand[i] = 1;
    }
    const bushes = poissonDisk({
      width, height, radius: BUSH_RADIUS, rng,
      accept: (x, y) => bushBand[y * width + x] === 1,
    });
    for (const p of bushes) setKind(p.y * width + p.x, 'bush');

    // --- Wear: dirt patches, then rocks mostly on their edges -------------
    const wear = field(wearNoise, WEAR_FBM, DITHER);
    const nearRoad = chebyshevDistance(road, width, height, ROAD_WEAR_RANGE);
    for (const i of eligible) {
      const d = nearRoad[i];
      if (d <= ROAD_WEAR_RANGE) wear[i] += ROAD_WEAR * (1 - (d - 1) / ROAD_WEAR_RANGE);
    }
    for (const i of topN(free(), wear, nDirt)) setKind(i, 'dirt_patch');

    const nearDirt = chebyshevDilate(kindMask(kind, 'dirt_patch'), width, height, 1);
    const rockPool = rng.shuffle(free().filter((i) => nearDirt[i]));
    const looseRocks = rng.shuffle(free().filter((i) => !nearDirt[i]));
    const nOnDirt = Math.min(rockPool.length, Math.round(nRock * ROCK_ON_DIRT));
    for (const i of rockPool.slice(0, nOnDirt)) setKind(i, 'rock');
    for (const i of looseRocks.slice(0, nRock - nOnDirt)) setKind(i, 'rock');

    // --- Meadows: flowers in the ragged core, grass tufts around them ------
    const meadow = field(meadowNoise, MEADOW_FBM, DITHER);
    const bloom = field(bloomNoise, BLOOM_FBM);
    const flowerScore = new Float64Array(width * height);
    for (const i of eligible) flowerScore[i] = (1 - BLOOM_WEIGHT) * meadow[i] + BLOOM_WEIGHT * bloom[i];
    for (const i of topN(free(), flowerScore, nFlowers)) setKind(i, 'flowers');
    for (const i of topN(free(), meadow, nTuft)) setKind(i, 'grass_tuft');

    // Row-major, like the old scatter, so output order is stable and diffable.
    const tiles: TerrainTile[] = [];
    for (const i of eligible) {
      if (kind[i] === 0) continue;
      tiles.push({ x: i % width, y: Math.floor(i / width), kind: KIND_CODES[kind[i] - 1] });
    }
    return { terrainTiles: tiles };
  },
};

/** The `n` indices with the highest `score`; ties broken by index so the
 *  result never depends on sort stability. */
function topN(candidates: number[], score: Float64Array, n: number): number[] {
  return candidates
    .slice()
    .sort((a, b) => score[b] - score[a] || a - b)
    .slice(0, Math.max(0, n));
}

function kindMask(kind: Uint8Array, k: TerrainKind): Uint8Array {
  const code = KIND_CODES.indexOf(k) + 1;
  const out = new Uint8Array(kind.length);
  for (let i = 0; i < kind.length; i++) if (kind[i] === code) out[i] = 1;
  return out;
}

/** Tiles within Chebyshev distance `r` of any set tile (including the tiles
 *  themselves). Separable: a horizontal then a vertical max-filter. */
function chebyshevDilate(src: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!src[y * width + x]) continue;
      for (let dx = Math.max(0, x - r); dx <= Math.min(width - 1, x + r); dx++) tmp[y * width + dx] = 1;
    }
  }
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!tmp[y * width + x]) continue;
      for (let dy = Math.max(0, y - r); dy <= Math.min(height - 1, y + r); dy++) out[dy * width + x] = 1;
    }
  }
  return out;
}

/** Chebyshev distance to the nearest set tile, capped at `cap + 1` (anything
 *  farther than `cap` reads as `cap + 1`). Built from successive dilations,
 *  which is plenty for the 3-tile range it is used at. */
function chebyshevDistance(src: Uint8Array, width: number, height: number, cap: number): Uint8Array {
  const out = new Uint8Array(src.length).fill(cap + 1);
  for (let i = 0; i < src.length; i++) if (src[i]) out[i] = 0;
  for (let r = 1; r <= cap; r++) {
    const ring = chebyshevDilate(src, width, height, r);
    for (let i = 0; i < src.length; i++) if (ring[i] && out[i] > r) out[i] = r;
  }
  return out;
}
