import { trpc } from '../lib/trpc';
import { throttle } from '../lib/throttle';

/**
 * The agents channel flushes every tick or two; the open pair dossier is the
 * heaviest query hung on it (history, sparkline, conversations), so it gets at
 * most one refetch per window instead of one per flush.
 */
const PAIR_DOSSIER_REFRESH_MS = 3000;

/**
 * Module-level on purpose: `useAgents` is mounted by half a dozen components,
 * each with its own subscription, so a per-instance throttle would still let
 * every one of them invalidate on every flush.
 */
let invalidatePair: (() => void) | null = null;
const refreshPairDossier = throttle(() => invalidatePair?.(), PAIR_DOSSIER_REFRESH_MS);

export function useAgents() {
  const utils = trpc.useUtils();
  const { data: agents, isLoading } = trpc.agents.getActive.useQuery();
  invalidatePair = () => { utils.relationships.getPair.invalidate(); };

  trpc.agents.onUpdate.useSubscription(undefined, {
    onData: () => {
      utils.agents.invalidate(); // invalidates getActive, getAgentSummary, getAgentThoughts
      // Relationship and money changes are announced on this channel too
      // (systems/relationships, systems/economy), but nothing else invalidates
      // these, and window-focus refetch is off — so the canvas tension lines,
      // the relationship graph and TownStats kept their load-time data all session.
      utils.relationships.getGraph.invalidate();
      // The pair dossier (open one at a time, so this is at most one refetch)
      // shows the same feelings plus their history, and would otherwise sit on
      // the values it loaded with. Throttled: relationship changes ride the
      // same channel as everything else, so there is no narrower signal, and
      // an open dossier refetching at every flush re-ran its whole history join.
      refreshPairDossier();
      utils.economy.getTownStats.invalidate();
    },
  });

  return { agents: agents ?? [], isLoading };
}
