/**
 * The alert inbox: the last alerts, kept after their toast is gone.
 *
 * Toasts last seconds and cap at three on screen, so a player who looked away
 * (or had a cascade fire six rules at once) lost them for good — including the
 * report on their own nudge. The inbox keeps the newest `INBOX_MAX`, newest
 * first, with a read flag for the 🔔 badge.
 *
 * Pure: the hook (useDramaAlerts) owns the React state and the storage, this
 * module owns what the list looks like after each thing that can happen to it.
 * Stored in sessionStorage — a reload keeps it, a new tab or tomorrow's session
 * starts clean, matching how long an alert stays interesting — keyed by world
 * seed like favourites, because agent ids only mean something in their world.
 */

import type { AlertTier } from '../../server/lib/alertTiers';

export const INBOX_MAX = 50;
const KEY_PREFIX = 'little-life:inbox:';

export interface InboxEntry {
  /** activity_log row id — unique, increasing. */
  id: number;
  tier: AlertTier;
  type: string;
  template_data?: Record<string, string | number>;
  agent_ids?: number[];
  /** Game tick the row was logged at (activity_log.timestamp). */
  timestamp: number;
  /** Wall-clock ms the client received it, for "5 min ago". */
  receivedAt: number;
  read: boolean;
}

export type InboxAction =
  | { type: 'add'; entries: InboxEntry[] }
  | { type: 'markAllRead' }
  | { type: 'clear' }
  | { type: 'load'; entries: InboxEntry[] };

export function inboxReducer(state: InboxEntry[], action: InboxAction): InboxEntry[] {
  switch (action.type) {
    case 'add': {
      // The same row can arrive twice (an invalidation landing before the
      // watermark moves, or a favourites change re-keying the query).
      const seen = new Set(state.map((e) => e.id));
      const fresh = action.entries.filter((e) => !seen.has(e.id));
      if (fresh.length === 0) return state;
      return [...fresh, ...state].sort((a, b) => b.id - a.id).slice(0, INBOX_MAX);
    }
    case 'markAllRead':
      return state.some((e) => !e.read) ? state.map((e) => (e.read ? e : { ...e, read: true })) : state;
    case 'clear':
      return state.length === 0 ? state : [];
    case 'load':
      return action.entries.slice().sort((a, b) => b.id - a.id).slice(0, INBOX_MAX);
  }
}

export function unreadCount(state: readonly InboxEntry[]): number {
  let n = 0;
  for (const e of state) if (!e.read) n++;
  return n;
}

export function inboxKey(seed: string): string {
  return KEY_PREFIX + seed;
}

const TIERS = new Set<AlertTier>(['player', 'major', 'minor']);

/** Tolerant parse of the stored list: malformed entries are dropped, not fatal. */
export function parseInbox(raw: string | null | undefined): InboxEntry[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is InboxEntry =>
      e != null && typeof e === 'object' &&
      typeof (e as InboxEntry).id === 'number' &&
      typeof (e as InboxEntry).type === 'string' &&
      TIERS.has((e as InboxEntry).tier),
    ).slice(0, INBOX_MAX);
  } catch {
    return [];
  }
}

export function loadInbox(seed: string): InboxEntry[] {
  try {
    return inboxReducer([], { type: 'load', entries: parseInbox(sessionStorage.getItem(inboxKey(seed))) });
  } catch {
    return [];
  }
}

export function saveInbox(seed: string, entries: readonly InboxEntry[]): void {
  try {
    sessionStorage.setItem(inboxKey(seed), JSON.stringify(entries));
  } catch {
    // Storage unavailable (private window, blocked site data): the inbox lasts
    // until reload, which is all it promises anyway.
  }
}
