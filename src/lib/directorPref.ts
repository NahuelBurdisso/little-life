/**
 * Whether Director mode (the auto-cutting camera) is on. It used to start off, so
 * a new player watched a static map while the interesting scene was three tiles
 * away; now it defaults ON and only a stored "0" turns it off. The choice
 * persists per browser. Every storage access is guarded: it can throw in a
 * private window or with blocked site data, and the page must still work.
 */
export const DIRECTOR_KEY = 'little-life:director-on';

export function loadDirectorOn(storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(DIRECTOR_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveDirectorOn(on: boolean, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(DIRECTOR_KEY, on ? '1' : '0');
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
