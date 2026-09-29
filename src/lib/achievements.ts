/**
 * Achievements: the player's trophies ACROSS towns.
 *
 * Challenges (server/lib/challenges/) belong to one world and die with it; an
 * achievement is about the player — "you've seen a wedding", "your rumor
 * reached everyone" — so it lives in this browser's localStorage and survives
 * restarts, new worlds and loaded saves.
 *
 * Unlocked from the activity rows the client already polls (the canvas's
 * `activity.getRecent`), never from a query of their own: each rule is a
 * predicate on a row (a `wedding`, a `drama` row flagged `planted`, a
 * `season_survived` for winter...), counters add up rows over time. Only rows
 * that arrive while the game is open count, like a spectator's memory: the
 * first poll after a load only sets the watermark.
 *
 * Pure except `loadAchievements`/`saveAchievements` (storage wrapped in
 * try/catch: private windows and blocked storage throw).
 */

export type AchievementId =
  | 'first_wedding'
  | 'rumor_whole_town'
  | 'winter_no_deaths'
  | 'directors_cut'
  | 'first_challenge'
  | 'challenge_veteran'
  | 'cupid';

export type CounterKey = 'confrontations' | 'challenges';

export interface AchievementDef {
  id: AchievementId;
  icon: string;
  name: string;
  /** How it is earned, shown on the locked card too. */
  how: string;
  /** Unlocks when this counter reaches `goal`. */
  counter?: { key: CounterKey; goal: number };
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'first_wedding', icon: '💒', name: 'Dearly beloved', how: 'Witness your first wedding' },
  { id: 'rumor_whole_town', icon: '🗣', name: 'Word gets around', how: 'Plant a rumor that reaches the whole town' },
  { id: 'winter_no_deaths', icon: '❄', name: 'Hearth and home', how: 'See a town through a whole winter with no deaths' },
  { id: 'directors_cut', icon: '🎬', name: "Director's cut", how: 'Watch 10 confrontations', counter: { key: 'confrontations', goal: 10 } },
  { id: 'first_challenge', icon: '🏆', name: 'Up for it', how: 'Complete a challenge' },
  { id: 'challenge_veteran', icon: '🥇', name: 'Old hand', how: 'Complete 5 challenges', counter: { key: 'challenges', goal: 5 } },
  { id: 'cupid', icon: '💘', name: 'Cupid', how: 'Complete a Matchmaker challenge' },
];

export interface AchievementState {
  /** Unlock time (wall-clock ms) by id. */
  unlocked: Partial<Record<AchievementId, number>>;
  counters: Partial<Record<CounterKey, number>>;
}

/** The part of an activity row the rules read. */
export interface AchievementRow {
  id: number;
  type: string;
  template_data?: Record<string, unknown> | null;
  metadata?: { beat?: unknown } | null;
}

export function emptyAchievements(): AchievementState {
  return { unlocked: {}, counters: {} };
}

/** Drama beats that are a confrontation on screen (a shouting match, a fight, a snap). */
const CONFRONTATION_BEATS = new Set(['fight', 'insult', 'snap']);

/** Rows that unlock something outright. */
function directUnlocks(row: AchievementRow): AchievementId[] {
  const data = row.template_data ?? {};
  switch (row.type) {
    case 'wedding':
      return ['first_wedding'];
    case 'drama':
      return data.planted ? ['rumor_whole_town'] : [];
    case 'season_survived':
      return data.season === 'winter' ? ['winter_no_deaths'] : [];
    case 'challenge_completed':
      return data.challenge === 'matchmaker' ? ['first_challenge', 'cupid'] : ['first_challenge'];
    default:
      return [];
  }
}

function counterBumps(row: AchievementRow): CounterKey[] {
  if (row.type === 'challenge_completed') return ['challenges'];
  if (row.type === 'confrontation') return ['confrontations'];
  const beat = row.metadata?.beat;
  return typeof beat === 'string' && CONFRONTATION_BEATS.has(beat) ? ['confrontations'] : [];
}

/**
 * Fold new rows into the state. Returns the next state (the input is not
 * mutated) and the achievements this batch unlocked, in catalog order.
 */
export function applyRows(
  state: AchievementState,
  rows: readonly AchievementRow[],
  nowMs: number,
): { state: AchievementState; unlocked: AchievementDef[] } {
  const next: AchievementState = { unlocked: { ...state.unlocked }, counters: { ...state.counters } };
  const fresh = new Set<AchievementId>();
  const unlock = (id: AchievementId) => {
    if (next.unlocked[id] != null) return;
    next.unlocked[id] = nowMs;
    fresh.add(id);
  };
  for (const row of rows) {
    for (const id of directUnlocks(row)) unlock(id);
    for (const key of counterBumps(row)) next.counters[key] = (next.counters[key] ?? 0) + 1;
  }
  for (const def of ACHIEVEMENTS) {
    if (def.counter && (next.counters[def.counter.key] ?? 0) >= def.counter.goal) unlock(def.id);
  }
  return { state: next, unlocked: ACHIEVEMENTS.filter((d) => fresh.has(d.id)) };
}

/** "3 / 10" for a counter achievement, or null. */
export function counterProgress(def: AchievementDef, state: AchievementState): { value: number; goal: number } | null {
  if (!def.counter) return null;
  return { value: Math.min(def.counter.goal, state.counters[def.counter.key] ?? 0), goal: def.counter.goal };
}

// ─── Which rows are new ─────────────────────────────────────────────────────

export interface RowWatch {
  /** Newest row id already folded in; null until the first non-empty poll. */
  watermark: number | null;
}

/**
 * Rows newer than the watermark, oldest first. The first non-empty poll only
 * sets it (a page load must not count the backlog: a reload would otherwise
 * count the same confrontations again). A newest id below the watermark means
 * the world was replaced and ids restarted: re-arm without counting.
 */
export function takeNewRows<T extends { id: number }>(watch: RowWatch, rows: readonly T[]): T[] {
  if (rows.length === 0) return [];
  let newest = -Infinity;
  for (const r of rows) if (r.id > newest) newest = r.id;
  if (watch.watermark == null || newest < watch.watermark) {
    watch.watermark = newest;
    return [];
  }
  const fresh = rows.filter((r) => r.id > watch.watermark!).sort((a, b) => a.id - b.id);
  watch.watermark = newest;
  return fresh;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

export const ACHIEVEMENTS_KEY = 'little-life.achievements';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const KNOWN = new Set<string>(ACHIEVEMENTS.map((a) => a.id));

export function loadAchievements(storage: StorageLike | null = defaultStorage()): AchievementState {
  try {
    const raw = storage?.getItem(ACHIEVEMENTS_KEY);
    if (!raw) return emptyAchievements();
    const parsed = JSON.parse(raw) as { unlocked?: Record<string, unknown>; counters?: Record<string, unknown> } | null;
    const out = emptyAchievements();
    for (const [id, at] of Object.entries(parsed?.unlocked ?? {})) {
      if (KNOWN.has(id) && typeof at === 'number') out.unlocked[id as AchievementId] = at;
    }
    for (const key of ['confrontations', 'challenges'] as const) {
      const n = parsed?.counters?.[key];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out.counters[key] = Math.floor(n);
    }
    return out;
  } catch {
    return emptyAchievements();
  }
}

export function saveAchievements(state: AchievementState, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(ACHIEVEMENTS_KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked: the trophies just won't survive a reload */
  }
}
