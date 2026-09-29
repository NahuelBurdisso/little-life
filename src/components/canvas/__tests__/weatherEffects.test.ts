// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js';
import { WeatherEffects } from '../WeatherEffects';

const W = 800, H = 600;
const make = () => {
  const stage = new PIXI.Container();
  const fx = new WeatherEffects({ stage } as unknown as PIXI.Application);
  const live = () => (fx as unknown as { particles: { graphic: PIXI.Graphics; wobble?: { baseX: number; amp: number } }[] }).particles;
  return { fx, live };
};

describe('WeatherEffects', () => {
  it('lets heat shimmer rise and sway around where it was born', () => {
    const { fx, live } = make();
    for (let i = 0; i < 60; i++) fx.update('hot', W, H, 1);
    const bands = live().slice();
    expect(bands.length).toBeGreaterThan(20);
    for (const b of bands) {
      expect(b.wobble).toBeDefined();
      // Never drifts off sideways: stays within its own amplitude of the spawn column.
      expect(Math.abs(b.graphic.x - b.wobble!.baseX)).toBeLessThanOrEqual(b.wobble!.amp + 1e-6);
    }
    const y0 = bands.map(b => b.graphic.y);
    for (let i = 0; i < 20; i++) fx.update('hot', W, H, 1);
    const survivors = bands.filter(b => live().includes(b));
    expect(survivors.length).toBeGreaterThan(0);
    for (const b of survivors) expect(b.graphic.y).toBeLessThan(y0[bands.indexOf(b)]);
    fx.destroy();
  });

  it('sways some bands and not others, so the air does not move in one piece', () => {
    const { fx, live } = make();
    for (let i = 0; i < 40; i++) fx.update('hot', W, H, 1);
    const offsets = live().map(b => Math.round((b.graphic.x - b.wobble!.baseX) * 10));
    expect(new Set(offsets).size).toBeGreaterThan(5);
    fx.destroy();
  });

  it('draws nothing for clear or cloudy skies (cloud shadows are the sky system\'s)', () => {
    for (const w of ['sunny', 'cloudy']) {
      const { fx, live } = make();
      for (let i = 0; i < 30; i++) fx.update(w, W, H, 1);
      expect(live().length, w).toBe(0);
      fx.destroy();
    }
  });

  it('still rains straight down-left and drops the heat when the weather changes', () => {
    const { fx, live } = make();
    for (let i = 0; i < 30; i++) fx.update('hot', W, H, 1);
    fx.update('rainy', W, H, 1);
    fx.update('rainy', W, H, 1);
    expect(live().every(p => p.wobble === undefined)).toBe(true);
    expect(live().length).toBeGreaterThan(0);
    fx.destroy();
  });
});
