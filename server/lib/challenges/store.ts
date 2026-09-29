import { db } from '../../db';
import { worldState } from '../../db/schema';
import { HISTORY_CAP, type Challenge, type ChallengeStatus } from './catalog';

/**
 * Where a world's challenges live: `world_state.rule_overrides.challenges`.
 *
 * Same home as the Storyteller's autoplay settings (lib/autoplaySettings.ts)
 * and for the same reasons: the offers, the accepted challenges and their
 * history belong to ONE town — they drop with a world replace (the row is
 * rebuilt), travel inside a save (the row is copied), and need no table, so
 * none of the schema.ts / addColumnIfMissing / worldTables bookkeeping. The
 * rules reader ignores the key and `setRuleOverrides` carries it through its
 * merges.
 *
 * The blob is small (three offers, three active, thirty history entries) and
 * written at most once a game hour by the evaluator plus once per player click.
 */

/**
 * The winter watch behind the "survived a winter with no deaths" feed row:
 * who was already dead when the season began. `fromStart` is false for the
 * first watch a world ever gets (the feature arrived, or a save was loaded,
 * mid-season), so a half-watched winter never counts.
 */
export interface SeasonWatch {
  season: string;
  fromStart: boolean;
  deadIds: number[];
}

export interface ChallengeStore {
  offers: Challenge[];
  /** Game day the offers were built for; they are rebuilt on a new day. */
  offersDay: number | null;
  active: Challenge[];
  /** Newest first. */
  history: Challenge[];
  nextId: number;
  /** Meddling that writes no player row (autoplay nudges, weather): see `recordHandsOn`. */
  handsOnCount: number;
  seasonWatch: SeasonWatch | null;
}

export function emptyStore(): ChallengeStore {
  return { offers: [], offersDay: null, active: [], history: [], nextId: 1, handsOnCount: 0, seasonWatch: null };
}

const STATUSES: readonly ChallengeStatus[] = ['offered', 'active', 'completed', 'failed', 'expired', 'abandoned'];

function isChallenge(v: unknown): v is Challenge {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.kind === 'string' &&
    typeof c.goal === 'string' &&
    Array.isArray(c.agentIds) &&
    typeof c.durationDays === 'number' &&
    STATUSES.includes(c.status as ChallengeStatus)
  );
}

const list = (v: unknown): Challenge[] => (Array.isArray(v) ? v.filter(isChallenge) : []);
const int = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;

/**
 * A stored blob → a store. Tolerant like every reader of `rule_overrides`: a
 * hand-edited, truncated or older blob keeps what is well-formed and defaults
 * the rest, it never throws into the tick loop.
 */
export function parseStore(raw: unknown): ChallengeStore {
  const s = emptyStore();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  s.offers = list(r.offers);
  s.offersDay = typeof r.offersDay === 'number' ? r.offersDay : null;
  s.active = list(r.active);
  s.history = list(r.history).slice(0, HISTORY_CAP);
  s.nextId = Math.max(1, int(r.nextId, 1));
  s.handsOnCount = Math.max(0, int(r.handsOnCount, 0));
  const w = r.seasonWatch as Record<string, unknown> | null | undefined;
  if (w && typeof w.season === 'string' && Array.isArray(w.deadIds)) {
    s.seasonWatch = {
      season: w.season,
      fromStart: w.fromStart === true,
      deadIds: w.deadIds.filter((x): x is number => typeof x === 'number'),
    };
  }
  // Ids must stay unique even if the counter was lost.
  for (const c of [...s.offers, ...s.active, ...s.history]) {
    const n = Number(c.id.replace(/^c/, ''));
    if (Number.isFinite(n) && n >= s.nextId) s.nextId = n + 1;
  }
  return s;
}

/** The current world's store, or null when there is no world row yet. */
export function loadStore(): ChallengeStore | null {
  const row = db.select({ rule_overrides: worldState.rule_overrides }).from(worldState).limit(1).get();
  if (!row) return null;
  return parseStore(row.rule_overrides?.challenges);
}

/** Write the store back, keeping every other key of `rule_overrides`. A no-op without a world. */
export function saveStore(store: ChallengeStore): void {
  const row = db.select({ id: worldState.id, rule_overrides: worldState.rule_overrides }).from(worldState).limit(1).get();
  if (!row) return;
  db.update(worldState)
    .set({ rule_overrides: { ...(row.rule_overrides ?? {}), challenges: store } })
    .run();
}

/**
 * Note meddling that leaves no player row in the feed: an autoplay auto-nudge
 * (autoplay/nudger.ts) or a weather change (routers/world.ts). "Hands off"
 * counts both — the player switched autoplay on, so its pokes are theirs.
 * Never throws: bookkeeping for an optional challenge must not break a nudge.
 */
export function recordHandsOn(): void {
  try {
    const store = loadStore();
    if (!store) return;
    store.handsOnCount += 1;
    saveStore(store);
  } catch (err) {
    console.warn('[challenges] could not record a player action:', (err as Error).message);
  }
}
