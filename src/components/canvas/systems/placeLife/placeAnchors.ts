import { southWindowXs, WINDOW_CENTER_ABOVE_SOUTH_EDGE } from "../../BuildingRenderer";
import { furnitureSpot, rectCenter, zoneRect, type Pt, type Rect } from "./zoneGeometry";

/**
 * Where on (and around) a building each reactive detail sits, in world pixels.
 *
 * BuildingRenderer draws chimneys, signs, windows and doors from the same location rows with
 * private constants; the effects that hang on them have to land on the exact same pixels, so
 * the few sizes that are not exported are mirrored here and named after their source. Pure.
 */

interface LocLike { id?: number; type: string; position: Rect; entry_point: Pt }

// Mirrors BuildingRenderer.drawChimney: [width, height] of the chimney rect per type.
const CHIMNEY_SIZE: Record<string, readonly [number, number]> = {
  bakery: [6, 10],
  workshop: [4, 8],
};
const CHIMNEY_DEFAULT: readonly [number, number] = [5, 9];

/**
 * Centre of a chimney's cap (top-right of the building, 4px inset), where smoke and sparks
 * leave. Writes into `out` because the smoke emitters are refreshed from a per-frame loop.
 */
export function chimneyCap(loc: { type: string; position?: Rect }, out: Pt): boolean {
  const pos = loc.position;
  if (!pos?.width) return false;
  const [cw, ch] = CHIMNEY_SIZE[loc.type] ?? CHIMNEY_DEFAULT;
  out.x = pos.x + pos.width - cw - 4 + cw / 2;
  out.y = pos.y - ch + 2;
  return true;
}

// Mirrors BuildingRenderer.DOOR_STYLE widths.
const DOOR_WIDTH: Record<string, number> = {
  home: 10, shop: 12, tavern: 14, clinic: 10, town_hall: 16, bakery: 10, workshop: 12,
  prison: 10, pawnshop: 10, divebar: 12,
};

/** World centres of the windows on the south facade. */
export function windowCentres(loc: LocLike): Pt[] {
  const wy = loc.position.y + loc.position.height - WINDOW_CENTER_ABOVE_SOUTH_EDGE;
  return southWindowXs(loc).map((wx) => ({ x: Math.round(wx - 5) + 5, y: wy }));
}

/**
 * Foot of the hanging OPEN/CLOSED sign: on the wall beside the door, on whichever side keeps
 * clear of the windows (a sign over a window hides its light).
 */
export function signSpot(loc: LocLike): Pt {
  const { x, width } = loc.position;
  const ex = loc.entry_point.x;
  const half = (DOOR_WIDTH[loc.type] ?? 12) / 2;
  const windows = southWindowXs(loc);
  const clearance = (sx: number) => windows.reduce((m, wx) => Math.min(m, Math.abs(sx - wx)), Infinity);
  const inside = (sx: number) => sx >= x + 8 && sx <= x + width - 8;
  const candidates = [ex + half + 8, ex - half - 8].filter(inside);
  // A sign is 12px wide and a window 10: they touch below 11px between centres.
  let best = candidates.find((sx) => clearance(sx) >= 11);
  if (best === undefined) {
    best = candidates.reduce<number | undefined>((b, sx) => (b === undefined || clearance(sx) > clearance(b) ? sx : b), undefined);
  }
  return { x: Math.round(best ?? ex + half + 8), y: loc.entry_point.y + 1 };
}

/** Centre of the clinic's white cross above the door (BuildingRenderer.drawSign, 'clinic'). */
export function crossSpot(loc: LocLike): Pt {
  return { x: Math.round(loc.entry_point.x - 1), y: loc.position.y - 4 };
}

/** Where the chatter and music of a full tavern leaves the building: just above the door. */
export function doorSpot(loc: LocLike): Pt {
  return { x: loc.entry_point.x, y: loc.entry_point.y - 8 };
}

/** Foot of the town hall's flag pole, on the north eave, and of the bell's gallows. */
export function flagSpot(loc: LocLike): Pt {
  return { x: loc.position.x + 16, y: loc.position.y - 1 };
}
export function bellSpot(loc: LocLike): Pt {
  return { x: loc.position.x + loc.position.width - 28, y: loc.position.y - 1 };
}

/** Centre of the tavern stage, between the boards and the spot the performer stands on. */
export function stageSpot(loc: LocLike): Pt | null {
  const r = zoneRect(loc, 'stage');
  return r ? rectCenter(r) : null;
}

export function forgeSpot(loc: LocLike): Pt | null {
  return furnitureSpot(loc, 'forge');
}

export function ovenSpot(loc: LocLike): Pt | null {
  return furnitureSpot(loc, 'oven');
}

/** Roaming ground for the farm's chickens: the coop's tiles plus some yard around them. */
export function coopYard(loc: LocLike): Rect | null {
  const r = zoneRect(loc, 'coop');
  if (!r) return null;
  return { x: r.x - 6, y: r.y - 4, width: r.width + 12, height: r.height + 26 };
}

export function cropFields(loc: LocLike): Rect[] {
  const out: Rect[] = [];
  for (const id of ['crops_north', 'crops_south']) {
    const r = zoneRect(loc, id);
    if (r) out.push(r);
  }
  return out;
}
