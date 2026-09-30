import { trpc } from '../lib/trpc';
import { createAgentRefresh, type RefreshTargets } from '../lib/agentRefresh';

/**
 * Module-level on purpose: `useAgents` is mounted by half a dozen components,
 * each with its own subscription, so per-instance throttles would still let
 * every one of them invalidate on every flush. The targets are rebound to the
 * latest `utils` on each render (it is stable in practice).
 */
let targets: RefreshTargets | null = null;
const refresh = createAgentRefresh({
  active: () => targets?.active(),
  details: () => targets?.details(),
  graph: () => targets?.graph(),
  pair: () => targets?.pair(),
});

export function useAgents() {
  const utils = trpc.useUtils();
  const { data: agents, isLoading } = trpc.agents.getActive.useQuery();
  targets = {
    active: () => { utils.agents.getActive.invalidate(); },
    // Everything under `agents` but getActive (its own, faster throttle): the
    // selected agent's summary and thoughts. Only mounted queries refetch.
    details: () => {
      utils.agents.invalidate(undefined, {
        predicate: (q) => (q.queryKey[0] as unknown[] | undefined)?.[1] !== 'getActive',
      });
      utils.economy.getTownStats.invalidate();
    },
    graph: () => { utils.relationships.getGraph.invalidate(); },
    pair: () => { utils.relationships.getPair.invalidate(); },
  };

  // Positions, needs, actions, money: throttled (lib/agentRefresh.ts).
  trpc.agents.onUpdate.useSubscription(undefined, {
    onData: (d) => refresh.onAgentsFlush(d.timestamp),
  });
  // Relationship changes have their own channel now, fired only when the table
  // was written (server/engine/relationshipsChannel.ts) — the graph, the canvas
  // tension lines, TownStats' relationship counts and the open pair dossier.
  trpc.relationships.onUpdate.useSubscription(undefined, {
    onData: (d) => refresh.onRelationshipsFlush(d.timestamp),
  });

  return { agents: agents ?? [], isLoading };
}
