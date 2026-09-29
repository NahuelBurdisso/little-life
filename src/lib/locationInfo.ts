import { isOpenAt, type OperatingHours } from '../../server/lib/gameClock';

/**
 * Pure helpers behind the canvas building click and the LocationPanel. Kept free of
 * React and Pixi so the geometry and the open/closed wording are unit-testable.
 */

export interface LocationLike {
  id: number;
  name: string;
  type: string;
  position: { x: number; y: number; width: number; height: number };
  operating_hours?: OperatingHours | null;
}

/**
 * The location under a world-pixel point. Open areas (Main Street, the town square)
 * can enclose smaller buildings, so the smallest footprint wins — clicking a shop
 * on Main Street selects the shop, not the street. Null on bare ground.
 */
export function locationAt<T extends LocationLike>(x: number, y: number, locations: readonly T[]): T | null {
  let best: T | null = null;
  let bestArea = Infinity;
  for (const loc of locations) {
    const p = loc.position;
    if (!p) continue;
    if (x < p.x || x >= p.x + p.width || y < p.y || y >= p.y + p.height) continue;
    const area = p.width * p.height;
    if (area < bestArea) {
      best = loc;
      bestArea = area;
    }
  }
  return best;
}

const TYPE_ICON: Record<string, string> = {
  town_square: '⛲',
  market_square: '🧺',
  mainstreet: '🛣️',
  alley: '🐈',
  farm: '🌾',
  farmyard: '🐔',
  park: '🌳',
  town_hall: '🏛️',
  tavern: '🍺',
  divebar: '🍸',
  bakery: '🥖',
  clinic: '⚕️',
  pawnshop: '💍',
  prison: '⛓️',
  shop: '🛒',
  workshop: '🔨',
  home: '🏠',
};

export function locationIcon(type: string): string {
  return TYPE_ICON[type] ?? '📍';
}

/** "town_hall" -> "Town Hall" */
export function prettyLocationType(type: string): string {
  return type.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * A place name for display. Homes are stored as "the Fernandez house" (`homeNames.ts`)
 * because the prompts and action text embed them mid-sentence ("I'll pop over to the
 * Fernandez house"), so the stored string must stay lowercase. But a map label, panel
 * title or menu row starts with the name, where a lowercase "the" reads as a typo.
 * Pass `sentenceStart` there; mid-sentence uses ("Sleeping at …", toasts) keep the
 * raw name. Only the first letter changes — "Marco Rivera's house" and shop names are
 * returned as they are.
 */
export function displayPlaceName(name: string, opts: { sentenceStart?: boolean } = {}): string {
  if (!opts.sentenceStart || !name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const hh = (h: number) => `${String(Math.floor(h) % 24).padStart(2, '0')}:00`;

/**
 * "09:00–17:00" plus whether it is open at `hour` (the world clock's hour). Places
 * without hours are always open. Overnight ranges (the Dive) go through `isOpenAt`,
 * which handles the wrap.
 */
export function hoursSummary(
  hours: OperatingHours | null | undefined,
  hour: number,
): { range: string; open: boolean } {
  const open = isOpenAt(hours, hour);
  return { range: hours ? `${hh(hours.open)}–${hh(hours.close)}` : 'Open all day', open };
}
