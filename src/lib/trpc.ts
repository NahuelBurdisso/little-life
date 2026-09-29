import { createTRPCReact } from '@trpc/react-query';
import { createWSClient, wsLink } from '@trpc/client';
import type { AppRouter } from '../../server/router';
import { markSocketClosed, markSocketOpen } from './connectionState';

export const trpc = createTRPCReact<AppRouter>();

const wsClient = createWSClient({
  // VITE_WS_URL points a second client at a second server (e.g. a verification
  // copy on another port) without touching the one you're playing on.
  url: import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001',
  retryDelayMs: () => 1000,
  // The client retries silently forever; these tell the health banner
  // ("Reconnecting to the town…") and trigger a refetch once we are back.
  onOpen: () => markSocketOpen(),
  onClose: () => markSocketClosed(),
});

export const trpcClient = trpc.createClient({
  links: [wsLink({ client: wsClient })],
});
