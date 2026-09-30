/**
 * The "Cinematic moments" display preference: whether the screen may fade to black while a
 * couple the player is watching spends the night together (components/ui/FadeToBlack.tsx).
 * On by default; a per-viewer convenience like the toolbar fold, so it lives in localStorage,
 * which throws in private windows and with blocked site data.
 */

export const CINEMATIC_KEY = "little-life:cinematic";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function readCinematic(storage?: Storage): boolean {
  try {
    return (storage ?? localStorage).getItem(CINEMATIC_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeCinematic(on: boolean, storage?: Storage): void {
  try {
    (storage ?? localStorage).setItem(CINEMATIC_KEY, on ? "1" : "0");
  } catch {
    // Not remembered; the choice still holds for this session.
  }
}
