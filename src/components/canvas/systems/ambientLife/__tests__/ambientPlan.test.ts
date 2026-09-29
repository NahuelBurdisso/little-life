import { describe, it, expect } from 'vitest';
import {
  ambientPlan, wellCenter, MAX_CRITTERS, POOL_CAPS,
  type AmbientInputs, type AmbientPlan,
} from '../ambientPlan';

const base: AmbientInputs = {
  dayPhase: 'morning', weather: 'sunny', season: 'spring',
  mapW: 40, mapH: 30, detail: 1, homes: 8, litWindows: 5, waterTiles: 0,
};
const plan = (o: Partial<AmbientInputs> = {}): AmbientPlan => ambientPlan({ ...base, ...o });
const total = (p: AmbientPlan) => p.birds + p.butterflies + p.moths + p.cats + p.ducks;

describe('ambientPlan: zoom detail', () => {
  it('shows nothing but the fountain when zoomed far out', () => {
    const p = plan({ detail: 0, waterTiles: 40 });
    expect(total(p)).toBe(0);
    expect(p.fountain).toBe(true);
  });
  it('thins critters out when zoomed in close (the view holds fewer tiles)', () => {
    const normal = plan({ detail: 1 });
    const close = plan({ detail: 2 });
    expect(close.birds).toBeLessThan(normal.birds);
    expect(close.birds).toBeGreaterThan(0);
  });
});

describe('ambientPlan: fountain', () => {
  it('always runs', () => {
    for (const dayPhase of ['dawn', 'morning', 'afternoon', 'evening', 'night']) {
      for (const weather of ['sunny', 'stormy', 'snowy', 'foggy']) {
        expect(plan({ dayPhase, weather }).fountain).toBe(true);
      }
    }
  });
});

describe('ambientPlan: birds', () => {
  it('peck by day', () => {
    for (const dayPhase of ['dawn', 'morning', 'afternoon']) {
      expect(plan({ dayPhase }).birds, dayPhase).toBeGreaterThan(0);
    }
  });
  it('roost at night', () => expect(plan({ dayPhase: 'night' }).birds).toBe(0));
  it('are fewer at dusk than at noon', () => {
    expect(plan({ dayPhase: 'evening' }).birds).toBeLessThan(plan({ dayPhase: 'afternoon' }).birds);
    expect(plan({ dayPhase: 'evening' }).birds).toBeGreaterThan(0);
  });
  it('hide when it rains, storms, snows or fogs over', () => {
    for (const weather of ['rainy', 'stormy', 'snowy', 'foggy']) {
      expect(plan({ weather }).birds, weather).toBe(0);
    }
  });
  it('stay through cloud and wind', () => {
    expect(plan({ weather: 'cloudy' }).birds).toBeGreaterThan(0);
    expect(plan({ weather: 'windy' }).birds).toBeGreaterThan(0);
  });
  it('are scarcer in winter', () => {
    expect(plan({ season: 'winter' }).birds).toBeLessThan(plan({ season: 'spring' }).birds);
    expect(plan({ season: 'winter' }).birds).toBeGreaterThan(0);
  });
  it('scale with the size of the map, within the pool cap', () => {
    expect(plan({ mapW: 20, mapH: 15 }).birds).toBeLessThan(plan({ mapW: 60, mapH: 45 }).birds);
    expect(plan({ mapW: 400, mapH: 400 }).birds).toBeLessThanOrEqual(POOL_CAPS.birds);
  });
});

describe('ambientPlan: butterflies', () => {
  it('flutter by day in spring and summer', () => {
    for (const season of ['spring', 'summer']) {
      for (const dayPhase of ['morning', 'afternoon']) {
        expect(plan({ season, dayPhase }).butterflies, `${season} ${dayPhase}`).toBeGreaterThan(0);
      }
    }
  });
  it('are absent in autumn and winter', () => {
    expect(plan({ season: 'autumn' }).butterflies).toBe(0);
    expect(plan({ season: 'winter' }).butterflies).toBe(0);
  });
  it('are absent at dawn, dusk and night', () => {
    for (const dayPhase of ['dawn', 'evening', 'night']) {
      expect(plan({ dayPhase }).butterflies, dayPhase).toBe(0);
    }
  });
  it('need dry, still weather', () => {
    for (const weather of ['rainy', 'stormy', 'foggy', 'snowy', 'windy']) {
      expect(plan({ weather }).butterflies, weather).toBe(0);
    }
  });
});

