/**
 * Who counts as "on the player's screen" — the pure half of hooks/useSpotlight.ts.
 *
 * The server spends its few LLM slots on these residents first (see
 * server/lib/spotlight.ts): their conversations jump the queue and are never
 * canned, their replans and chat summaries keep normal priority. So the set
 * should be what the player is actually following, most important first:
 *
 *   1. the selected resident (the follow-lock is always on the selection);
 *   2. whoever the director's camera is on;
 *   3. the residents of the top Brewing items — what's about to boil over is
 *      what the player will want to read about;
 *   4. residents inside the camera view, nearest the centre first, capped — at
 *      full zoom-out the whole town is "in view", which would switch the budget
 *      off rather than focus it;
 *   5. favourites (the stars in the cast bar).
 *
 * Capped at the server's own limit; the order above decides who is kept.
 */
import { SPOTLIGHT_MAX_AGENTS, SPOTLIGHT_TTL_MS } from '../../server/lib/spotlight';
import type { ViewRect } from './cameraView';

/** How often the hook recomputes the set (and the fastest it ever sends). */
export const SPOTLIGHT_SEND_MS = 5_000;
/**
 * Re-send an unchanged, non-empty set this often: the server forgets a
 * spotlight after SPOTLIGHT_TTL_MS, so "send only on change" alone would let a
 * player who stares at one scene for a minute lose it.
 */
export const SPOTLIGHT_KEEPALIVE_MS = SPOTLIGHT_TTL_MS / 2;
/** Residents the camera view contributes at most. */
export const MAX_IN_VIEW = 6;
/** Brewing items (hottest first) whose residents count as watched. */
export const TOP_BREWING = 3;

export interface SpotlightInput {
  selectedAgentId: string | null;
  shotAgentIds: readonly number[];
  brewing: ReadonlyArray<{ agentIds: readonly number[] }>;
  inView: readonly number[];
  favorites: ReadonlySet<string>;
}

/** Residents inside `view`, nearest its centre first, at most `max`. */
export function residentsInView(
  agents: ReadonlyArray<{ id: number | string; position?: { x: number; y: number } | null }>,
  view: ViewRect | null,
  max = MAX_IN_VIEW,
): number[] {
  if (!view || max <= 0) return [];
  const cx = view.x + view.width / 2;
  const cy = view.y + view.height / 2;
  const inside: Array<{ id: number; d: number }> = [];
  for (const a of agents) {
    const p = a.position;
    if (!p) continue;
    if (p.x < view.x || p.x > view.x + view.width || p.y < view.y || p.y > view.y + view.height) continue;
    const id = Number(a.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    inside.push({ id, d: (p.x - cx) ** 2 + (p.y - cy) ** 2 });
  }
  inside.sort((a, b) => a.d - b.d);
  return inside.slice(0, max).map((e) => e.id);
}

/** The watched ids, in the priority order of the header, deduped and capped. */
export function buildSpotlight(input: SpotlightInput): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (raw: number | string | null | undefined) => {
    if (raw == null) return;
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id) || out.length >= SPOTLIGHT_MAX_AGENTS) return;
    seen.add(id);
    out.push(id);
  };
  add(input.selectedAgentId);
  input.shotAgentIds.forEach(add);
  input.brewing.slice(0, TOP_BREWING).forEach((b) => b.agentIds.forEach(add));
  input.inView.forEach(add);
  input.favorites.forEach(add);
  return out;
}

/** Order-independent identity of a set, for "did it change". */
export function spotlightKey(ids: readonly number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
}

/** Send when the set changed, or to keep a non-empty one alive on the server. */
export function shouldSendSpotlight(p: { key: string; lastKey: string | null; lastSentAt: number; now: number }): boolean {
  if (p.key !== p.lastKey) return true;
  return p.key !== '' && p.now - p.lastSentAt >= SPOTLIGHT_KEEPALIVE_MS;
}
