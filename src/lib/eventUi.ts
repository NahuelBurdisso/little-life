import { isWorldEventType, type WorldEventType } from '../../server/data/worldEventCatalog';

/**
 * Presentation for world events. Name, duration and effects live in the shared
 * catalog (server/data/worldEventCatalog.ts, pure data); only the glyph and the
 * one-line blurb are UI-side. Covers every catalog type, not just the ones the
 * player can start, because the Active list and the location panel show random and
 * system-started events too.
 */
export const EVENT_UI: Record<WorldEventType, { icon: string; blurb: string }> = {
  festival: { icon: '🎉', blurb: 'Everyone gathers for food and music!' },
  market_day: { icon: '🏪', blurb: 'Special prices at all shops.' },
  storm: { icon: '⛈️', blurb: 'Everyone heads indoors.' },
  sickness: { icon: '🤒', blurb: 'Energy drains faster.' },
  harvest: { icon: '🌾', blurb: 'Farm production doubles!' },
  scandal: { icon: '🗞️', blurb: 'Rumors spread twice as fast; the town is on edge.' },
  blessing: { icon: '🌤️', blurb: "Everyone's mood lifts." },
  traveling_merchant: { icon: '🧳', blurb: 'Rare wares, slightly cheaper prices.' },
  town_meeting: { icon: '📣', blurb: 'The town gathers to talk.' },
  wedding: { icon: '💒', blurb: 'A celebration, and romance in the air.' },
  fire_outbreak: { icon: '🔥', blurb: 'Neighbours rush to help.' },
  mysterious_stranger: { icon: '🕵️', blurb: 'Gossip travels twice as fast.' },
  competition: { icon: '🏆', blurb: 'A friendly contest lifts spirits.' },
  full_moon: { icon: '🌕', blurb: 'Romance and mischief after dark.' },
  heatwave: { icon: '🥵', blurb: 'Energy drains faster; everyone seeks shade.' },
  bountiful_catch: { icon: '🎣', blurb: 'The river is teeming with fish.' },
  starry_night: { icon: '✨', blurb: 'A clear sky lifts spirits outdoors.' },
  // The town calendar (server/data/calendar.ts): same glyphs as the TopBar chip.
  spring_fair: { icon: '🌸', blurb: 'Stalls, a maypole and the ploughing match on the square.' },
  midsummer: { icon: '🔥', blurb: 'A bonfire, dancing and the singing contest.' },
  harvest_festival: { icon: '🎃', blurb: 'The harvest supper, cheap food and the pie contest.' },
  winter_lights: { icon: '🕯', blurb: 'Lanterns, carols and the baking contest.' },
  election_day: { icon: '🗳', blurb: 'The votes for mayor are counted on the square.' },
  funeral: { icon: '🕯️', blurb: 'The town gathers to mourn.' },
  new_arrival: { icon: '🧭', blurb: 'Someone new has moved to town.' },
};

/** Icon for a stored event type; unknown types (older rows) get a neutral star. */
export function eventIcon(type: string): string {
  return isWorldEventType(type) ? EVENT_UI[type].icon : '⭐';
}

export function eventBlurb(type: string, fallback = ''): string {
  return isWorldEventType(type) ? EVENT_UI[type].blurb : fallback;
}

/** Game minutes as "2h 15m left" / "40 min left". */
export function formatTimeLeft(minutes: number): string {
  const m = Math.ceil(minutes);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}h left` : `${h}h ${rest}m left`;
}

/**
 * Where the canvas should look when the player starts an event. The server row for a
 * player event has no location, so pick the place the event is about: the square for
 * gatherings, the farm for a harvest, the clinic for the flu. Falls back to the town
 * square (then null) so the camera never pans to nothing.
 */
const EVENT_FOCUS_TYPES: Partial<Record<WorldEventType, string[]>> = {
  market_day: ['market_square', 'town_square'],
  harvest: ['farm'],
  sickness: ['clinic', 'town_square'],
};

export function eventFocusLocation(
  type: string,
  locations: ReadonlyArray<{ id: number; type: string }>,
): number | null {
  const prefs = (isWorldEventType(type) ? EVENT_FOCUS_TYPES[type] : undefined) ?? [];
  for (const t of [...prefs, 'town_square']) {
    const hit = locations.find((l) => l.type === t);
    if (hit) return hit.id;
  }
  return null;
}
