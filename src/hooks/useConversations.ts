import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useConversations() {
  const conversations = useQuery(api.queries.conversations.getActiveConversations);
  return { conversations: conversations ?? [], isLoading: conversations === undefined };
}
