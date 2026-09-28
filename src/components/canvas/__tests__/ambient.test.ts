import { describe, it, expect } from 'vitest';
import {
  computeAmbient, ambientKey, PHASE_AMBIENT, weatherMod,
  advanceTransition, blendAmbient, chanceOverDelta, type AmbientProfile,
} from '../ambient';

/** Run a full transition at a given frame delta; returns frames taken and final ambient. */
function runTransition(from: AmbientProfile, to: AmbientProfile, delta: number, stopAt = 1) {
  const out = { ...from };
  let progress = 0;
  let elapsed = 0;
  while (progress < stopAt) {
    progress = advanceTransition(progress, delta);
    blendAmbient(from, to, progress, out);
    elapsed += delta;
  }
  return { elapsed, out };
}

describe('ambient transition timing', () => {
  const from = PHASE_AMBIENT.afternoon;
  const to = PHASE_AMBIENT.night;

  it('takes the same wall-clock time at 30, 60 and 144 fps', () => {
    // Within one frame of each other (float accumulation can cost a last step).
    const at60 = runTransition(from, to, 1).elapsed;
    expect(Math.abs(runTransition(from, to, 2).elapsed - at60)).toBeLessThanOrEqual(2);
    expect(Math.abs(runTransition(from, to, 60 / 144).elapsed - at60)).toBeLessThanOrEqual(1);
    expect(at60).toBeGreaterThanOrEqual(60);
    expect(at60).toBeLessThanOrEqual(61);
  });

  it('is at the same point halfway through regardless of frame rate', () => {
    const a = { ...from };
    const b = { ...from };
    blendAmbient(from, to, advanceTransition(0, 30), a);           // one 30-frame hitch
    let p = 0;
    for (let i = 0; i < 72; i++) p = advanceTransition(p, 60 / 144); // 72 frames at 144 Hz
    blendAmbient(from, to, p, b);
    expect(b.brightness).toBeCloseTo(a.brightness, 5);
    expect(b.r).toBeCloseTo(a.r, 5);
  });

  it('lands exactly on the target', () => {
    const { out } = runTransition(from, to, 1);
    expect(out.r).toBeCloseTo(to.r, 9);
    expect(out.g).toBeCloseTo(to.g, 9);
    expect(out.b).toBeCloseTo(to.b, 9);
    expect(out.brightness).toBeCloseTo(to.brightness, 9);
  });

  it('ignores negative deltas', () => {
    expect(advanceTransition(0.5, -3)).toBe(0.5);
  });
});

describe('chanceOverDelta', () => {
  it('matches the per-frame chance at 60 fps and is 0 for no time', () => {
    expect(chanceOverDelta(0.02, 1)).toBeCloseTo(0.02);
    expect(chanceOverDelta(0.02, 0)).toBe(0);
  });

  it('keeps the per-second rate constant across frame rates', () => {
    const perSecondAt60 = 1 - Math.pow(1 - chanceOverDelta(0.02, 1), 60);
    const perSecondAt144 = 1 - Math.pow(1 - chanceOverDelta(0.02, 60 / 144), 144);
    expect(perSecondAt144).toBeCloseTo(perSecondAt60, 10);
  });
});

describe('computeAmbient', () => {
  it('dims the same phase when the weather turns bad', () => {
    const sunny = computeAmbient('afternoon', 'summer', 'sunny');
    const stormy = computeAmbient('afternoon', 'summer', 'stormy');
    expect(stormy.brightness).toBeCloseTo(sunny.brightness * 0.5);
    expect(sunny.brightness).toBeCloseTo(PHASE_AMBIENT.afternoon.brightness);
  });

  it('applies the weather tint on top of the season tint', () => {
    const clear = computeAmbient('morning', 'spring', 'sunny');
    const foggy = computeAmbient('morning', 'spring', 'foggy');
    expect(foggy.r).not.toBeCloseTo(clear.r);
    expect(foggy.b).not.toBeCloseTo(clear.b);
  });

  it('falls back to morning / sunny for unknown values', () => {
    const odd = computeAmbient('???', 'nope', 'clear');
    expect(odd.brightness).toBeCloseTo(PHASE_AMBIENT.morning.brightness);
    expect(weatherMod('clear')).toBe(weatherMod('sunny'));
  });

  it('does not mutate the shared phase table', () => {
    computeAmbient('night', 'winter', 'snowy');
    expect(PHASE_AMBIENT.night).toEqual({ r: 100, g: 110, b: 150, brightness: 0.45 });
  });
});

describe('ambientKey', () => {
  it('changes when only the weather changes (C4: weather waited for the next phase)', () => {
    expect(ambientKey('afternoon', 'summer', 'sunny')).not.toBe(ambientKey('afternoon', 'summer', 'stormy'));
  });

  it('changes when only the season changes', () => {
    expect(ambientKey('night', 'autumn', 'sunny')).not.toBe(ambientKey('night', 'winter', 'sunny'));
  });

  it('is stable for identical inputs', () => {
    expect(ambientKey('dawn', 'spring', 'rainy')).toBe(ambientKey('dawn', 'spring', 'rainy'));
  });
});
