import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { trpc } from '../lib/trpc';
import { pushToast } from '../lib/toast';
import { emitCanvasEvent } from '../lib/canvasBus';
import {
  applyRows, loadAchievements, saveAchievements, takeNewRows,
  type AchievementRow, type AchievementState, type RowWatch,
} from '../lib/achievements';
import type { Challenge } from '../../server/lib/challenges/catalog';

/**
 * The player's goals on the client.
 *
 * - `useChallenges` — the Journal's 🏆 tab: this world's offers, running
 *   challenges and history (`challenges.list`, refreshed by the `challenges`
 *   channel), plus accept / abandon with a toast either way.
 * - `useGoalWatcher` — mounted once in App: reads the activity rows the canvas
 *   already polls, fires the celebratory FX/sound on the canvas bus when a
 *   challenge settles, and folds every new row into the cross-world
 *   achievements (lib/achievements.ts), toasting each unlock.
 * - `useAchievementState` — the achievements for the tab, live.
 */

export function useChallenges() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.challenges.list.useQuery();
  trpc.challenges.onUpdate.useSubscription(undefined, {
    onData: () => { void utils.challenges.list.invalidate(); },
  });

  const chooseM = trpc.challenges.choose.useMutation();
  const abandonM = trpc.challenges.abandon.useMutation();

  const choose = useCallback((c: Challenge) => {
    chooseM.mutate({ id: c.id }, {
      onSuccess: (r) => {
        if (r.ok) pushToast(`Challenge accepted: ${r.challenge.goal}`, 'success', '🏆');
        else pushToast(r.reason, 'warning');
        void utils.challenges.list.invalidate();
      },
      onError: (err) => pushToast(`Couldn't accept: ${err.message}`, 'error'),
    });
  }, [chooseM, utils]);

  const abandon = useCallback((c: Challenge) => {
    abandonM.mutate({ id: c.id }, {
      onSuccess: (r) => {
        if (r.ok) pushToast(`Challenge abandoned: ${c.goal}`, 'info', '🏳');
        else pushToast(r.reason, 'warning');
        void utils.challenges.list.invalidate();
      },
      onError: (err) => pushToast(`Couldn't abandon: ${err.message}`, 'error'),
    });
  }, [abandonM, utils]);

  return {
    view: data ?? null,
    isLoading,
    choose,
    abandon,
    busy: chooseM.isPending || abandonM.isPending,
  };
}

// ─── Achievements store (module level: one per tab, shared by every reader) ──

let achievements: AchievementState = loadAchievements();
const listeners = new Set<() => void>();

function setAchievements(next: AchievementState): void {
  achievements = next;
  saveAchievements(next);
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useAchievementState(): AchievementState {
  return useSyncExternalStore(subscribe, () => achievements, () => achievements);
}

const CHALLENGE_ROWS = new Set(['challenge_completed', 'challenge_failed']);

/**
 * Same query key as `useCanvasActivity` (`getRecent`, limit 50), so this adds
 * no request: the canvas's subscription keeps the shared cache entry fresh.
 */
export function useGoalWatcher(enabled: boolean): void {
  const { data } = trpc.activity.getRecent.useQuery({ limit: 50 }, { enabled });
  const watch = useRef<RowWatch>({ watermark: null });

  useEffect(() => {
    if (!data) return;
    const rows = takeNewRows(watch.current, data as unknown as Array<AchievementRow & { agent_ids?: number[] | null }>);
    if (rows.length === 0) return;

    let celebrated = false;
    for (const r of rows) {
      if (!CHALLENGE_ROWS.has(r.type)) continue;
      emitCanvasEvent({
        type: 'celebrate', kind: 'challenge', success: r.type === 'challenge_completed', agentIds: r.agent_ids ?? [],
      });
      celebrated = true;
    }

    const { state, unlocked } = applyRows(achievements, rows, Date.now());
    if (JSON.stringify(state) !== JSON.stringify(achievements)) setAchievements(state);
    for (const def of unlocked) pushToast(`Achievement unlocked: ${def.name} — ${def.how}`, 'success', def.icon);
    // One fanfare per moment: a challenge that also unlocks a trophy already got one.
    if (unlocked.length > 0 && !celebrated) {
      emitCanvasEvent({ type: 'celebrate', kind: 'achievement', success: true, agentIds: [] });
    }
  }, [data]);
}
