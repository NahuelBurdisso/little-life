/**
 * Layout rules for the floating tools strip: when it folds into an icon rail,
 * what the player chose last time, and how much room overlays must leave for it.
 * Pure (storage passed in) so the rules are testable without a DOM.
 */

/** Same "little-life:<thing>:<flag>" shape as the cast bar's collapsed flag. */
export const TOOLBAR_COLLAPSED_KEY = "little-life:toolbar:collapsed";

/**
 * Below this viewport width the strip starts folded: at 1280 the expanded
 * strip (w-44) hid ~20% of a map that is already only ~1000px wide.
 */
export const AUTO_COLLAPSE_BELOW = 1400;

/** Space overlays centred on the map keep clear at the right edge, in px. */
export const TOOLBAR_RAIL_CLEARANCE = 56;
export const TOOLBAR_OPEN_CLEARANCE = 208;

/**
 * The player's explicit choice wins; with none stored the strip follows the
 * viewport width.
 */
export function resolveToolbarCollapsed(pref: boolean | null, viewportWidth: number): boolean {
  return pref ?? viewportWidth < AUTO_COLLAPSE_BELOW;
}

export function toolbarClearance(collapsed: boolean): number {
  return collapsed ? TOOLBAR_RAIL_CLEARANCE : TOOLBAR_OPEN_CLEARANCE;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** null = never chosen (follow the viewport). Storage can throw (private mode, blocked site data). */
export function readToolbarPref(storage?: Storage): boolean | null {
  try {
    const raw = (storage ?? localStorage).getItem(TOOLBAR_COLLAPSED_KEY);
    return raw === "1" ? true : raw === "0" ? false : null;
  } catch {
    return null;
  }
}

export function writeToolbarPref(collapsed: boolean, storage?: Storage): void {
  try {
    (storage ?? localStorage).setItem(TOOLBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Not remembered; the strip still works for this session.
  }
}
