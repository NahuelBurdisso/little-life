import { describe, it, expect } from 'vitest';
import {
  CLOUD_COUNT, STAR_SPEED, cloudInView, cloudShadowStrength, daylightFactor, easeToward, hasStarryNight,
  makeClouds, newStar, nextStarDelay, planSky, seededRandom, spawnStar, stepCloud, stepStar,
} from '../skyModel';

const MAP = { w: 1920, h: 1280 };
const VIEW = { x: 400, y: 300, w: 800, h: 600, scale: 1 };
const square = { id: 1, type: 'town_square', position: { x: 640, y: 320, width: 384, height: 256 }, entry_point: { x: 832, y: 448 } };
const ev = (id: number, type: string) => ({ id, type });

describe('seededRandom', () => {
  it('repeats for a seed and stays in [0,1)', () => {
    const a = seededRandom(7), b = seededRandom(7);
    for (let i = 0; i < 50; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(seededRandom(8)()).not.toBe(seededRandom(7)());
  });
});

describe('easeToward', () => {
  it('approaches the target without overshooting, whatever the frame length', () => {
    let x = 0;
    for (let i = 0; i < 300; i++) x = easeToward(x, 1, 1 / 60, 1.4);
    let y = 0;
    for (let i = 0; i < 150; i++) y = easeToward(y, 1, 1 / 30, 1.4);
    expect(x).toBeCloseTo(y, 3);            // same wall time, same value
    expect(x).toBeLessThanOrEqual(1);
    expect(easeToward(0.5, 0.5, 1, 3)).toBe(0.5);
    expect(easeToward(0.2, 1, 0, 3)).toBe(0.2);
    expect(easeToward(0.2, 1, -5, 3)).toBe(0.2);
  });
});

describe('clouds', () => {
  it('makes the same sky for the same map and a different one otherwise', () => {
    expect(makeClouds(MAP)).toEqual(makeClouds(MAP));
    expect(makeClouds(MAP)).not.toEqual(makeClouds({ w: 1000, h: 1000 }));
  });

  it('puts big soft shadows over the map, drifting the same way', () => {
    const clouds = makeClouds(MAP);
    expect(clouds).toHaveLength(CLOUD_COUNT);
    for (const c of clouds) {
      expect(c.w).toBeGreaterThan(300);
      expect(c.h).toBeLessThan(c.w);
      expect(c.vx).toBeGreaterThan(0);
      expect(c.vy).toBeGreaterThan(0);
      expect(c.lobes.length).toBe(3);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(MAP.w);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(MAP.h);
    }
  });

  it('drifts at its own speed and wraps round once fully past the far edge', () => {
    const c = makeClouds(MAP)[0];
    const x0 = c.x;
    stepCloud(c, 10, MAP);
    expect(c.x).toBeCloseTo(x0 + c.vx * 10);
    c.x = MAP.w + c.w;                     // well past
    stepCloud(c, 0.1, MAP);
    expect(c.x).toBeLessThan(0);
    c.y = MAP.h + c.h;
    stepCloud(c, 0.1, MAP);
    expect(c.y).toBeLessThan(0);
  });

  it('never walks off forever: any cloud is back over the map after a long time', () => {
    const c = makeClouds(MAP)[1];
    let overMap = 0;
    for (let i = 0; i < 20000; i++) {
      stepCloud(c, 0.5, MAP);
      if (c.x > 0 && c.x < MAP.w && c.y > 0 && c.y < MAP.h) overMap++;
    }
    expect(overMap).toBeGreaterThan(500);
  });

  it('is culled when off screen', () => {
    const c = { ...makeClouds(MAP)[0], x: 800, y: 600 };
    expect(cloudInView(c, VIEW)).toBe(true);
    expect(cloudInView({ ...c, x: 5000 }, VIEW)).toBe(false);
    expect(cloudInView({ ...c, y: -5000 }, VIEW)).toBe(false);
  });

  it('casts shadows only under a broken sky and only with sun', () => {
    expect(cloudShadowStrength('cloudy')).toBeGreaterThan(cloudShadowStrength('windy'));
    expect(cloudShadowStrength('windy')).toBeGreaterThan(0);
    for (const w of ['sunny', 'rainy', 'stormy', 'foggy', 'snowy', 'hot', '']) expect(cloudShadowStrength(w), w).toBe(0);
    expect(daylightFactor('morning')).toBe(1);
    expect(daylightFactor('afternoon')).toBe(1);
    expect(daylightFactor('dawn')).toBeLessThan(1);
    expect(daylightFactor('evening')).toBeLessThan(1);
    expect(daylightFactor('night')).toBe(0);
    expect(daylightFactor('nonsense')).toBe(0);
  });
});

describe('shooting stars', () => {
  it('starts inside the upper part of the view heading right and down', () => {
    const rand = seededRandom(3);
    for (let i = 0; i < 200; i++) {
      const s = newStar();
      spawnStar(VIEW, rand, s);
      expect(s.active).toBe(true);
      expect(s.x).toBeGreaterThanOrEqual(VIEW.x);
      expect(s.x).toBeLessThanOrEqual(VIEW.x + VIEW.w * 0.6);
      expect(s.y).toBeGreaterThanOrEqual(VIEW.y);
      expect(s.y).toBeLessThanOrEqual(VIEW.y + VIEW.h * 0.4);
      expect(s.vx).toBeGreaterThan(0);
      expect(s.vy).toBeGreaterThan(0);
      expect(s.vx).toBeGreaterThan(s.vy);         // shallower than 45 degrees
      expect(s.life).toBeGreaterThan(0.5);
      expect(s.life).toBeLessThan(1);
    }
  });

  it('keeps its screen speed when the camera zooms', () => {
    const near = newStar(), far = newStar();
    spawnStar({ ...VIEW, scale: 2 }, seededRandom(1), near);
    spawnStar({ ...VIEW, scale: 0.5 }, seededRandom(1), far);
    expect(Math.hypot(near.vx, near.vy) * 2).toBeCloseTo(Math.hypot(far.vx, far.vy) * 0.5);
    expect(Math.hypot(near.vx, near.vy) * 2).toBeGreaterThan(STAR_SPEED * 0.8);
  });

  it('flares in, fades out, and switches itself off at the end of its life', () => {
    const s = newStar();
    spawnStar(VIEW, seededRandom(5), s);
    const x0 = s.x;
    expect(stepStar(s, 0)).toBe(0);
    const early = stepStar(s, 0.03);
    const mid = stepStar(s, s.life * 0.3);
    const late = stepStar(s, s.life * 0.4);
    expect(s.x).toBeGreaterThan(x0);
    expect(early).toBeLessThan(mid + 1e-9);
    expect(mid).toBeGreaterThan(late);
    for (const b of [early, mid, late]) { expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThanOrEqual(1); }
    expect(stepStar(s, 5)).toBe(0);
    expect(s.active).toBe(false);
    expect(stepStar(s, 1)).toBe(0);
  });

  it('spaces stars out by seconds, not frames', () => {
    const rand = seededRandom(2);
    for (let i = 0; i < 100; i++) {
      const d = nextStarDelay(rand);
      expect(d).toBeGreaterThanOrEqual(3.5);
      expect(d).toBeLessThan(9.1);
    }
  });
});

describe('planSky', () => {
  it('puts the moon and the shafts on the square and the mist at the stranger', () => {
    const pieces = planSky([ev(1, 'full_moon'), ev(2, 'blessing'), ev(3, 'mysterious_stranger')], [square], MAP, [{ x: 0, y: 8 }]);
    const kinds = pieces.map(p => p.kind).sort();
    expect(kinds).toEqual(['mist', 'moon', 'shafts']);
    for (const p of pieces) {
      if (p.kind === 'mist') expect(p.x).toBe(16);
      else expect(p.rect).toEqual(square.position);
    }
  });

  it('draws each kind once and ignores what has no sky effect', () => {
    const pieces = planSky([ev(1, 'full_moon'), ev(2, 'full_moon'), ev(3, 'storm'), null, {}], [square], MAP);
    expect(pieces).toHaveLength(1);
    expect(planSky(null, [square], MAP)).toEqual([]);
    expect(planSky([ev(1, 'full_moon')], [], null)).toEqual([]);
  });

  it('spots a starry night', () => {
    expect(hasStarryNight([ev(1, 'festival'), ev(2, 'starry_night')])).toBe(true);
    expect(hasStarryNight([ev(1, 'festival')])).toBe(false);
    expect(hasStarryNight(undefined)).toBe(false);
  });
});
