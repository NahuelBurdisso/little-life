import { useEffect, useRef } from 'react';
import { trpc } from '../lib/trpc';
import { useBrewing } from './useBrewing';
import { getCameraView } from '../lib/cameraView';
import {
  SPOTLIGHT_SEND_MS,
  buildSpotlight,
  residentsInView,
  shouldSendSpotlight,
  spotlightKey,
} from '../lib/spotlightSet';

interface UseSpotlightArgs {
  selectedAgentId: string | null;
  favorites: ReadonlySet<string>;
  /** The director's current shot (null when the director is off or between cuts). */
  shot: { agentIds: readonly number[] } | null;
  agents: ReadonlyArray<{ id: number | string; position?: { x: number; y: number } | null }>;
}

/**
 * Tells the server who is on the player's screen (lib/spotlightSet.ts says who
 * counts), so its few LLM slots go to the conversations the player is reading.
 *
 * Recomputed every SPOTLIGHT_SEND_MS on an interval that reads the latest
 * inputs through a ref — selection and camera changes are frequent and the
 * server needs none of them faster than that — and sent only when the set
 * changed, plus a keep-alive before the server's TTL forgets it. A failed send
 * is retried on the next pass.
 */
export function useSpotlight({ selectedAgentId, favorites, shot, agents }: UseSpotlightArgs): void {
  // Riding on the existing activity subscription for freshness (see useBrewing).
  const { brewing } = useBrewing();
  const live = useRef({ selectedAgentId, favorites, shot, agents, brewing });
  live.current = { selectedAgentId, favorites, shot, agents, brewing };

  const { mutate } = trpc.world.setSpotlight.useMutation();
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;

  useEffect(() => {
    let lastKey: string | null = null;
    let lastSentAt = 0;
    const pass = () => {
      const cur = live.current;
      const ids = buildSpotlight({
        selectedAgentId: cur.selectedAgentId,
        shotAgentIds: cur.shot?.agentIds ?? [],
        brewing: cur.brewing,
        inView: residentsInView(cur.agents, getCameraView()),
        favorites: cur.favorites,
      });
      const key = spotlightKey(ids);
      const now = Date.now();
      if (!shouldSendSpotlight({ key, lastKey, lastSentAt, now })) return;
      lastKey = key;
      lastSentAt = now;
      mutateRef.current({ agentIds: ids }, {
        onError: () => {
          lastKey = null;
        },
      });
    };
    pass();
    const id = window.setInterval(pass, SPOTLIGHT_SEND_MS);
    return () => window.clearInterval(id);
  }, []);
}
