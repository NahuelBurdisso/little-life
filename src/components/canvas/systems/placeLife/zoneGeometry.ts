import { INTERIOR_ZONES } from "../../../../../server/data/interiors";

/**
 * Where a building's named zones are in the world. The interior data is authored in tiles
 * relative to the building's top-left corner, so a zone's world rect is that corner plus the
 * zone's rect. Pure — the place effects hang glows on the forge, the oven and the stage, and
 * the state code asks who is standing in the crop field, without touching PixiJS.
 */

const TILE = 32;

export interface Rect { x: number; y: number; width: number; height: number }
export interface Pt { x: number; y: number }

interface LocLike { type: string; position: Rect }

function zoneOf(loc: LocLike, zoneId: string) {
  return INTERIOR_ZONES[loc.type]?.find((z) => z.id === zoneId) ?? null;
}

/** World rect of a zone (its tiles plus the tile agents stand on), or null when it has none. */
export function zoneRect(loc: LocLike, zoneId: string): Rect | null {
  const z = zoneOf(loc, zoneId);
  if (!z || !loc.position) return null;
  const r = z.relativePosition;
  return { x: loc.position.x + r.x, y: loc.position.y + r.y, width: r.width, height: r.height };
}

/** Middle of the tile a piece of furniture stands on; the zone's centre tile when it has none. */
export function furnitureSpot(loc: LocLike, zoneId: string): Pt | null {
  const z = zoneOf(loc, zoneId);
  if (!z || !loc.position) return null;
  const [col, row] = z.furniture ? z.furniture.tile : z.center;
  return { x: loc.position.x + col * TILE + TILE / 2, y: loc.position.y + row * TILE + TILE / 2 };
}

export function rectCenter(r: Rect): Pt {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Whether (x, y) lies in `r` grown by `pad` px on every side. */
export function inRect(r: Rect, x: number, y: number, pad = 0): boolean {
  return x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad;
}
