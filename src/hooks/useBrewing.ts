import { trpc } from '../lib/trpc';

/**
 * What is about to boil over in the town (server/lib/brewing.ts), hottest first.
 *
 * Deliberately no subscription of its own: brewing has no channel, it moves with
 * the same ticks that write the activity log, and the always-mounted readers
 * (the feed's 🔥 chip, the canvas fuse icons) already hold an
 * `activity.onUpdate` subscription that invalidates this query; the Journal's
 * Brewing tab rides on them. Another subscription would only double the
 * invalidations. Anything new that reads this hook must keep one of those alive
 * or the list goes stale forever (`refetchOnWindowFocus` is off).
 */
export function useBrewing() {
  const { data, isLoading } = trpc.chronicle.getBrewing.useQuery();
  // A shared empty list, not a fresh `[]` per render: GameCanvas lists this in an
  // effect's dependencies, and a new identity every render would re-run it.
  return { brewing: data ?? NONE, isLoading };
}

const NONE: never[] = [];
