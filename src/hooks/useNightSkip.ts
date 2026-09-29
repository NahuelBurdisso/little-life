import { useEffect, useRef } from 'react';
import { trpc } from '../lib/trpc';
import { pushToast } from '../lib/toast';
import { canSkipNight, describeSkipStop, type SkipAgent } from '../../server/lib/nightSkip';

/**
 * Running state of the "skip to morning" fast-forward, pushed on the
 * `world.nightSkip` channel (the server marks it dirty on start and stop only).
 * No toasts here: the canvas overlay also reads this (with `subscribe` off: the
 * skip button's own subscription already invalidates the shared query) and must
 * not double them.
 */
export function useNightSkipStatus(subscribe = true) {
  const utils = trpc.useUtils();
  const { data } = trpc.world.getNightSkip.useQuery();
  trpc.world.onNightSkipChange.useSubscription(undefined, {
    enabled: subscribe,
    onData: () => { utils.world.getNightSkip.invalidate(); },
  });
  return data ?? null;
}

type AgentLike = { id: number; name: string; current_action?: unknown };

function toSkipAgents(agents: AgentLike[]): SkipAgent[] {
  return agents.map((a) => {
    const type = (a.current_action as { type?: string } | null | undefined)?.type;
    // The server knows who is jailed; here only the dead (never in the active
    // list anyway) can be left out, and the server has the last word.
    return { asleep: type === 'sleeping', ignored: type === 'dead' };
  });
}

/**
 * Everything the skip button needs: may it be offered now (same pure rules the
 * server applies, from the clock and who is asleep), is one running, and how it
 * ended (announced once as a toast).
 */
export function useNightSkip() {
  const status = useNightSkipStatus();
  const { data: world } = trpc.world.getState.useQuery();
  const { data: agents } = trpc.agents.getActive.useQuery();

  const active = Boolean(status?.active);
  const verdict = world?.time
    ? canSkipNight({
        hour: world.time.hour,
        paused: Boolean(world.is_paused),
        active,
        agents: toSkipAgents((agents ?? []) as AgentLike[]),
      })
    : { ok: false as const, reason: '' };

  // Announce how the last skip ended, once per skip. The first status a page
  // load sees may describe a skip that ended before this tab opened: adopt its
  // sequence number silently.
  const seenSeq = useRef<number | null | undefined>(undefined);
  const names = useRef<Map<number, string>>(new Map());
  for (const a of (agents ?? []) as AgentLike[]) names.current.set(a.id, a.name.split(' ')[0]);

  useEffect(() => {
    if (status === null) return;
    const stop = status.lastStop;
    if (seenSeq.current === undefined) {
      seenSeq.current = stop?.seq ?? null;
      return;
    }
    if (!stop) {
      // A server restart starts the counter over; forget the old sequence, or the
      // first skip of the new process (seq 1) would look already announced.
      seenSeq.current = null;
      return;
    }
    if (stop.seq === seenSeq.current) return;
    seenSeq.current = stop.seq;
    if (stop.reason === 'cancelled' || stop.reason === 'world_replaced') return; // the player did that
    let text = describeSkipStop(stop.reason);
    if (stop.reason === 'woke' && stop.agentIds?.length) {
      const who = stop.agentIds.map((id) => names.current.get(id) ?? 'Someone');
      text = `Skip stopped: ${who.slice(0, 3).join(', ')}${who.length > 3 ? ' and others' : ''} woke up`;
    }
    if (stop.reason === 'morning') pushToast(text, 'success', '🌅');
    else pushToast(text, 'warning', '⏸');
  }, [status]);

  return {
    active,
    /** Offered right now (never true while one runs: the button turns into "stop"). */
    canSkip: verdict.ok,
    reason: verdict.ok ? null : verdict.reason,
  };
}
