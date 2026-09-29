import { describe, it, expect } from 'vitest';
import { makeRng } from '../../ambientLife/critters';
import { PLACE_FRAMES } from '../placeFrames';
import {
  CHICK_FLEE_RADIUS, chickFrame, crowdLaunch, dustFrame, newChick, particleAlpha, pulseFactor, resetChick,
  sparkFrame, sparkLaunch, stepChick, type Launch,
} from '../placeMotion';

const yard = { x: 100, y: 200, width: 60, height: 40 };

describe('pulseFactor', () => {
  it('stays within [1 - swing, 1] for every pulse over a long stretch', () => {
    for (const pulse of ['flicker', 'breath', 'heartbeat'] as const) {
      for (const swing of [0.15, 0.5, 0.85]) {
        let lo = 1, hi = 0;
        for (let t = 0; t < 30; t += 0.013) {
          const v = pulseFactor(pulse, swing, t, 1.7);
          lo = Math.min(lo, v); hi = Math.max(hi, v);
        }
        expect(lo).toBeGreaterThanOrEqual(1 - swing - 1e-9);
        expect(hi).toBeLessThanOrEqual(1 + 1e-9);
        // and it really moves
        expect(hi - lo).toBeGreaterThan(swing * 0.5);
      }
    }
  });

  it('a heartbeat beats twice per period and rests between', () => {
    const samples: number[] = [];
    for (let i = 0; i < 130; i++) samples.push(pulseFactor('heartbeat', 1, (i / 130) * 1.3, 0));
    let peaks = 0;
    for (let i = 1; i < samples.length - 1; i++) {
      if (samples[i] > 0.5 && samples[i] >= samples[i - 1] && samples[i] > samples[i + 1]) peaks++;
    }
    expect(peaks).toBe(2);
    expect(Math.min(...samples)).toBe(0);
  });

  it('different phases do not flicker in step', () => {
    let differ = 0;
    for (let t = 0; t < 5; t += 0.1) if (Math.abs(pulseFactor('flicker', 0.5, t, 0) - pulseFactor('flicker', 0.5, t, 3)) > 0.05) differ++;
    expect(differ).toBeGreaterThan(10);
  });
});

describe('launches', () => {
  const out: Launch = { vx: 0, vy: 0, g: 0, life: 0 };

  it('a hammer strike throws sparks up and out, and they fall back quickly', () => {
    const rnd = makeRng(3);
    for (let i = 0; i < 100; i++) {
      sparkLaunch('hammer', rnd, out);
      expect(out.vy).toBeLessThan(0);
      expect(out.g).toBeGreaterThan(100);
      expect(out.life).toBeGreaterThan(0.3);
      expect(out.life).toBeLessThan(0.65);
    }
  });

  it('vent embers climb slowly for about a second, nearly weightless', () => {
    const rnd = makeRng(4);
    for (let i = 0; i < 100; i++) {
      sparkLaunch('vent', rnd, out);
      expect(out.vy).toBeLessThan(-20);
      expect(out.g).toBeLessThan(40);
      expect(out.life).toBeGreaterThan(0.85);
    }
  });

  it('notes and chatter rise gently without gravity', () => {
    const rnd = makeRng(5);
    for (let i = 0; i < 100; i++) {
      crowdLaunch(rnd, out);
      expect(out.vy).toBeLessThan(-10);
      expect(out.g).toBe(0);
      expect(out.life).toBeGreaterThan(1.4);
    }
  });
});

describe('particle look', () => {
  it('sparks cool through their three frames', () => {
    expect([0, 0.4, 0.7, 0.999].map(sparkFrame)).toEqual([PLACE_FRAMES.spark[0], PLACE_FRAMES.spark[1], PLACE_FRAMES.spark[2], PLACE_FRAMES.spark[2]]);
  });
  it('dust grows through its frames and clamps at the last', () => {
    expect(dustFrame(0)).toBe(PLACE_FRAMES.dust[0]);
    expect(dustFrame(1)).toBe(PLACE_FRAMES.dust[2]);
  });
  it('alpha fades in and out and is opaque in between', () => {
    for (const kind of ['spark', 'note', 'puff', 'dust'] as const) {
      expect(particleAlpha(kind, 0)).toBe(0);
      expect(particleAlpha(kind, 0.5)).toBeGreaterThan(0.5);
      expect(particleAlpha(kind, 1)).toBe(0);
    }
    expect(particleAlpha('spark', 0.7)).toBe(1);
  });
});

describe('chickens', () => {
  it('start inside the yard', () => {
    const rnd = makeRng(9);
    for (let i = 0; i < 50; i++) {
      const c = resetChick(newChick(), yard, rnd);
      expect(c.x).toBeGreaterThanOrEqual(yard.x);
      expect(c.x).toBeLessThanOrEqual(yard.x + yard.width);
      expect(c.y).toBeGreaterThanOrEqual(yard.y);
      expect(c.y).toBeLessThanOrEqual(yard.y + yard.height);
    }
  });

  it('never leave the yard over a long wander, and use all three modes', () => {
    const rnd = makeRng(11);
    const c = resetChick(newChick(), yard, rnd);
    const seen = new Set<string>();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 20000; i++) {
      stepChick(c, 1 / 30, yard, rnd, 0, 0, Infinity);
      seen.add(c.mode);
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
    }
    expect(minX).toBeGreaterThanOrEqual(yard.x - 0.001);
    expect(maxX).toBeLessThanOrEqual(yard.x + yard.width + 0.001);
    expect(minY).toBeGreaterThanOrEqual(yard.y - 0.001);
    expect(maxY).toBeLessThanOrEqual(yard.y + yard.height + 0.001);
    expect([...seen].sort()).toEqual(['peck', 'stand', 'walk']);
  });

  it('a hen runs from a close walker, away from them, and stays in the yard', () => {
    const rnd = makeRng(2);
    const c = resetChick(newChick(), yard, rnd);
    c.x = 130; c.y = 220;
    // the walker stands to the left (hen - walker = +x)
    stepChick(c, 1 / 30, yard, rnd, 10, 0, 100);
    expect(c.mode).toBe('walk');
    expect(c.tx).toBeGreaterThan(c.x);
    expect(c.facing).toBe(1);
    for (let i = 0; i < 100; i++) stepChick(c, 1 / 30, yard, rnd, 0, 0, Infinity);
    expect(c.x).toBeLessThanOrEqual(yard.x + yard.width + 0.001);
  });

  it('ignores a walker beyond the flee radius', () => {
    const rnd = makeRng(2);
    const c = resetChick(newChick(), yard, rnd);
    c.mode = 'peck'; c.left = 5;
    stepChick(c, 1 / 30, yard, rnd, CHICK_FLEE_RADIUS + 5, 0, (CHICK_FLEE_RADIUS + 5) ** 2);
    expect(c.mode).toBe('peck');
  });

  it('animates pecking between two frames and walking between two frames', () => {
    const c = newChick();
    c.mode = 'peck';
    const pecks = new Set([0, 0.1, 0.2, 0.3, 0.4, 0.5].map(t => chickFrame(c, t)));
    expect(pecks).toEqual(new Set([PLACE_FRAMES.chicken.peck, PLACE_FRAMES.chicken.stand]));
    c.mode = 'walk';
    const walks = new Set([0, 0.1, 0.2, 0.3].map(t => chickFrame(c, t)));
    expect(walks).toEqual(new Set(PLACE_FRAMES.chicken.walk));
    c.mode = 'stand';
    expect(chickFrame(c, 3)).toBe(PLACE_FRAMES.chicken.stand);
  });
});
