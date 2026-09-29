import { useSyncExternalStore } from 'react';

/**
 * Is the WebSocket to the server up? A module-level store, fed by the callbacks
 * of the tRPC ws client (lib/trpc.ts), so the health banner can say
 * "Reconnecting to the town…" instead of the UI silently freezing while
 * `createWSClient` retries in the background.
 *
 * Kept free of tRPC imports so it can be unit tested and imported anywhere.
 *
 * - `connecting`: nothing has happened yet (page just loaded). Not shown to the
 *   player: a normal load would flash the banner.
 * - `open`: the socket is up.
 * - `closed`: it was open or an attempt failed; the client is retrying.
 */
export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Bumps each time the socket comes back after having been down. */
  reconnects: number;
}

let state: ConnectionState = { status: 'connecting', reconnects: 0 };
let everClosed = false;
const listeners = new Set<() => void>();

function publish(next: ConnectionState): void {
  state = next;
  for (const l of listeners) l();
}

export function markSocketOpen(): void {
  if (state.status === 'open') return;
  // `reconnects` counts recoveries only, not the first connection: the app
  // refetches everything on a recovery (it missed pushes while offline), and a
  // fresh page load has nothing stale to refresh.
  publish({ status: 'open', reconnects: state.reconnects + (everClosed ? 1 : 0) });
}

export function markSocketClosed(): void {
  if (state.status === 'closed') return;
  everClosed = true;
  publish({ status: 'closed', reconnects: state.reconnects });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function getConnectionState(): ConnectionState {
  return state;
}

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(subscribe, getConnectionState, getConnectionState);
}

/** Tests only. */
export function resetConnectionState(): void {
  everClosed = false;
  state = { status: 'connecting', reconnects: 0 };
  listeners.clear();
}
