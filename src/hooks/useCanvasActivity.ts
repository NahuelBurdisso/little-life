import { trpc } from '../lib/trpc';

/**
 * The newest activity rows (newest first), for canvas systems that turn log entries
 * into on-map story beats. Same query key as `useActivityFeed(50)`, so when the feed
 * panel is mounted both share one cache entry; the subscription here keeps it fresh
 * when the panel isn't.
 */
export function useCanvasActivity(): any[] {
  const utils = trpc.useUtils();
  const { data } = trpc.activity.getRecent.useQuery({ limit: 50 });
  trpc.activity.onUpdate.useSubscription(undefined, {
    onData: () => { utils.activity.getRecent.invalidate(); },
  });
  return data ?? [];
}
