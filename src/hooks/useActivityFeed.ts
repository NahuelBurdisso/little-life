import { trpc } from '../lib/trpc';
import { useBrewing } from './useBrewing';

export function useActivityFeed(limit: number = 50) {
  const utils = trpc.useUtils();
  const { data: activities, isLoading } = trpc.activity.getRecent.useQuery({ limit });
  const { data: highlights } = trpc.activity.getDramaticEvents.useQuery({ limit: 25 });
  const { brewing } = useBrewing();

  // One subscription feeds the feed's queries and the Journal's story tabs — the
  // channel only signals "the log changed", so extra subscriptions would be pure
  // waste. The feed is always mounted, which makes this the refresh source for
  // the Journal's Stories (`getArcs`) and Brewing lists too: invalidating a query
  // nobody is showing only marks it stale, and it refetches when the tab opens.
  // Arcs and Brewing are derived from the same ticks that write the log and
  // memoise server-side, so the invalidations are cheap.
  trpc.activity.onUpdate.useSubscription(undefined, {
    onData: () => {
      utils.activity.getRecent.invalidate();
      utils.activity.getDramaticEvents.invalidate();
      utils.chronicle.getArcs.invalidate();
      utils.chronicle.getBrewing.invalidate();
    },
  });

  return { activities: activities ?? [], highlights: highlights ?? [], brewing, isLoading };
}
