import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useActivityFeed(limit: number = 50) {
  const activities = useQuery(api.queries.activityLog.getRecentActivity, { limit });
  return { activities: activities ?? [], isLoading: activities === undefined };
}
