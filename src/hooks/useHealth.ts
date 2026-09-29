import { useEffect, useRef, useState } from 'react';
import { trpc } from '../lib/trpc';
import { useConnectionState } from '../lib/connectionState';
import { bannerKey, pickBanner, type Banner } from '../lib/healthBanner';

/**
 * The banner to show right now (or null), with its dismiss handler.
 *
 * Health is pushed on the `world.health` channel, which the server marks dirty
 * only when the verdict changes (lib/health.ts), so this refetches a handful of
 * times per outage rather than per tick.
 *
 * A reconnect refetches every query: pushes sent while the socket was down are
 * gone, and `refetchOnWindowFocus` is off app-wide, so without this the whole UI
 * would keep showing the world as of the moment the connection dropped.
 */
export function useHealthBanner(): { banner: Banner | null; dismiss: () => void } {
  const utils = trpc.useUtils();
  const connection = useConnectionState();
  const { data: health } = trpc.world.getHealth.useQuery(undefined, { retry: false });

  trpc.world.onHealthChange.useSubscription(undefined, {
    onData: () => { utils.world.getHealth.invalidate(); },
  });

  const seenReconnects = useRef(connection.reconnects);
  useEffect(() => {
    if (connection.reconnects !== seenReconnects.current) {
      seenReconnects.current = connection.reconnects;
      utils.invalidate();
    }
  }, [connection.reconnects, utils]);

  const banner = pickBanner({ connection: connection.status, health });
  const key = bannerKey(banner);

  // A dismissal lasts while that condition does. Once it clears, forget it, so
  // the next outage announces itself again.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  useEffect(() => {
    if (key === null && dismissedKey !== null) setDismissedKey(null);
  }, [key, dismissedKey]);

  const visible = banner && !(banner.dismissible && key === dismissedKey) ? banner : null;
  return { banner: visible, dismiss: () => setDismissedKey(key) };
}
