import { describe, it, expect } from 'vitest';
import { makeValueNoise2D, fbm, poissonDisk, type FbmOptions } from '../noise';
import { makeRng } from '../rng';

const FBM: FbmOptions = { octaves: 3, lacunarity: 2, gain: 0.5, scale: 5 };

describe('makeValueNoise2D', () => {
  it('stays in [0, 1), including at negative and fractional coordinates', () => {
    const n = makeValueNoise2D(makeRng(1));
    for (let y = -20; y <= 20; y += 0.37) {
      for (let x = -20; x <= 20; x += 0.41) {
        const v = n(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('is deterministic for the same seed', () => {
    const a = makeValueNoise2D(makeRng(42));
    const b = makeValueNoise2D(makeRng(42));
    for (let i = 0; i < 200; i++) expect(a(i * 0.7, i * 1.3)).toBe(b(i * 0.7, i * 1.3));
  });

  it('differs between seeds', () => {
    const a = makeValueNoise2D(makeRng(1));
    const b = makeValueNoise2D(makeRng(2));
    let diff = 0;
    for (let i = 0; i < 200; i++) if (a(i * 0.7, i * 1.3) !== b(i * 0.7, i * 1.3)) diff++;
    expect(diff).toBeGreaterThan(190);
  });

  it('is smooth: a small step moves the value only a little', () => {
    // Quintic fade has max slope 1.875 per lattice unit; lattice values differ
    // by < 1; the rotation adds at most √2. So a 0.01 step moves < 0.027.
    const n = makeValueNoise2D(makeRng(7));
    let maxDelta = 0;
    for (let y = 0; y < 30; y += 0.53) {
      for (let x = 0; x < 30; x += 0.47) {
        maxDelta = Math.max(maxDelta, Math.abs(n(x + 0.01, y) - n(x, y)), Math.abs(n(x, y + 0.01) - n(x, y)));
      }
    }
    expect(maxDelta).toBeLessThan(0.03);
  });

  it('actually varies (not a constant field)', () => {
    const n = makeValueNoise2D(makeRng(3));
    let min = 1, max = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      min = Math.min(min, n(x, y));
      max = Math.max(max, n(x, y));
    }
    expect(max - min).toBeGreaterThan(0.5);
  });
});

describe('fbm', () => {
  it('stays in [0, 1) and is deterministic', () => {
    const a = makeValueNoise2D(makeRng(5));
    const b = makeValueNoise2D(makeRng(5));
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 30; x++) {
        const v = fbm(a, x, y, FBM);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
        expect(v).toBe(fbm(b, x, y, FBM));
      }
    }
  });

  it('with one octave is the base noise at 1/scale', () => {
    const n = makeValueNoise2D(makeRng(9));
    const opts = { octaves: 1, lacunarity: 2, gain: 0.5, scale: 4 };
    for (let i = 0; i < 50; i++) expect(fbm(n, i, i * 2, opts)).toBeCloseTo(n(i / 4, i / 2), 12);
  });

  it('throws on a non-positive gain or scale', () => {
    const n = makeValueNoise2D(makeRng(1));
    expect(() => fbm(n, 1, 1, { ...FBM, gain: 0 })).toThrow('gain');
    expect(() => fbm(n, 1, 1, { ...FBM, gain: -0.5 })).toThrow('gain');
    expect(() => fbm(n, 1, 1, { ...FBM, scale: 0 })).toThrow('scale');
    expect(() => fbm(n, 1, 1, { ...FBM, scale: Number.NaN })).toThrow('scale');
  });

  it('has no lattice-aligned column bias in its extremes', () => {
    // Regression: with an axis-aligned lattice, value noise's variance peaks on
    // lattice columns, and the top few percent of a scale-5 field landed 3-4×
    // as often on x ≡ 0,1 (mod 5) as on x ≡ 2 — dirt was drawn as vertical
    // stripes. Count top-3.5% picks by x mod 5 over many seeds.
    const W = 60, H = 45;
    const byPhase = [0, 0, 0, 0, 0];
    for (let s = 0; s < 60; s++) {
      const n = makeValueNoise2D(makeRng(1000 + s));
      const vals: Array<[number, number]> = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) vals.push([fbm(n, x, y, FBM), x]);
      vals.sort((p, q) => q[0] - p[0]);
      for (const [, x] of vals.slice(0, Math.round(vals.length * 0.035))) byPhase[x % 5]++;
    }
    expect(Math.max(...byPhase) / Math.min(...byPhase)).toBeLessThan(1.3);
  });
});

describe('poissonDisk', () => {
  const minDistance = (pts: Array<{ x: number; y: number }>): number => {
    let min = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
      }
    }
    return min;
  };

  it('keeps every pair at least `radius` apart, on distinct in-bounds tiles', () => {
    for (const radius of [1.5, 2.5, 3.7]) {
      const pts = poissonDisk({ width: 50, height: 40, radius, rng: makeRng(11) });
      expect(pts.length).toBeGreaterThan(10);
      expect(minDistance(pts)).toBeGreaterThanOrEqual(radius);
      const keys = new Set(pts.map((p) => `${p.x},${p.y}`));
      expect(keys.size).toBe(pts.length);
      for (const p of pts) {
        expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(50);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThan(40);
      }
    }
  });

  it('is deterministic', () => {
    const a = poissonDisk({ width: 40, height: 30, radius: 2.5, rng: makeRng(4) });
    const b = poissonDisk({ width: 40, height: 30, radius: 2.5, rng: makeRng(4) });
    expect(a).toEqual(b);
    const c = poissonDisk({ width: 40, height: 30, radius: 2.5, rng: makeRng(5) });
    expect(c).not.toEqual(a);
  });

  it('respects the mask and the accept predicate', () => {
    const w = 40, h = 30;
    const mask = new Uint8Array(w * h);
    // Block a vertical band and the top rows.
    for (let y = 0; y < h; y++) for (let x = 15; x < 22; x++) mask[y * w + x] = 1;
    for (let x = 0; x < w; x++) for (let y = 0; y < 5; y++) mask[y * w + x] = 1;
    const pts = poissonDisk({
      width: w, height: h, radius: 2, mask, rng: makeRng(8),
      accept: (x) => x % 2 === 0,
    });
    expect(pts.length).toBeGreaterThan(10);
    for (const p of pts) {
      expect(mask[p.y * w + p.x]).toBe(0);
      expect(p.x % 2).toBe(0);
    }
    // Both sides of the blocked band get points: the sampler reseeds islands.
    expect(pts.some((p) => p.x < 15)).toBe(true);
    expect(pts.some((p) => p.x >= 22)).toBe(true);
  });

  it('is maximal: every free tile is within `radius` of some point', () => {
    const w = 40, h = 30, radius = 2.7;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 14; y++) for (let x = 0; x < w; x++) mask[y * w + x] = 1;
    const pts = poissonDisk({ width: w, height: h, radius, mask, rng: makeRng(21) });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) continue;
        const covered = pts.some((p) => Math.hypot(p.x - x, p.y - y) < radius);
        expect(covered, `${x},${y} could still take a point`).toBe(true);
      }
    }
    // And the density is in the expected range for random close packing
    // (~0.55-0.9 / r² points per tile on a grid).
    const free = w * h - 4 * w;
    const density = pts.length / free;
    expect(density * radius * radius).toBeGreaterThan(0.5);
    expect(density * radius * radius).toBeLessThan(1.1);
  });

  it('handles a tiny radius quickly: every tile becomes a point', () => {
    // Regression: the background grid used cell side = radius, so r=0.001 on a
    // 50×40 map asked for 2×10⁹ cell lists.
    const t0 = Date.now();
    const pts = poissonDisk({ width: 50, height: 40, radius: 0.001, rng: makeRng(2) });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(pts.length).toBe(50 * 40);
  });

  it('returns nothing for an empty or fully masked grid', () => {
    expect(poissonDisk({ width: 0, height: 10, radius: 2, rng: makeRng(1) })).toEqual([]);
    const mask = new Uint8Array(100).fill(1);
    expect(poissonDisk({ width: 10, height: 10, radius: 2, mask, rng: makeRng(1) })).toEqual([]);
  });
});
