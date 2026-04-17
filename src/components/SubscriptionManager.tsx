import { useRef, useCallback } from 'react';
import { trpc } from '../lib/trpc';

/**
 * Single component that manages ALL tRPC subscriptions.
 * Consolidates 7+ duplicate subscription instances into exactly 4 (one per channel).
 * Debounces invalidations to prevent render cascades.
 */
export function SubscriptionManager() {
  const utils = trpc.useUtils();
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(new Set<string>());

  const flushInvalidations = useCallback(() => {
    const dirty = dirtyRef.current;
    if (dirty.size === 0) return;

    if (dirty.has('world')) {
      utils.world.getState.invalidate();
      utils.world.getActiveEvents.invalidate();
    }
    if (dirty.has('agents')) {
      utils.agents.getActive.invalidate();
    }
    if (dirty.has('conversations')) {
      utils.conversations.getActive.invalidate();
      utils.conversations.getRecent.invalidate();
    }
    if (dirty.has('activity')) {
      utils.activity.getRecent.invalidate();
    }

    dirty.clear();
    pendingRef.current = null;
  }, [utils]);

  const scheduleFlush = useCallback((channel: string) => {
    dirtyRef.current.add(channel);
    if (!pendingRef.current) {
      // Batch all invalidations that arrive within the same tick into one flush
      pendingRef.current = setTimeout(flushInvalidations, 50);
    }
  }, [flushInvalidations]);

  // One subscription per channel — no duplicates
  trpc.world.onStateChange.useSubscription(undefined, {
    onData: () => scheduleFlush('world'),
  });

  trpc.agents.onUpdate.useSubscription(undefined, {
    onData: () => scheduleFlush('agents'),
  });

  trpc.conversations.onUpdate.useSubscription(undefined, {
    onData: () => scheduleFlush('conversations'),
  });

  trpc.activity.onUpdate.useSubscription(undefined, {
    onData: () => scheduleFlush('activity'),
  });

  return null;
}
