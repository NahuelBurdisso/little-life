import { trpc } from '../lib/trpc';

export function useConversations() {
  const utils = trpc.useUtils();
  const { data: conversations, isLoading } = trpc.conversations.getActive.useQuery();

  trpc.conversations.onUpdate.useSubscription(undefined, {
    onData: () => {
      utils.conversations.getActive.invalidate();
    },
  });

  return { conversations: conversations ?? [], isLoading };
}
