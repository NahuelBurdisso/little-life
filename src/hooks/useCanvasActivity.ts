import { trpc } from '../lib/trpc';
import type { ActivityView } from '../lib/apiTypes';

/**
 * The newest activity rows (newest first), for canvas systems that turn log entries
 * into on-map story beats. Same query key as `useActivityFeed(50)`, so when the feed
 * panel is mounted both share one cache entry; the subscription here keeps it fresh
 * when the panel isn't.
 */
export function useCanvasActivity(): ActivityView[] {
  const utils = trpc.useUtils();
  const { data } = trpc.activity.getRecent.useQuery({ limit: 50 });
  trpc.activity.onUpdate.useSubscription(undefined, {
    // Brewing rides this subscription too (hooks/useBrewing.ts has none of its
    // own): without it the canvas fuses would go stale whenever the feed panel,
    // whose subscription normally refreshes it, is not mounted.
    onData: () => {
      utils.activity.getRecent.invalidate();
      utils.chronicle.getBrewing.invalidate();
    },
  });
  return data ?? [];
}
