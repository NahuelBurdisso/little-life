import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useSelectedAgent(agentId: string | null) {
  const data = useQuery(
    api.queries.agents.getAgentFull,
    agentId ? { id: agentId as any } : "skip"
  );
  const relationships = useQuery(
    api.queries.relationships.getAgentRelationships,
    agentId ? { agentId: agentId as any } : "skip"
  );
  const memories = useQuery(
    api.queries.memories.getRecentMemories,
    agentId ? { agentId: agentId as any } : "skip"
  );
  return {
    data,
    relationships,
    memories,
    isLoading: agentId !== null && data === undefined,
  };
}
