// When the camera looks away. Pure so the rules are unit-testable without a DOM or a clock:
// given the activity rows that are NEW since the last poll, the resident on screen and the
// player's favourites, decide whether a `tryst` row deserves the fade-to-black beat.
//
// Only trysts involving someone the player is actually watching fade the screen (a couple the
// player never looked at is just a feed line), never history (a reloaded page or a backgrounded
// tab must not replay old nights) and never more than once in a while, so a town full of lovers
// cannot turn the game into a slideshow of dark screens.

/** Rows older than this (wall clock) are history, the same bar beatDetect.ts uses. */
export const FADE_MAX_ROW_AGE_MS = 60_000;
/** At most one fade per this many ms of wall-clock time. */
export const FADE_MIN_GAP_MS = 20_000;

/** The slice of an activity row this needs (structurally an `ActivityRow`). */
export interface FadeRow {
  id: number;
  type: string;
  initiator_id?: number | null;
  target_id?: number | null;
  agent_ids?: number[] | null;
  template_data?: { venue?: unknown; agent1?: unknown; agent2?: unknown; [k: string]: unknown } | null;
  real_timestamp?: number;
}

export interface FadeRequest {
  /** Where the lamp went down, or null when the row names no place. */
  venue: string | null;
  /** The couple, in the order the row names them. */
  names: string[];
}

/** Rate-limit memory; one per mounted overlay. */
export interface FadeState {
  lastFadeAt: number | null;
}

export function createFadeState(): FadeState {
  return { lastFadeAt: null };
}

function involves(row: FadeRow, watched: ReadonlySet<string>): boolean {
  if (watched.size === 0) return false;
  const ids = [row.initiator_id, row.target_id, ...(row.agent_ids ?? [])];
  return ids.some((id) => typeof id === "number" && watched.has(String(id)));
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * `rows` are the rows new since the last poll (oldest first is fine, the first that qualifies
 * wins). `selectedId` and `favorites` are agent ids as strings, the way App keeps them. Mutates
 * `state` when it returns a request, so the next call inside the gap answers null.
 */
export function fadeRequestFor(
  rows: readonly FadeRow[],
  selectedId: string | null,
  favorites: ReadonlySet<string>,
  nowMs: number,
  state: FadeState,
): FadeRequest | null {
  if (state.lastFadeAt !== null && nowMs - state.lastFadeAt < FADE_MIN_GAP_MS) return null;
  const watched = new Set(favorites);
  if (selectedId) watched.add(selectedId);
  for (const row of rows) {
    if (row.type !== "tryst") continue;
    if (row.real_timestamp !== undefined && nowMs - row.real_timestamp > FADE_MAX_ROW_AGE_MS) continue;
    if (!involves(row, watched)) continue;
    state.lastFadeAt = nowMs;
    const names = [text(row.template_data?.agent1), text(row.template_data?.agent2)].filter((n): n is string => n !== null);
    return { venue: text(row.template_data?.venue), names };
  }
  return null;
}

/** The one italic line the overlay shows. */
export function fadeLine(request: FadeRequest): string {
  return request.venue ? `The lamp at ${request.venue} is turned down.` : "Somewhere, a lamp is turned down.";
}
