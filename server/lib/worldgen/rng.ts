/**
 * Seeded PRNG for deterministic world generation.
 * Not cryptographically secure — content generation only.
 */

/** xmur3 string hash → uint32 seed. Stable across Node versions. */
export function stringToSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export interface RNG {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Pick a uniform random element. Throws on empty array. */
  pick<T>(arr: readonly T[]): T;
  /** Return a new array that's a uniform random permutation of `arr`. */
  shuffle<T>(arr: readonly T[]): T[];
  /** Pick an element weighted by each item's `weight`. Weights may be 0 (never
   *  picked); the total must be > 0. */
  weightedPick<T>(opts: ReadonlyArray<{ item: T; weight: number }>): T;
}

/** mulberry32 PRNG. Deterministic from a uint32 seed. */
export function makeRng(seed: number): RNG {
  let state = seed >>> 0;
  function next(): number {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    int(min: number, max: number): number {
      if (max < min) throw new Error(`RNG.int: max (${max}) < min (${min})`);
      return Math.floor(next() * (max - min + 1)) + min;
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error('RNG.pick: empty array');
      return arr[Math.floor(next() * arr.length)];
    },
    shuffle<T>(arr: readonly T[]): T[] {
      const copy = arr.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    weightedPick<T>(opts: ReadonlyArray<{ item: T; weight: number }>): T {
      if (opts.length === 0) throw new Error('RNG.weightedPick: empty array');
      const total = opts.reduce((s, o) => s + o.weight, 0);
      if (total <= 0) throw new Error('RNG.weightedPick: non-positive total weight');
      let r = next() * total;
      for (const o of opts) {
        r -= o.weight;
        // `<= 0` returned a zero-weight first entry whenever next() gave exactly 0.
        if (r < 0) return o.item;
      }
      return opts[opts.length - 1].item;
    },
  };
}

/** Fork an RNG by master seed + label. Stages use forkRng(masterSeedStr, stage.name). */
export function forkRng(masterSeedStr: string, label: string): RNG {
  return makeRng(stringToSeed(`${masterSeedStr}:${label}`));
}

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Generate a random base62 string of the given length (uses Math.random,
 *  not seeded — this is what we use to generate a master seed when none is
 *  provided). */
export function randomBase62(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += BASE62_ALPHABET[Math.floor(Math.random() * BASE62_ALPHABET.length)];
  }
  return out;
}
