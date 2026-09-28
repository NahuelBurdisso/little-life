import { useCallback, useEffect, useState } from 'react';
import { trpc } from '../lib/trpc';
import type { ActivityEntry } from '../lib/activityMessage';

/** How long a toast stays on screen. */
const ALERT_TTL_MS = 9000;
/** Cap so a cascade that fires a dozen rules at once can't paper over the map. */
const MAX_VISIBLE = 3;

export interface DramaAlert extends ActivityEntry {
  id: number;
  /** Wall-clock time the toast appeared, used only for expiry. */
  shownAt: number;
}

export function useDramaAlerts() {
  const utils = trpc.useUtils();
  // `undefined` means "no watermark yet" — the server answers with the current
  // newest id and no alerts, so a page load doesn't replay the whole backlog.
  const [sinceId, setSinceId] = useState<number | undefined>(undefined);
  const [alerts, setAlerts] = useState<DramaAlert[]>([]);

  const { data } = trpc.activity.getAlerts.useQuery({ sinceId });

  trpc.activity.onUpdate.useSubscription(undefined, {
    onData: () => {
      utils.activity.getAlerts.invalidate();
    },
  });

  useEffect(() => {
    if (!data) return;

    if (data.alerts.length > 0) {
      const now = Date.now();
      setAlerts(prev => {
        const seen = new Set(prev.map(a => a.id));
        // An invalidation can land before `sinceId` advances, so the same rows
        // can arrive twice. Drop the repeats rather than stacking duplicates.
        const incoming = data.alerts
          .filter(row => !seen.has(row.id))
          .map(row => ({ ...(row as unknown as ActivityEntry), id: row.id, shownAt: now }));
        if (incoming.length === 0) return prev;
        return [...prev, ...incoming].slice(-MAX_VISIBLE);
      });
    }

    // Advance the watermark last: it re-keys the query, and the refetch must
    // not be able to hand back rows that were just consumed above.
    setSinceId(prev => (prev == null || data.latestId > prev ? data.latestId : prev));
  }, [data]);

  // Expire toasts on a shared interval instead of one timer per alert, which
  // would need cleanup bookkeeping for alerts dismissed by hand.
  useEffect(() => {
    if (alerts.length === 0) return;
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - ALERT_TTL_MS;
      setAlerts(prev => {
        const next = prev.filter(a => a.shownAt > cutoff);
        return next.length === prev.length ? prev : next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [alerts.length]);

  const dismiss = useCallback((id: number) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  }, []);

  return { alerts, dismiss };
}
