import { createTRPCReact } from '@trpc/react-query';
import { createWSClient, wsLink } from '@trpc/client';
import type { AppRouter } from '../../server/router';

export const trpc = createTRPCReact<AppRouter>();

const wsClient = createWSClient({
  // VITE_WS_URL points a second client at a second server (e.g. a verification
  // copy on another port) without touching the one you're playing on.
  url: import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001',
  retryDelayMs: () => 1000,
});

export const trpcClient = trpc.createClient({
  links: [wsLink({ client: wsClient })],
});
