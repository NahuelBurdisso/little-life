import { trpc } from '../lib/trpc';

export function useAgents() {
  const utils = trpc.useUtils();
  const { data: agents, isLoading } = trpc.agents.getActive.useQuery();

  trpc.agents.onUpdate.useSubscription(undefined, {
    onData: () => {
      utils.agents.getActive.invalidate();
    },
  });

  return { agents: agents ?? [], isLoading };
}
