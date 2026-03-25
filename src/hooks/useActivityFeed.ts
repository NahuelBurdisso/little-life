import { trpc } from '../lib/trpc';

export function useActivityFeed(limit: number = 50) {
  const utils = trpc.useUtils();
  const { data: activities, isLoading } = trpc.activity.getRecent.useQuery({ limit });

  trpc.activity.onUpdate.useSubscription(undefined, {
    onData: () => {
      utils.activity.getRecent.invalidate();
    },
  });

  return { activities: activities ?? [], isLoading };
}
