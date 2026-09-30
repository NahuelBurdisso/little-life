import { describe, it, expect } from 'vitest';
import {
  LAMP_TURNED_DOWN_LEVEL, HOME_LIGHT_FADE_FRAMES, homeLightLevel, homeHostsTryst, stepHomeLight,
} from '../homeLight';

const awake = { type: 'idle' };
const asleep = { type: 'sleeping' };
const tryst = { type: 'idle', zoneActivity: 'tryst', partnerId: 4 };

describe('homeLightLevel', () => {
  it('is dark for an empty house', () => {
    expect(homeLightLevel([])).toBe(0);
  });

  it('is dark when everyone inside is asleep', () => {
    expect(homeLightLevel([asleep])).toBe(0);
    expect(homeLightLevel([asleep, asleep, 'sleeping'])).toBe(0);
  });

  it('is fully lit while some occupant is awake', () => {
    expect(homeLightLevel([awake])).toBe(1);
    expect(homeLightLevel([asleep, awake])).toBe(1);
    expect(homeLightLevel(['eating'])).toBe(1);
    expect(homeLightLevel([{ type: 'socializing' }, undefined])).toBe(1);
  });

  it('turns the lamp down for a private evening, whoever else is in the house', () => {
    expect(homeLightLevel([tryst, tryst])).toBe(LAMP_TURNED_DOWN_LEVEL);
    expect(homeLightLevel([asleep, tryst])).toBe(LAMP_TURNED_DOWN_LEVEL);
    expect(LAMP_TURNED_DOWN_LEVEL).toBeGreaterThan(0.2);
    expect(LAMP_TURNED_DOWN_LEVEL).toBeLessThan(0.4);
  });

  it('does not treat the dawn walk home as the private evening', () => {
    expect(homeLightLevel([{ type: 'walking', zoneActivity: 'sneak_home' }])).toBe(1);
    expect(homeHostsTryst([{ type: 'walking', zoneActivity: 'sneak_home' }])).toBe(false);
  });

  it('accepts any iterable, not only arrays', () => {
    expect(homeLightLevel(new Set([tryst]))).toBe(LAMP_TURNED_DOWN_LEVEL);
  });
});

describe('homeHostsTryst', () => {
  it('is true only for a tryst zone activity', () => {
    expect(homeHostsTryst([awake, tryst])).toBe(true);
    expect(homeHostsTryst([awake, asleep, 'idle'])).toBe(false);
    expect(homeHostsTryst([])).toBe(false);
  });
});

describe('stepHomeLight', () => {
  it('moves toward the target without overshooting, and is frame-rate independent', () => {
    expect(stepHomeLight(0, 1, 1)).toBeCloseTo(1 / HOME_LIGHT_FADE_FRAMES, 6);
    expect(stepHomeLight(1, 0, 1)).toBeCloseTo(1 - 1 / HOME_LIGHT_FADE_FRAMES, 6);
    // Two half-frames land where one whole frame does.
    expect(stepHomeLight(stepHomeLight(0, 1, 0.5), 1, 0.5)).toBeCloseTo(stepHomeLight(0, 1, 1), 6);
    expect(stepHomeLight(0.99, 1, 50)).toBe(1);
    expect(stepHomeLight(0.01, 0, 50)).toBe(0);
    expect(stepHomeLight(0.5, 0.5, 1)).toBe(0.5);
  });

  it('gets there in about the advertised number of frames', () => {
    let v = 0;
    for (let i = 0; i < HOME_LIGHT_FADE_FRAMES; i++) v = stepHomeLight(v, 1, 1);
    expect(v).toBeCloseTo(1, 5);
  });
});
