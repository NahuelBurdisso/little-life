import { trpc } from '../lib/trpc';

export function useActivityFeed(limit: number = 50) {
  const utils = trpc.useUtils();
  const { data: activities, isLoading } = trpc.activity.getRecent.useQuery({ limit });
  const { data: highlights } = trpc.activity.getDramaticEvents.useQuery({ limit: 25 });
  const { data: arcs } = trpc.chronicle.getArcs.useQuery({ limit: 12 });

  // One subscription feeds all three queries — the channel only signals "the log
  // changed", so extra subscriptions for the highlights and arcs would be pure
  // waste. Arcs are derived from the same ticks that write the log, and the
  // detector memoises for a few seconds, so invalidating it here is cheap.
  trpc.activity.onUpdate.useSubscription(undefined, {
    onData: () => {
      utils.activity.getRecent.invalidate();
      utils.activity.getDramaticEvents.invalidate();
      utils.chronicle.getArcs.invalidate();
    },
  });

  return { activities: activities ?? [], highlights: highlights ?? [], arcs: arcs ?? [], isLoading };
}