describe('ambientPlan: moths', () => {
  it('gather round lit windows at night, at most 6', () => {
    expect(plan({ dayPhase: 'night', litWindows: 3 }).moths).toBeGreaterThan(0);
    expect(plan({ dayPhase: 'night', litWindows: 30 }).moths).toBe(6);
  });
  it('need a lit window', () => expect(plan({ dayPhase: 'night', litWindows: 0 }).moths).toBe(0));
  it('stay away by day', () => {
    for (const dayPhase of ['dawn', 'morning', 'afternoon', 'evening']) {
      expect(plan({ dayPhase, litWindows: 8 }).moths, dayPhase).toBe(0);
    }
  });
  it('stay out of rain, storms and the winter cold', () => {
    for (const weather of ['rainy', 'stormy', 'snowy']) {
      expect(plan({ dayPhase: 'night', weather }).moths, weather).toBe(0);
    }
    expect(plan({ dayPhase: 'night', season: 'winter' }).moths).toBe(0);
  });
});

describe('ambientPlan: cats', () => {
  it('keep one per four homes', () => {
    expect(plan({ homes: 8 }).cats).toBe(2);
    expect(plan({ homes: 12 }).cats).toBe(3);
  });
  it('a small town still has a cat, an empty one has none', () => {
    expect(plan({ homes: 2 }).cats).toBe(1);
    expect(plan({ homes: 1 }).cats).toBe(0);
    expect(plan({ homes: 0 }).cats).toBe(0);
  });
  it('are capped by the pool', () => expect(plan({ homes: 200 }).cats).toBe(POOL_CAPS.cats));
  it('go indoors when it rains or storms', () => {
    expect(plan({ weather: 'rainy' }).cats).toBe(0);
    expect(plan({ weather: 'stormy' }).cats).toBe(0);
  });
  it('are fewer at night', () => {
    expect(plan({ dayPhase: 'night', homes: 12 }).cats).toBeLessThan(plan({ homes: 12 }).cats);
    expect(plan({ dayPhase: 'night', homes: 12 }).cats).toBeGreaterThan(0);
  });
});

describe('ambientPlan: ducks', () => {
  it('need water', () => expect(plan({ waterTiles: 0 }).ducks).toBe(0));
  it('paddle on a pond by day, more on bigger water', () => {
    const small = plan({ waterTiles: 8 }).ducks;
    const big = plan({ waterTiles: 80 }).ducks;
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThanOrEqual(POOL_CAPS.ducks);
  });
  it('sleep at night and duck the storm', () => {
    expect(plan({ waterTiles: 80, dayPhase: 'night' }).ducks).toBe(0);
    expect(plan({ waterTiles: 80, weather: 'stormy' }).ducks).toBe(0);
  });
  it('do not stay on frozen water', () => expect(plan({ waterTiles: 80, season: 'winter' }).ducks).toBe(0));
});

describe('ambientPlan: budget', () => {
  it('never exceeds the hard cap, whatever the world', () => {
    for (const dayPhase of ['dawn', 'morning', 'afternoon', 'evening', 'night']) {
      for (const season of ['spring', 'summer', 'autumn', 'winter']) {
        for (const detail of [0, 1, 2] as const) {
          const p = plan({ dayPhase, season, detail, mapW: 500, mapH: 500, homes: 500, litWindows: 500, waterTiles: 5000 });
          expect(total(p)).toBeLessThanOrEqual(MAX_CRITTERS);
        }
      }
    }
  });
  it('pools add up to no more than the hard cap', () => {
    const sum = Object.values(POOL_CAPS).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(MAX_CRITTERS);
  });
  it('tolerates a world that has not loaded yet', () => {
    const p = ambientPlan({ ...base, dayPhase: undefined, weather: undefined, season: undefined, mapW: 0, mapH: 0 });
    expect(total(p)).toBeGreaterThanOrEqual(0);
    expect(p.fountain).toBe(true);
  });
});

describe('wellCenter', () => {
  it('matches where BuildingRenderer draws the well (middle 32px cell + 16)', () => {
    // 256x160 square at (64, 96): cx = 64 + floor(128/32)*32 = 192; cy = 96 + floor(80/32)*32 = 160
    expect(wellCenter({ x: 64, y: 96, width: 256, height: 160 })).toEqual({ x: 208, y: 176 });
  });
});
