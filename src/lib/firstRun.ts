/**
 * First-run guide bookkeeping: "Meet the town" and the coach marks each show once
 * per world seed, remembered in localStorage. Restart replays the saved seeds, so
 * it is not offered again; a new wizard run rolls new seeds and is.
 */

export type GuideTopic = 'tour' | 'coach';
export type GuidePhase = 'idle' | 'tour' | 'coach';

/** The slice of Storage this needs, so tests can pass a Map-backed fake. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Identity of the current world. There is no world id (a replace reseeds every
 * row from 1), but `setup.initialize` writes both the resolved worldgen seed and
 * the scenario seed into `setup_config`, and together they pick the town and its
 * cast. Null when the config carries neither: that world can't be recognised, so
 * nothing auto-opens (the buttons still work).
 */
export function worldSeedKey(setupConfig: unknown): string | null {
  if (!setupConfig || typeof setupConfig !== 'object') return null;
  const cfg = setupConfig as { worldgen?: { seed?: unknown }; scenario?: { seed?: unknown } };
  const world = typeof cfg.worldgen?.seed === 'string' ? cfg.worldgen.seed : '';
  const scenario = typeof cfg.scenario?.seed === 'string' ? cfg.scenario.seed : '';
  if (!world && !scenario) return null;
  return `${world}|${scenario}`;
}

/** Private windows and blocked site data make the accessor itself throw. */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function storageKey(topic: GuideTopic, worldKey: string): string {
  return `little-life.guide.${topic}.${worldKey}`;
}

export function hasSeen(topic: GuideTopic, worldKey: string, store: KeyValueStore | null = browserStore()): boolean {
  try {
    return store?.getItem(storageKey(topic, worldKey)) === '1';
  } catch {
    return false;
  }
}

export function markSeen(topic: GuideTopic, worldKey: string, store: KeyValueStore | null = browserStore()): void {
  try {
    store?.setItem(storageKey(topic, worldKey), '1');
  } catch {
    // Quota or blocked storage: the guide may show again next visit, which beats crashing.
  }
}

/** What to show when a world is first seen: the tour, else the marks, else nothing. */
export function initialPhase(worldKey: string, store: KeyValueStore | null = browserStore()): GuidePhase {
  if (!hasSeen('tour', worldKey, store)) return 'tour';
  if (!hasSeen('coach', worldKey, store)) return 'coach';
  return 'idle';
}

/** The tour was skipped, finished or a card was clicked: remember it, then the marks if unseen. */
export function phaseAfterTour(worldKey: string | null, store: KeyValueStore | null = browserStore()): GuidePhase {
  if (!worldKey) return 'idle';
  markSeen('tour', worldKey, store);
  return hasSeen('coach', worldKey, store) ? 'idle' : 'coach';
}

/** "Skip" on the tour means skip the whole introduction, coach marks included. */
export function phaseAfterSkip(worldKey: string | null, store: KeyValueStore | null = browserStore()): GuidePhase {
  if (worldKey) {
    markSeen('tour', worldKey, store);
    markSeen('coach', worldKey, store);
  }
  return 'idle';
}

export function phaseAfterCoach(worldKey: string | null, store: KeyValueStore | null = browserStore()): GuidePhase {
  if (worldKey) markSeen('coach', worldKey, store);
  return 'idle';
}
