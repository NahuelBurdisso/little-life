import { db } from '../db';
import { worldState } from '../db/schema';
import { AUTOPLAY_DEFAULTS, CONFIG } from './constants';

/**
 * Autoplay's switch, nudge threshold and window are per WORLD, not per process.
 *
 * `CONFIG.AUTOPLAY` is a plain in-memory object the autoplay router mutates, so
 * the Storyteller's Chaos preset (which turns the watcher on with a threshold of
 * 35) was lost on every restart: the town came back with drama still at
 * "chaos" in `rule_overrides` but autoplay off, and the panel read "Custom".
 *
 * The copy lives in `world_state.rule_overrides` under `autoplay`, next to the
 * rule overrides it belongs with (both are things the player changed on the
 * running town, both drop with a world replace and travel with a save). No new
 * column, so none of the schema/`addColumnIfMissing` bookkeeping. The rules
 * reader ignores keys it does not know, and `setRuleOverrides` carries this one
 * through its merges.
 */

export interface AutoplaySettings {
  enabled: boolean;
  autoNudge: boolean;
  boredomThreshold: number;
  windowMinutes: number;
  maxNudgesPerDay: number;
}

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

/** Keep only the well-formed keys of a stored blob; the rest read as the defaults. */
export function parseAutoplaySettings(raw: unknown): Partial<AutoplaySettings> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<AutoplaySettings> = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (typeof r.autoNudge === 'boolean') out.autoNudge = r.autoNudge;
  // Same bounds as `autoplay.configure`.
  const threshold = num(r.boredomThreshold, 0, 100);
  if (threshold !== undefined) out.boredomThreshold = threshold;
  const windowMinutes = num(r.windowMinutes, 10, 300);
  if (windowMinutes !== undefined) out.windowMinutes = windowMinutes;
  const maxNudges = num(r.maxNudgesPerDay, 0, 20);
  if (maxNudges !== undefined) out.maxNudgesPerDay = maxNudges;
  return out;
}

/**
 * Point `CONFIG.AUTOPLAY` at the current world's saved settings, or at the
 * shipped defaults when it has none (a fresh or replaced world, a pre-feature
 * save). Called by `restoreWorldCaches`, i.e. at boot and after every world
 * swap. Never throws: a DB that is not ready yet just means defaults.
 */
export function loadAutoplayConfig(): void {
  let saved: Partial<AutoplaySettings> = {};
  try {
    const row = db.select({ rule_overrides: worldState.rule_overrides }).from(worldState).limit(1).get();
    saved = parseAutoplaySettings(row?.rule_overrides?.autoplay);
  } catch { /* no world table yet: defaults */ }
  const c = CONFIG.AUTOPLAY;
  c.ENABLED = saved.enabled ?? AUTOPLAY_DEFAULTS.ENABLED;
  c.AUTO_NUDGE = saved.autoNudge ?? AUTOPLAY_DEFAULTS.AUTO_NUDGE;
  c.BOREDOM_THRESHOLD = saved.boredomThreshold ?? AUTOPLAY_DEFAULTS.BOREDOM_THRESHOLD;
  c.WINDOW_MINUTES = saved.windowMinutes ?? AUTOPLAY_DEFAULTS.WINDOW_MINUTES;
  c.MAX_NUDGES_PER_DAY = saved.maxNudgesPerDay ?? AUTOPLAY_DEFAULTS.MAX_NUDGES_PER_DAY;
}

/**
 * Save the live `CONFIG.AUTOPLAY` into the world row. A no-op without a world
 * (nothing to attach it to; the in-memory value still applies until then).
 * Only the player-facing knobs are stored: `HISTORY_WINDOWS` is a code constant.
 */
export function persistAutoplayConfig(): void {
  const row = db.select({ id: worldState.id, rule_overrides: worldState.rule_overrides }).from(worldState).limit(1).get();
  if (!row) return;
  const c = CONFIG.AUTOPLAY;
  const autoplay: AutoplaySettings = {
    enabled: c.ENABLED,
    autoNudge: c.AUTO_NUDGE,
    boredomThreshold: c.BOREDOM_THRESHOLD,
    windowMinutes: c.WINDOW_MINUTES,
    maxNudgesPerDay: c.MAX_NUDGES_PER_DAY,
  };
  db.update(worldState).set({ rule_overrides: { ...(row.rule_overrides ?? {}), autoplay } }).run();
}
