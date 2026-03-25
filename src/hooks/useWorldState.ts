import { trpc } from '../lib/trpc';

export function useWorldState() {
  const utils = trpc.useUtils();
  const { data: world, isLoading } = trpc.world.getState.useQuery();
  const { data: events } = trpc.world.getActiveEvents.useQuery();

  trpc.world.onStateChange.useSubscription(undefined, {
    onData: () => {
      utils.world.getState.invalidate();
      utils.world.getActiveEvents.invalidate();
    },
  });

  return { world: world ?? null, events: events ?? [], isLoading };
}
