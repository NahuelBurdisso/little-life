import { useCallback, useEffect, useRef, useState } from 'react';
import { useNightSkipStatus } from './useNightSkip';
import { readLastSeen, recapSince, skipRecapStep, writeLastSeen } from '../lib/lastSeen';

export interface RecapRequest {
  sinceMinute: number;
  /** `away`: the player came back after a gap; `overnight`: a night skip just ended. */
  kind: 'away' | 'overnight';
}

/** How often the "last seen" mark is refreshed while the tab is visible. */
const MARK_EVERY_MS = 5000;

/**
 * When to open the "Previously on…" card (RecapCard), and from which minute.
 *
 *  - On arrival: the first clock this tab sees for a world, against the mark
 *    left the last time it was watched (lib/lastSeen.ts). A world never seen in
 *    this browser gets nothing — the first-run guide owns that moment.
 *  - On returning to a hidden tab after the same gap: a background tab doesn't
 *    move the mark, so the town running on unwatched counts as time away.
 *  - When a night skip ends: "Overnight…" from the minute it started. The
 *    status comes off the `world.nightSkip` channel, which NightSkipButton
 *    (always mounted in the TopBar) subscribes to, so this reads without
 *    subscribing again.
 */
export function useRecap({
  worldKey,
  nowMinute,
  ready,
}: {
  /** firstRun.ts `worldSeedKey`; null for a world that can't be recognised (no recap). */
  worldKey: string | null;
  nowMinute: number | null;
  /** False on the wizard / loading screen: nothing is being watched yet. */
  ready: boolean;
}) {
  const [request, setRequest] = useState<RecapRequest | null>(null);
  const nowRef = useRef(nowMinute);
  nowRef.current = nowMinute;

  // Arrival. Declared before the marking effect so the old mark is read before
  // anything overwrites it.
  const arrivedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || worldKey == null || nowMinute == null) return;
    if (arrivedFor.current === worldKey) return;
    arrivedFor.current = worldKey;
    const since = recapSince(readLastSeen(worldKey), nowMinute);
    setRequest(since != null ? { sinceMinute: since, kind: 'away' } : null);
    writeLastSeen(worldKey, nowMinute);
  }, [ready, worldKey, nowMinute]);

  // A clock running backwards is a world replaced under the same seeds
  // (Restart): a card about the old town would name strangers.
  const lastNow = useRef<number | null>(null);
  useEffect(() => {
    if (nowMinute == null) return;
    if (lastNow.current != null && nowMinute < lastNow.current) setRequest(null);
    lastNow.current = nowMinute;
  }, [nowMinute]);

  // Keep the mark current while the player can see the town.
  useEffect(() => {
    if (!ready || worldKey == null) return;
    const mark = () => {
      const now = nowRef.current;
      if (now != null) writeLastSeen(worldKey, now);
    };
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') mark();
    }, MARK_EVERY_MS);
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        // What they saw last is the town as the tab went away.
        mark();
        return;
      }
      const now = nowRef.current;
      if (now == null) return;
      const since = recapSince(readLastSeen(worldKey), now);
      if (since != null) setRequest({ sinceMinute: since, kind: 'away' });
      mark();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', mark);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', mark);
    };
  }, [ready, worldKey]);

  // Night skip: remember where it started while it runs; recap when it stops.
  const skip = useNightSkipStatus(false);
  const skipStart = useRef<number | null>(null);
  useEffect(() => {
    if (!skip) return;
    const step = skipRecapStep(skipStart.current, skip);
    skipStart.current = step.watchedStart;
    if (step.recapSince != null) setRequest({ sinceMinute: step.recapSince, kind: 'overnight' });
  }, [skip]);

  const dismiss = useCallback(() => setRequest(null), []);
  return { request, dismiss };
}
