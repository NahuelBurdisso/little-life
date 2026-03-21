import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useWorldState() {
  const world = useQuery(api.queries.world.getWorldState);
  const events = useQuery(api.queries.world.getActiveEvents);
  return { world, events, isLoading: world === undefined };
}
