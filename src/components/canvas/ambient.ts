// Pure ambient-light model for LightingSystem. Kept free of pixi imports so it
// can be unit-tested under vitest without a renderer.

export interface AmbientProfile {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

export const PHASE_AMBIENT: Record<string, AmbientProfile> = {
  dawn:      { r: 255, g: 212, b: 160, brightness: 0.65 },
  morning:   { r: 255, g: 248, b: 240, brightness: 0.95 },
  afternoon: { r: 255, g: 250, b: 230, brightness: 1.0 },
  evening:   { r: 255, g: 160, b: 96,  brightness: 0.55 },
  night:     { r: 100, g: 110, b: 150, brightness: 0.45 },
};

const SEASON_TINT: Record<string, { r: number; g: number; b: number; mix: number }> = {
  spring: { r: 224, g: 255, b: 224, mix: 0.05 },
  summer: { r: 255, g: 250, b: 224, mix: 0.03 },
  autumn: { r: 255, g: 224, b: 160, mix: 0.08 },
  winter: { r: 208, g: 232, b: 255, mix: 0.10 },
};

export interface WeatherMod {
  brightnessMul: number;
  radiusMul: number;
  flickerMul: number;
  tintR?: number;
  tintG?: number;
  tintB?: number;
  tintMix?: number;
}

export const WEATHER_MODS: Record<string, WeatherMod> = {
  sunny:  { brightnessMul: 1.0,  radiusMul: 1.0, flickerMul: 1.0 },
  cloudy: { brightnessMul: 0.85, radiusMul: 1.0, flickerMul: 1.0 },
  rainy:  { brightnessMul: 0.7,  radiusMul: 0.9, flickerMul: 1.5, tintR: 180, tintG: 200, tintB: 230, tintMix: 0.06 },
  stormy: { brightnessMul: 0.5,  radiusMul: 0.85, flickerMul: 2.0 },
  foggy:  { brightnessMul: 0.75, radiusMul: 0.6, flickerMul: 0.5, tintR: 200, tintG: 200, tintB: 210, tintMix: 0.1 },
  snowy:  { brightnessMul: 0.8,  radiusMul: 0.8, flickerMul: 0.8, tintR: 220, tintG: 230, tintB: 255, tintMix: 0.08 },
  windy:  { brightnessMul: 0.9,  radiusMul: 1.0, flickerMul: 2.5 },
  hot:    { brightnessMul: 1.0,  radiusMul: 1.0, flickerMul: 1.2, tintR: 255, tintG: 240, tintB: 200, tintMix: 0.04 },
};

export function weatherMod(weather: string): WeatherMod {
  return WEATHER_MODS[weather] ?? WEATHER_MODS.sunny;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The ambient colour the lightmap should settle on: day-phase base, nudged by
 * the season's tint, then dimmed and tinted by the weather.
 */
export function computeAmbient(phase: string, season: string, weather: string): AmbientProfile {
  const out = { ...(PHASE_AMBIENT[phase] ?? PHASE_AMBIENT.morning) };

  const st = SEASON_TINT[season];
  if (st) {
    out.r = lerp(out.r, st.r, st.mix);
    out.g = lerp(out.g, st.g, st.mix);
    out.b = lerp(out.b, st.b, st.mix);
  }

  const wm = weatherMod(weather);
  out.brightness *= wm.brightnessMul;
  if (wm.tintR != null && wm.tintG != null && wm.tintB != null && wm.tintMix != null) {
    out.r = lerp(out.r, wm.tintR, wm.tintMix);
    out.g = lerp(out.g, wm.tintG, wm.tintMix);
    out.b = lerp(out.b, wm.tintB, wm.tintMix);
  }

  return out;
}

// ─── Transition timing ───────────────────────────────────────────────────────
//
// All in Pixi ticker units: `ticker.deltaTime` is 1 for one 60 fps frame, 2 at
// 30 fps, 0.5 at 120 fps. The transition used to step a fixed `+0.016` per
// frame (and fed that back into a compounding lerp), so on a 144 Hz display a
// phase change finished in under half a second and on a struggling 30 fps
// machine it took two.

/** A full ambient transition lasts this many 60 fps frames (~1 s). */
export const AMBIENT_TRANSITION_FRAMES = 60;

export function advanceTransition(progress: number, deltaFrames: number): number {
  return Math.min(1, progress + Math.max(0, deltaFrames) / AMBIENT_TRANSITION_FRAMES);
}

/**
 * Eased blend from the ambient at the start of the transition to the target,
 * written into `out` (called every frame — no allocation). Tweening from a
 * fixed `from` is what makes it frame-rate independent: the result depends only
 * on elapsed time, not on how many frames it was split into.
 */
export function blendAmbient(
  from: AmbientProfile,
  to: AmbientProfile,
  progress: number,
  out: AmbientProfile,
): void {
  const t = Math.max(0, Math.min(1, progress));
  const e = t * t * (3 - 2 * t); // smoothstep
  out.r = lerp(from.r, to.r, e);
  out.g = lerp(from.g, to.g, e);
  out.b = lerp(from.b, to.b, e);
  out.brightness = lerp(from.brightness, to.brightness, e);
}

/**
 * Probability that an event with chance `perFrame` per 60 fps frame happens
 * during a frame of `deltaFrames`, so lightning strikes as often per second at
 * any refresh rate.
 */
export function chanceOverDelta(perFrame: number, deltaFrames: number): number {
  return 1 - Math.pow(1 - perFrame, Math.max(0, deltaFrames));
}

/**
 * Identity of the inputs to `computeAmbient`. The target used to be recomputed
 * only when the day phase changed, so a weather change (or a season rollover)
 * mid-phase left the old light in place for up to a quarter of a game day —
 * setting a storm at noon kept full sunshine until evening. Every input goes
 * in the key so any of them starts a new transition.
 */
export function ambientKey(phase: string, season: string, weather: string): string {
  return `${phase}|${season}|${weather}`;
}
