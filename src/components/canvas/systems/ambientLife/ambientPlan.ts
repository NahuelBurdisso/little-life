/**
 * What ambient life the town should hold right now. Pure — no PixiJS — so every rule is
 * unit tested. The system keeps its critter pools at these counts (retiring the surplus,
 * spawning the deficit near the view); this module only answers "how many of each".
 *
 * The art bible keeps terrain as background and decoration has to earn its pixels, so the
 * numbers are deliberately small: a handful of birds, a cat or two, a few moths. Fireflies
 * were cut from the bible and are not planned here.
 */

/** Hard ceiling on live critters, whatever the world looks like. */
export const MAX_CRITTERS = 40;

/** Pool size per kind — also the most the plan ever asks for. Sums to <= MAX_CRITTERS. */
export const POOL_CAPS = {
  birds: 10,
  butterflies: 8,
  moths: 6,
  cats: 4,
  ducks: 4,
} as const;

export interface AmbientInputs {
  /** 'dawn' | 'morning' | 'afternoon' | 'evening' | 'night' (undefined until the world loads). */
  dayPhase?: string;
  /** WeatherType: sunny, cloudy, rainy, stormy, foggy, snowy, windy, hot. */
  weather?: string;
  season?: string;
  /** Map size in tiles. */
  mapW: number;
  mapH: number;
  /** `detailLevel(view.scale)`: 0 far, 1 normal, 2 close. */
  detail: 0 | 1 | 2;
  /** Locations of type 'home'. */
  homes: number;
  /** Lit windows on occupied homes (night moths gather round these). */
  litWindows: number;
  /** Water terrain tiles (none exist today; worldgen may add ponds later). */
  waterTiles: number;
}

export interface AmbientPlan {
  birds: number;
  butterflies: number;
  moths: number;
  cats: number;
  ducks: number;
  /** The town-square well splash — the one thing that survives the far zoom. */
  fountain: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Scale a count, but never round a wanted critter down to nothing. */
const scaled = (n: number, k: number) => (n <= 0 ? 0 : Math.max(1, Math.round(n * k)));

// Weather that keeps birds and butterflies in.
const WET = new Set(['rainy', 'stormy', 'snowy', 'foggy']);
// Butterflies also need calm air: wind tears them about.
const NO_BUTTERFLIES = new Set([...WET, 'windy']);

/**
 * At close zoom the view holds few tiles, and critters are spawned inside the view, so the
 * same headcount would crowd the screen. Density per screen is what matters.
 */
const CLOSE_ZOOM_DENSITY = 0.6;

export function ambientPlan(i: AmbientInputs): AmbientPlan {
  const plan: AmbientPlan = { birds: 0, butterflies: 0, moths: 0, cats: 0, ducks: 0, fountain: true };
  // Far out a bird is a stray pixel: nothing but the fountain.
  if (i.detail === 0) return plan;

  const phase = i.dayPhase ?? 'morning';
  const weather = i.weather ?? 'sunny';
  const season = i.season ?? 'spring';
  const daylight = phase === 'dawn' || phase === 'morning' || phase === 'afternoon';
  const night = phase === 'night';
  const density = i.detail === 2 ? CLOSE_ZOOM_DENSITY : 1;
  const area = Math.max(0, i.mapW) * Math.max(0, i.mapH);
  const span = Math.sqrt(area);

  // Birds: peck by day, a few linger at dusk, none in wet weather; winter thins them.
  if ((daylight || phase === 'evening') && !WET.has(weather) && span > 0) {
    let n = clamp(Math.round(span / 4), 3, POOL_CAPS.birds);
    if (phase === 'evening') n *= 0.5;
    if (season === 'winter') n *= 0.5;
    plan.birds = Math.min(POOL_CAPS.birds, scaled(n, density));
  }

  // Butterflies: warm, calm, sunlit — spring and summer, mid-day only.
  if ((season === 'spring' || season === 'summer') && (phase === 'morning' || phase === 'afternoon')
      && !NO_BUTTERFLIES.has(weather) && span > 0) {
    plan.butterflies = Math.min(POOL_CAPS.butterflies,
      scaled(clamp(Math.round(span / 6), 2, POOL_CAPS.butterflies), density));
  }

  // Moths: one per lit window at night, none in rain, snow or the winter cold.
  if (night && season !== 'winter' && weather !== 'rainy' && weather !== 'stormy' && weather !== 'snowy') {
    plan.moths = clamp(Math.floor(i.litWindows), 0, POOL_CAPS.moths);
  }

  // Cats: one per four homes (a small town still gets one), half asleep at night,
  // indoors when it pours.
  if (i.homes >= 2 && weather !== 'rainy' && weather !== 'stormy') {
    let n = Math.max(1, Math.floor(i.homes / 4));
    if (night) n = Math.ceil(n / 2);
    plan.cats = Math.min(POOL_CAPS.cats, n);
  }

  // Ducks: on open water by day, not through a storm or on winter ice.
  if (i.waterTiles >= 4 && !night && weather !== 'stormy' && season !== 'winter') {
    plan.ducks = clamp(Math.floor(i.waterTiles / 8), 1, POOL_CAPS.ducks);
  }

  // Belt and braces: the per-kind caps already sum below the ceiling.
  let over = plan.birds + plan.butterflies + plan.moths + plan.cats + plan.ducks - MAX_CRITTERS;
  for (const k of ['birds', 'butterflies', 'ducks', 'moths', 'cats'] as const) {
    if (over <= 0) break;
    const cut = Math.min(plan[k], over);
    plan[k] -= cut;
    over -= cut;
  }
  return plan;
}

/**
 * Centre of the town-square well, in world pixels. Mirrors `addOpenArea` in
 * BuildingRenderer (which is off limits to this feature): the well sits on the 32px cell
 * nearest the middle of the square, and its basin is centred 16px into that cell.
 */
export function wellCenter(pos: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return {
    x: pos.x + Math.floor(pos.width / 2 / 32) * 32 + 16,
    y: pos.y + Math.floor(pos.height / 2 / 32) * 32 + 16,
  };
}
