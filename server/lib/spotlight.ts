/**
 * Who the player is looking at right now — the "spotlight".
 *
 * The LLM has LLM_PARALLEL slots (4 by default) and a 20–32 resident town wants
 * far more than that. When the queue saturates, conversation entries age out
 * into template chats in whatever order the queue happens to drain — including
 * the pair the camera is on, which is the one conversation the player actually
 * reads. The client tells us who is on screen (selected / followed resident,
 * favourites, the director's shot, residents in the camera view, the hottest
 * Brewing items) and the budget decisions — conversation tier
 * (conversationTier.ts), replan priority (planning/PlanLLMQueue.ts), the
 * end-of-chat summary (memory/MemoryObserver.ts) — spend the model there first.
 *
 * The set expires on WALL-CLOCK time, not game time: it describes a browser tab,
 * and a tab that closed or lost its socket must stop steering the budget even
 * while the town is paused. The client re-sends well inside the window
 * (src/hooks/useSpotlight.ts). An expired or empty spotlight is exactly the
 * pre-spotlight behaviour: nobody is watched.
 *
 * Agent ids are per world (SQLite reuses rowids), so the set is cleared with the
 * other per-world caches (engine/worldCaches.ts).
 */

/** How long a `setSpotlight` call stays in force without a refresh (wall ms). */
export const SPOTLIGHT_TTL_MS = 60_000;

/**
 * Upper bound on one spotlight. The client already caps what it sends; this is
 * the server's own guard so a buggy or hostile client can't mark the whole town
 * "watched" and quietly switch the budget off.
 */
export const SPOTLIGHT_MAX_AGENTS = 24;

let watched: ReadonlySet<number> = new Set();
let expiresAt = 0;

/** Replace the spotlight. `now` is injectable for tests. */
export function setSpotlight(agentIds: readonly number[], now: number = Date.now()): void {
  const ids = agentIds.filter((id) => Number.isInteger(id) && id > 0).slice(0, SPOTLIGHT_MAX_AGENTS);
  watched = new Set(ids);
  expiresAt = ids.length > 0 ? now + SPOTLIGHT_TTL_MS : 0;
}

/** The ids currently watched (empty once expired). */
export function getSpotlight(now: number = Date.now()): number[] {
  return now < expiresAt ? [...watched] : [];
}

export function isWatched(agentId: number, now: number = Date.now()): boolean {
  return now < expiresAt && watched.has(agentId);
}

/**
 * A conversation is on screen when ANY participant is: following one resident
 * shows whoever they are talking to as well.
 */
export function isAnyWatched(agentIds: readonly number[], now: number = Date.now()): boolean {
  if (now >= expiresAt) return false;
  return agentIds.some((id) => watched.has(id));
}

/** Forget the spotlight (world replace, tests). */
export function clearSpotlight(): void {
  watched = new Set();
  expiresAt = 0;
}
