import { describe, it, expect } from 'vitest';
import { PARTICLE_PROFILES } from '../profileRegistry';

// WeatherEffects is the single precipitation renderer (rain for rainy/stormy,
// snow for snowy). A particle profile for any of these draws a second layer.
const PRECIPITATION = new Set(['rainy', 'stormy', 'snowy']);

describe('PARTICLE_PROFILES', () => {
  it('leaves rain and snow to WeatherEffects', () => {
    for (const p of PARTICLE_PROFILES) {
      if (p.trigger.type === 'weather') {
        expect(PRECIPITATION.has(p.trigger.weather), p.id).toBe(false);
      }
    }
  });

  it('never makes it snow because of the season alone', () => {
    const winter = PARTICLE_PROFILES.filter(
      (p) => p.trigger.type === 'season' && p.trigger.season === 'winter',
    );
    expect(winter.map((p) => p.id)).toEqual([]);
  });

  it('has unique ids', () => {
    const ids = PARTICLE_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
