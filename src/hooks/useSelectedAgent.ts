import { trpc } from '../lib/trpc';

export function useSelectedAgent(agentId: string | null) {
  const numericId = agentId ? Number(agentId) : null;

  const { data } = trpc.agents.getAgentSummary.useQuery(
    { agentId: numericId! },
    { enabled: !!numericId }
  );

  return {
    data: data ?? undefined,
    relationships: data?.relationships,
    memories: data?.memories,
    states: data?.states,
    conversationHistory: data?.conversationHistory,
    isLoading: agentId !== null && data === undefined,
  };
}
