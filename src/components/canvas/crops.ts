/**
 * Crop rows through the year. The farm's two fields used to share one summer texture all
 * twelve months; now the tile follows the season and how far into it the town is.
 *
 * Pure — the renderer (TilemapRenderer) slices `/sprites/tiles/crops.png`, built by
 * scripts/aseprite/place-life.lua, and picks a cell with `cropCell`. Cells run spring, summer,
 * autumn, winter with three growth stages each, so the last stage of a season is the visible
 * lead-in to the next: seedlings, then flowering rows, then ripe gold, then snow.
 */

export const CROP_URL = '/sprites/tiles/crops.png';
export const CROP_TILE_SIZE = 32;
export const STAGES_PER_SEASON = 3;
export const CROP_STAGE_COUNT = 4 * STAGES_PER_SEASON;

/**
 * Days per season. Mirrors CONFIG.TIME.SEASON_LENGTH_DAYS (server/lib/constants.ts), which
 * cannot be imported here: that module reads `process.env` and this one ships to the browser.
 */
export const SEASON_LENGTH_DAYS = 28;

const SEASON_ORDER = ['spring', 'summer', 'autumn', 'winter'] as const;

/**
 * Cell of the crop strip for a season and the day within it (0-based). Unknown seasons read
 * as summer — the look every world had before this existed — and a missing day counts as the
 * middle of the season rather than its first morning.
 */
export function cropCell(season: unknown, seasonDay?: number | null): number {
  const idx = SEASON_ORDER.indexOf(season as typeof SEASON_ORDER[number]);
  const s = idx < 0 ? 1 : idx;
  const day = typeof seasonDay === 'number' && Number.isFinite(seasonDay)
    ? Math.max(0, Math.min(SEASON_LENGTH_DAYS - 1, Math.floor(seasonDay)))
    : Math.floor(SEASON_LENGTH_DAYS / 2);
  const stage = Math.min(STAGES_PER_SEASON - 1, Math.floor((day / SEASON_LENGTH_DAYS) * STAGES_PER_SEASON));
  return s * STAGES_PER_SEASON + stage;
}

/**
 * Day within the current season from a world clock row (`{ seasonDay, day }`): the stored
 * `seasonDay` when the server sends it, otherwise derived from the absolute day (seasons
 * are back to back from day 0). Undefined when the clock has neither.
 */
export function seasonDayOf(time: { seasonDay?: number; day?: number } | null | undefined): number | undefined {
  if (typeof time?.seasonDay === 'number') return time.seasonDay;
  if (typeof time?.day === 'number') return ((time.day % SEASON_LENGTH_DAYS) + SEASON_LENGTH_DAYS) % SEASON_LENGTH_DAYS;
  return undefined;
}
