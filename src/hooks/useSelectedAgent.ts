import { trpc } from '../lib/trpc';
import { selectedAgentStatus } from '../lib/selectedAgentStatus';

export function useSelectedAgent(agentId: string | null) {
  const numericId = agentId ? Number(agentId) : null;

  const { data, isPending, isError } = trpc.agents.getAgentSummary.useQuery(
    { agentId: numericId! },
    { enabled: !!numericId }
  );

  // `null` (no such agent) and `undefined` (not fetched yet) mean different
  // things — see `selectedAgentStatus` for why collapsing them hung the panel.
  const status = selectedAgentStatus(agentId, { data, isPending, isError });

  return {
    data: data ?? undefined,
    relationships: data?.relationships,
    memories: data?.memories,
    states: data?.states,
    conversationHistory: data?.conversationHistory,
    status,
  };
}
