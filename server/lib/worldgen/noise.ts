/**
 * Seeded 2D noise and Poisson-disk sampling for world generation.
 *
 * Pure and deterministic: everything is driven by an `RNG` from `./rng`, never
 * `Math.random`, so the same seed always paints the same ground. The client
 * imports worldgen modules directly, so this file must stay free of Node/DB
 * imports.
 *
 * Value noise rather than Perlin/simplex: the terrain stage only thresholds
 * these fields into "patch here / no patch here" at a feature size of a few
 * tiles, where value noise's slightly blocky look is invisible, and it is the
 * smallest correct thing to write and test. The fields are thresholded by rank
 * (see `terrain.ts`), so value noise's bunched-toward-0.5 histogram does not
 * matter either.
 */
import type { RNG } from './rng';

/** A smooth scalar field over the plane, returning values in [0, 1). */
export type Noise2D = (x: number, y: number) => number;

/** Lattice period. Coordinates wrap every 256 units, far beyond any map (≤ 90
 *  tiles wide) even after the octave frequency multipliers. */
const PERIOD = 256;

/** Quintic smootherstep, 6t⁵ − 15t⁴ + 10t³. Its first *and* second derivatives
 *  vanish at the lattice points, so the field has no visible creases along
 *  integer grid lines — which matters because the terrain stage samples it
 *  exactly on the integer tile grid. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Build a 2D value-noise field from `rng`.
 *
 * Each lattice point gets a pseudo-random value through a permutation table
 * (built with `rng.shuffle`, so it is seeded), and points in between are
 * blended with a quintic fade. Consumes a fixed number of draws from `rng`
 * (one shuffle of 256, 256 values, an angle and an offset), so making several
 * fields from the same RNG in a fixed order is itself deterministic.
 *
 * The input plane is rotated by a seeded angle and shifted by a seeded offset
 * before it reaches the lattice. Value noise is not stationary: its variance
 * peaks *on* lattice points and drops to about a quarter mid-cell, so the
 * extremes of the field sit on the lattice. The terrain stage samples at integer
 * tiles and keeps only the extremes (top few percent), so with an axis-aligned
 * lattice at scale 5 every patch landed on columns x ≡ 0,1 (mod 5) — measured
 * 3-4× as many picks there as at x ≡ 2, which drew dirt as straight vertical
 * stripes down road verges. Rotating the lattice off the tile axes spreads the
 * lattice points over every row and column.
 */
export function makeValueNoise2D(rng: RNG): Noise2D {
  const base = rng.shuffle(Array.from({ length: PERIOD }, (_, i) => i));
  // Doubled so `perm[perm[x] + y]` never needs a second mask.
  const perm = new Uint8Array(PERIOD * 2);
  for (let i = 0; i < PERIOD * 2; i++) perm[i] = base[i % PERIOD];
  const values = new Float64Array(PERIOD);
  for (let i = 0; i < PERIOD; i++) values[i] = rng.next();

  const angle = rng.next() * Math.PI * 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const ox = rng.next() * PERIOD;
  const oy = rng.next() * PERIOD;

  const lattice = (ix: number, iy: number): number =>
    // `& 255` also maps negative coordinates correctly (two's complement).
    values[perm[perm[ix & (PERIOD - 1)] + (iy & (PERIOD - 1))]];

  return (px: number, py: number): number => {
    const x = px * cos - py * sin + ox;
    const y = px * sin + py * cos + oy;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const u = fade(x - x0);
    const v = fade(y - y0);
    const a = lattice(x0, y0);
    const b = lattice(x0 + 1, y0);
    const c = lattice(x0, y0 + 1);
    const d = lattice(x0 + 1, y0 + 1);
    const top = a + (b - a) * u;
    const bottom = c + (d - c) * u;
    // A convex blend of values in [0, 1) stays in [0, 1).
    return top + (bottom - top) * v;
  };
}

/** Rotation between successive fBm octaves, in radians. Any angle that is not
 *  a simple fraction of π works; this is the golden angle. */
const OCTAVE_TWIST = 2.399963;

export interface FbmOptions {
  /** Number of layered noise samples. Each adds finer detail. */
  octaves: number;
  /** Frequency multiplier between octaves (2 = each octave twice as fine). */
  lacunarity: number;
  /** Amplitude multiplier between octaves (0.5 = each octave half as strong).
   *  Must be > 0: at 0 the later octaves vanish silently, and a negative gain
   *  would let the weighted sum leave [0, 1). */
  gain: number;
  /** Feature size in input units: the first octave varies over ~`scale` units.
   *  Must be > 0 (it is divided by). */
  scale: number;
}

/**
 * Fractal Brownian motion: several octaves of `noise` summed with falling
 * amplitude, normalised back to [0, 1).
 *
 * Each octave is rotated by a further fixed angle and shifted by a fixed
 * offset. Without that every octave shares the lattice point at the origin (and
 * at multiples of `scale`), so the octaves' variance peaks coincide and the
 * field shows a faint grid of extreme spots aligned to the map corner.
 */
