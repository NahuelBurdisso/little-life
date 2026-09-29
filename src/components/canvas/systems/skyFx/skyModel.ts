/**
 * Pure model behind the sky system (cloud shadows, shooting stars, and the soft light/mist that
 * dresses a few events): no PixiJS, so all of it is unit tested. The renderer only turns these
 * numbers into sprites.
 */

import { eventAnchorRect, strangerSpot, type MapPx, type Rect, type RoadTile } from "../townEvents/eventDecor";
import type { ViewRect } from "../view";

// ── Deterministic random ────────────────────────────────────────────────────────────────────

/** mulberry32: a tiny seeded generator, so a map always gets the same clouds. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Move `current` toward `target` at `rate` per second, frame-rate independent. */
export function easeToward(current: number, target: number, seconds: number, rate: number): number {
  const k = 1 - Math.exp(-Math.max(0, seconds) * rate);
  return current + (target - current) * k;
}

// ── Cloud shadows ───────────────────────────────────────────────────────────────────────────

/** One lobe of a cloud, as fractions of the cloud's size around its centre. */
export interface CloudLobe { ox: number; oy: number; sx: number; sy: number }

export interface Cloud {
  /** Centre, world px. */
  x: number;
  y: number;
  /** Overall size of the shadow, world px. */
  w: number;
  h: number;
  /** Drift, px per second. */
  vx: number;
  vy: number;
  lobes: readonly CloudLobe[];
}

export const CLOUD_COUNT = 4;

/**
 * A few big soft shadows spread over the map, all drifting the same way (they are one weather
 * front) at slightly different speeds. Each is three overlapping lobes so the outline is a lump,
 * not an ellipse.
 */
export function makeClouds(map: MapPx, count = CLOUD_COUNT): Cloud[] {
  const rand = seededRandom(Math.imul(map.w | 0, 73856093) ^ Math.imul(map.h | 0, 19349663));
  const clouds: Cloud[] = [];
  for (let i = 0; i < count; i++) {
    const w = 380 + rand() * 200;
    const h = w * (0.5 + rand() * 0.18);
    clouds.push({
      x: (map.w * (i + 0.3 + rand() * 0.4)) / count,
      y: map.h * (0.1 + rand() * 0.8),
      w, h,
      vx: 11 + rand() * 6,
      vy: 3 + rand() * 3,
      lobes: [
        { ox: 0, oy: 0, sx: 1, sy: 1 },
        { ox: -0.32, oy: 0.14, sx: 0.62, sy: 0.72 },
        { ox: 0.3 + rand() * 0.05, oy: -0.12, sx: 0.66, sy: 0.8 },
      ],
    });
  }
  return clouds;
}

/** Drift a cloud; once fully past the map's far edge it re-enters from the near one. */
export function stepCloud(c: Cloud, seconds: number, map: MapPx): void {
  c.x += c.vx * seconds;
  c.y += c.vy * seconds;
  if (c.x - c.w * 0.6 > map.w) c.x = -c.w * 0.6;
  if (c.y - c.h * 0.6 > map.h) c.y = -c.h * 0.6;
}

/** Whether any part of the cloud can be on screen. */
export function cloudInView(c: Cloud, v: ViewRect): boolean {
  const hw = c.w * 0.75, hh = c.h * 0.75;
  return c.x + hw >= v.x && c.x - hw <= v.x + v.w && c.y + hh >= v.y && c.y - hh <= v.y + v.h;
}

/** How dark the shadows are in a weather: only a broken sky casts them. */
export function cloudShadowStrength(weather: string): number {
  if (weather === "cloudy") return 0.2;
  if (weather === "windy") return 0.09;
  return 0;
}

/** Shadows need sun: full by day, gentle at the edges of it, none at night. */
export function daylightFactor(phase: string): number {
  switch (phase) {
    case "morning": case "afternoon": return 1;
    case "dawn": return 0.5;
    case "evening": return 0.6;
    default: return 0;
  }
}

// ── Shooting stars ──────────────────────────────────────────────────────────────────────────

export interface Star {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  /** Screen px → world px factor at the moment it spawned (1 / zoom), so it looks the same at any zoom. */
  k: number;
  angle: number;
}

export function newStar(): Star {
  return { active: false, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0, k: 1, angle: 0 };
}

export const STAR_SPEED = 520;         // screen px per second
export const STAR_LENGTH = 110;        // screen px, head to tail

/** Seconds until the next star: they should feel like an occasional gift, not a screensaver. */
export function nextStarDelay(rand: () => number): number {
  return 3.5 + rand() * 5.5;
}

/** Fill `s` with a fresh star crossing the upper part of the view, heading right and down. */
export function spawnStar(view: ViewRect, rand: () => number, s: Star): void {
  const k = 1 / Math.max(0.05, view.scale);
  const angle = 0.3 + rand() * 0.4;                       // 17-40 degrees below horizontal
  const speed = STAR_SPEED * (0.85 + rand() * 0.4) * k;
  s.active = true;
  s.k = k;
  s.angle = angle;
  s.x = view.x + view.w * (0.04 + rand() * 0.55);
  s.y = view.y + view.h * (0.03 + rand() * 0.35);
  s.vx = Math.cos(angle) * speed;
  s.vy = Math.sin(angle) * speed;
  s.age = 0;
  s.life = 0.55 + rand() * 0.3;
}

/** Advance; returns the star's brightness 0..1 (0 once it is finished and deactivated). */
export function stepStar(s: Star, seconds: number): number {
  if (!s.active) return 0;
  s.age += seconds;
  s.x += s.vx * seconds;
  s.y += s.vy * seconds;
  if (s.age >= s.life) { s.active = false; return 0; }
  // Quick flare in, long fade out: a real meteor is brightest just after it ignites.
  const u = s.age / s.life;
  return Math.min(1, u / 0.12) * (1 - u) ** 0.7;
}

// ── Event atmosphere ────────────────────────────────────────────────────────────────────────

export type SkyPiece =
  | { kind: "moon"; eventId: number; rect: Rect }
  | { kind: "shafts"; eventId: number; rect: Rect }
  | { kind: "mist"; eventId: number; x: number; y: number };

/**
 * The soft effects the active events want, anchored where the decor puts them: a silver halo over
 * the square for a full moon, shafts of gold light for a blessing, mist about the stranger. An
 * event type is drawn once (a second festival would stack, so a second moon would too).
 */
export function planSky(
  events: readonly any[] | null | undefined,
  locations: any[],
  map: MapPx | null,
  roads?: readonly RoadTile[] | null,
): SkyPiece[] {
  const out: SkyPiece[] = [];
  const seen = new Set<string>();
  for (const e of events ?? []) {
    if (!e || typeof e.type !== "string" || seen.has(e.type)) continue;
    const eventId = Number.isFinite(e.id) ? (e.id as number) : 0;
    if (e.type === "full_moon" || e.type === "blessing") {
      const rect = eventAnchorRect(e, locations, map);
      if (!rect) continue;
      seen.add(e.type);
      out.push({ kind: e.type === "full_moon" ? "moon" : "shafts", eventId, rect });
    } else if (e.type === "mysterious_stranger") {
      const spot = strangerSpot(locations, map, roads);
      if (!spot) continue;
      seen.add(e.type);
      out.push({ kind: "mist", eventId, x: spot.x, y: spot.y });
    }
  }
  return out;
}

/** Whether the event list holds a starry night (the sky system schedules shooting stars). */
export function hasStarryNight(events: readonly any[] | null | undefined): boolean {
  return (events ?? []).some(e => e?.type === "starry_night");
}
