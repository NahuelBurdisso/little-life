import { trpc } from '../lib/trpc';

export function useSelectedAgent(agentId: string | null) {
  const numericId = agentId ? Number(agentId) : null;

  const { data } = trpc.agents.getFull.useQuery(
    { agentId: numericId! },
    { enabled: !!numericId }
  );
  const { data: relationships } = trpc.relationships.getAgentRelationships.useQuery(
    { agentId: numericId! },
    { enabled: !!numericId }
  );
  const { data: memories } = trpc.memories.getRecent.useQuery(
    { agentId: numericId! },
    { enabled: !!numericId }
  );

  return {
    data: data ?? undefined,
    relationships: relationships ?? undefined,
    memories: memories ?? undefined,
    isLoading: agentId !== null && data === undefined,
  };
}
