import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '../lib/trpc';
import type { ActivityEntry } from '../lib/activityMessage';
import type { AlertTier } from '../../server/lib/alertTiers';
import { playAlertChime } from '../lib/audio/synth';
import {
  inboxReducer,
  loadInbox,
  saveInbox,
  unreadCount,
  type InboxAction,
  type InboxEntry,
} from '../lib/alertInbox';

/**
 * How long a toast stays on screen, by tier: the player's own outcome is the
 * one they'll want to read to the end; a favourite's small moment is a glance.
 */
const ALERT_TTL_MS: Record<AlertTier, number> = { player: 12000, major: 9000, minor: 6000 };
/** Cap so a cascade that fires a dozen rules at once can't paper over the map. */
const MAX_VISIBLE = 3;

export interface DramaAlert extends ActivityEntry {
  id: number;
  tier: AlertTier;
  /** Wall-clock time the toast appeared, used only for expiry. */
  shownAt: number;
}

/**
 * Alert toasts plus the inbox that keeps them. Lives in App (not in the toast
 * overlay) because the TopBar's Journal badge and the Journal's Inbox tab read the same state.
 *
 * `seed` scopes the stored inbox to its world (see alertInbox.ts);
 * `favorites` are the cast bar's starred ids, whose rows the server alerts on
 * at a lower bar.
 */
export function useDramaAlerts(seed: string, favorites: ReadonlySet<string>) {
  const utils = trpc.useUtils();
  // `undefined` means "no watermark yet" — the server answers with the current
  // newest id and no alerts, so a page load doesn't replay the whole backlog.
  const [sinceId, setSinceId] = useState<number | undefined>(undefined);
  const [alerts, setAlerts] = useState<DramaAlert[]>([]);

  // Seed kept next to the list so a world change can't show (or save) the old
  // world's inbox under the new key for a render — same trick as useFavorites.
  const [inbox, setInbox] = useState(() => ({ seed, entries: loadInbox(seed) }));
  useEffect(() => {
    setInbox((s) => (s.seed === seed ? s : { seed, entries: loadInbox(seed) }));
  }, [seed]);
  const entries = inbox.seed === seed ? inbox.entries : [];
  const dispatch = useCallback((action: InboxAction) => {
    setInbox((s) => {
      const next = inboxReducer(s.entries, action);
      if (next === s.entries) return s;
      saveInbox(s.seed, next);
      return { seed: s.seed, entries: next };
    });
  }, []);

  // Sorted so the query key doesn't change when the same stars are toggled back.
  const favoriteIds = useMemo(
    () => [...favorites].map(Number).filter(Number.isFinite).sort((a, b) => a - b),
    [favorites],
  );
  const { data } = trpc.activity.getAlerts.useQuery({
    sinceId,
    favoriteIds: favoriteIds.length > 0 ? favoriteIds : undefined,
  });

  trpc.activity.onUpdate.useSubscription(undefined, {
    onData: () => {
      utils.activity.getAlerts.invalidate();
    },
  });

  // Rows already toasted. Starring someone re-keys the query with the same
  // watermark and can hand back rows that were just shown; so can an
  // invalidation landing before `sinceId` advances.
  const shownRef = useRef(new Set<number>());

  useEffect(() => {
    if (!data) return;

    const incoming = data.alerts.filter((row) => !shownRef.current.has(row.id));
    if (incoming.length > 0) {
      const now = Date.now();
      for (const row of incoming) {
        shownRef.current.add(row.id);
        // Rate-limited inside: a burst of alerts rings the most important one once.
        playAlertChime(row.tier);
      }
      setAlerts((prev) => [
        ...prev,
        ...incoming.map((row) => ({ ...(row as unknown as ActivityEntry), id: row.id, tier: row.tier, shownAt: now })),
      ].slice(-MAX_VISIBLE));
      dispatch({
        type: 'add',
        entries: incoming.map((row) => ({
          id: row.id,
          tier: row.tier,
          type: row.type,
          template_data: row.template_data as Record<string, string | number>,
          agent_ids: row.agent_ids as number[],
          timestamp: row.timestamp,
          receivedAt: now,
          read: false,
        })),
      });
    }

    // Advance the watermark last: it re-keys the query, and the refetch must
    // not be able to hand back rows that were just consumed above.
    setSinceId((prev) => (prev == null || data.latestId > prev ? data.latestId : prev));
  }, [data, dispatch]);

  // Expire toasts on a shared interval instead of one timer per alert, which
  // would need cleanup bookkeeping for alerts dismissed by hand.
  useEffect(() => {
    if (alerts.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setAlerts((prev) => {
        const next = prev.filter((a) => now - a.shownAt < ALERT_TTL_MS[a.tier]);
        return next.length === prev.length ? prev : next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [alerts.length]);

  const dismiss = useCallback((id: number) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const markAllRead = useCallback(() => dispatch({ type: 'markAllRead' }), [dispatch]);
  const clearInbox = useCallback(() => dispatch({ type: 'clear' }), [dispatch]);

  /**
   * A world replace: the old world's alerts point at agent ids that now belong
   * to other people, and activity ids restart, so a kept watermark would sit
   * above every new row and nothing would alert until the new log caught up.
   */
  const reset = useCallback(() => {
    setAlerts([]);
    shownRef.current = new Set();
    setSinceId(undefined);
    dispatch({ type: 'clear' });
  }, [dispatch]);

  return {
    alerts,
    dismiss,
    inbox: entries as readonly InboxEntry[],
    unread: unreadCount(entries),
    markAllRead,
    clearInbox,
    reset,
  };
}
