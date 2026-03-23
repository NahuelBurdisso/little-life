import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useAgents() {
  const agents = useQuery(api.queries.agents.getActiveAgentsWithNeeds);
  return { agents: agents ?? [], isLoading: agents === undefined };
}
