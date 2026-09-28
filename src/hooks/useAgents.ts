import { trpc } from '../lib/trpc';

export function useAgents() {
  const utils = trpc.useUtils();
  const { data: agents, isLoading } = trpc.agents.getActive.useQuery();

  trpc.agents.onUpdate.useSubscription(undefined, {
    onData: () => {
      utils.agents.invalidate(); // invalidates getActive, getAgentSummary, getAgentThoughts
      // Relationship and money changes are announced on this channel too
      // (systems/relationships, systems/economy), but nothing else invalidates
      // these, and window-focus refetch is off — so the canvas tension lines,
      // the relationship graph and TownStats kept their load-time data all session.
      utils.relationships.getGraph.invalidate();
      utils.economy.getTownStats.invalidate();
    },
  });

  return { agents: agents ?? [], isLoading };
}
