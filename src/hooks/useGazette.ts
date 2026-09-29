import { useCallback, useState } from 'react';
import { trpc } from '../lib/trpc';

const SEEN_KEY = 'littlelife.gazette.lastSeenId';

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * The newest Town Crier edition and whether the player has opened it yet.
 * The subscription refreshes every gazette query when an edition is printed
 * (there is no other refresh: refetchOnWindowFocus is off).
 */
export function useGazette() {
  const utils = trpc.useUtils();
  const { data: latest } = trpc.gazette.list.useQuery({ limit: 1 });
  const [seenId, setSeenId] = useState(readSeen);

  trpc.gazette.onNewIssue.useSubscription(undefined, {
    onData: () => {
      void utils.gazette.list.invalidate();
      void utils.gazette.get.invalidate();
    },
  });

  const latestId = latest?.[0]?.id ?? 0;
  const markSeen = useCallback(() => {
    setSeenId(latestId);
    try {
      localStorage.setItem(SEEN_KEY, String(latestId));
    } catch {
      // Private mode / blocked storage: the badge just reappears next session.
    }
  }, [latestId]);

  // "Different", not "greater": a replaced world restarts ids at 1, and its
  // first edition must still count as new.
  const hasNew = latestId > 0 && latestId !== seenId;

  return { hasNew, markSeen };
}