export function fbm(noise: Noise2D, x: number, y: number, opts: FbmOptions): number {
  const { octaves, lacunarity, gain, scale } = opts;
  // Thrown rather than clamped: a bad option is a caller bug, and fbm runs in a
  // per-tile loop where NaN or a silently flat field would be hard to trace.
  if (!(gain > 0)) throw new Error(`fbm: gain must be > 0 (got ${gain})`);
  if (!(scale > 0)) throw new Error(`fbm: scale must be > 0 (got ${scale})`);
  let freq = 1 / scale;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const off = o * 37.71;
    const c = Math.cos(o * OCTAVE_TWIST);
    const s = Math.sin(o * OCTAVE_TWIST);
    const u = (x * c - y * s) * freq + off;
    const v = (x * s + y * c) * freq - off;
    sum += amp * noise(u, v);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  // Weighted mean of values in [0, 1) is in [0, 1).
  return norm > 0 ? sum / norm : 0;
}

export interface PoissonDiskOptions {
  width: number;
  height: number;
  /** Minimum Euclidean distance between any two returned points, in tiles. */
  radius: number;
  /** Row-major, `width * height`; a non-zero cell may never hold a point. */
  mask?: Uint8Array;
  /** Extra per-tile predicate; a tile must pass it to hold a point. */
  accept?: (x: number, y: number) => boolean;
  rng: RNG;
  /** Candidates tried around each active point before retiring it (Bridson's k). */
  maxTries?: number;
}

/**
 * Bridson's Poisson-disk sampling on the integer tile grid.
 *
 * Returns distinct tiles whose pairwise Euclidean distance is at least
 * `radius`, all unmasked and accepted. Points are grown outward from an active
 * list by throwing up to `maxTries` candidates into the annulus [r, 2r) around
 * each active point, as in the paper.
 *
 * One deviation, needed because terrain masks are full of holes (roads cut the
 * map into blocks, groves are islands): classic Bridson grows from a single
 * seed, and the annulus can only hop gaps narrower than 2r, so every island it
 * cannot reach would stay empty. Here, whenever the active list runs dry, the
 * next valid tile from a seeded shuffle of the whole grid becomes a fresh seed.
 * The result is therefore *maximal* — no valid tile is left that could still
 * take a point — which also makes the density predictable from the area alone.
 */
export function poissonDisk(opts: PoissonDiskOptions): Array<{ x: number; y: number }> {
  const { width, height, radius, mask, accept, rng } = opts;
  const maxTries = opts.maxTries ?? 30;
  if (width <= 0 || height <= 0 || !(radius > 0)) return [];

  // Background grid with cell side ≥ radius: any point closer than `radius`
  // to a candidate lies in the candidate's cell or one of its 8 neighbours.
  // Cells can hold several points (integer rounding), hence lists. Floored at
  // one tile: points live on the integer grid, so finer cells buy nothing, and
  // a tiny radius would otherwise allocate (width/radius)² cell lists.
  const cell = Math.max(radius, 1);
  const gw = Math.ceil(width / cell);
  const gh = Math.ceil(height / cell);
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  const points: Array<{ x: number; y: number }> = [];
  const r2 = radius * radius;

  const valid = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    if (mask && mask[y * width + x]) return false;
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    for (let cy = Math.max(0, gy - 1); cy <= Math.min(gh - 1, gy + 1); cy++) {
      for (let cx = Math.max(0, gx - 1); cx <= Math.min(gw - 1, gx + 1); cx++) {
        for (const i of grid[cy * gw + cx]) {
          const dx = points[i].x - x;
          const dy = points[i].y - y;
          if (dx * dx + dy * dy < r2) return false;
        }
      }
    }
    // Last, because `accept` may be the most expensive check (noise lookups).
    return accept ? accept(x, y) : true;
  };

  const add = (x: number, y: number): number => {
    const i = points.length;
    points.push({ x, y });
    grid[Math.floor(y / cell) * gw + Math.floor(x / cell)].push(i);
    return i;
  };

  const seeds = rng.shuffle(Array.from({ length: width * height }, (_, i) => i));
  const active: number[] = [];
  for (const s of seeds) {
    const sx = s % width;
    const sy = Math.floor(s / width);
    if (!valid(sx, sy)) continue;
    active.push(add(sx, sy));

    while (active.length > 0) {
      const ai = Math.floor(rng.next() * active.length);
      const p = points[active[ai]];
      let placed = false;
      for (let t = 0; t < maxTries; t++) {
        const angle = rng.next() * Math.PI * 2;
        const dist = radius * (1 + rng.next());
        // `+ 0` turns the -0 that Math.round gives for (-0.5, 0) into 0; it
        // passes the bounds check and would otherwise leak out as a point.
        const cx = Math.round(p.x + Math.cos(angle) * dist) + 0;
        const cy = Math.round(p.y + Math.sin(angle) * dist) + 0;
        if (valid(cx, cy)) {
          active.push(add(cx, cy));
          placed = true;
          break;
        }
      }
      if (!placed) {
        // Swap-remove: order of the active list is irrelevant, it is sampled
        // uniformly anyway.
        active[ai] = active[active.length - 1];
        active.pop();
      }
    }
  }
  return points;
}
