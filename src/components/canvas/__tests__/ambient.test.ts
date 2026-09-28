import { describe, it, expect } from 'vitest';
import { computeAmbient, ambientKey, PHASE_AMBIENT, weatherMod } from '../ambient';

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
