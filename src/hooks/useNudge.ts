import { trpc } from '../lib/trpc';
import { emitCanvasEvent, type InterventionKind } from '../lib/canvasBus';
import { pushToast } from '../lib/toast';

/** What `nudge.execute` answers: `reason` on refusal, `queued`/`message` when it waits. */
interface NudgeResult {
  success: boolean;
  reason?: string;
  queued?: boolean;
  message?: string;
  agentId?: number;
}

type Id = number | string;

export function useNudge() {
  const mutation = trpc.nudge.execute.useMutation();
  const utils = trpc.useUtils();

  /** First name from the cached agent list; the toast reads better with names. */
  const nameOf = (id: Id): string => {
    const list = utils.agents.getActive.getData() as Array<{ id: number; name: string }> | undefined;
    const full = list?.find((a) => a.id === Number(id))?.name;
    return full ? full.split(' ')[0] : 'them';
  };

  /**
   * Run a player action and acknowledge it. On success: a toast and an `intervention`
   * on the canvas bus, so the canvas answers right away (the server's own reaction
   * takes a poll). A refusal ("X is sleeping") gets a warning toast and no canvas
   * effect — the old version pinged the agent even when nothing happened. Resolves
   * to the result either way; network errors become an error toast, never a rejection.
   */
  function run(
    input: Parameters<typeof mutation.mutateAsync>[0],
    announce?: {
      kind: InterventionKind;
      agentIds: Id[];
      success: string;
      icon?: string;
      locationId?: number;
      amount?: number;
    },
  ): Promise<NudgeResult> {
    return mutation.mutateAsync(input).then(
      (raw) => {
        const r = raw as NudgeResult;
        if (!announce) {
          if (!r.success) pushToast(r.reason ?? 'That did not work', 'warning');
          return r;
        }
        if (!r.success) {
          pushToast(r.reason ?? 'That did not work', 'warning');
          return r;
        }
        const ids = [...announce.agentIds, ...(r.agentId != null ? [r.agentId] : [])].map(Number);
        emitCanvasEvent({
          type: 'intervention',
          kind: announce.kind,
          agentIds: ids,
          locationId: announce.locationId,
          amount: announce.amount,
        });
        if (r.queued) pushToast(r.message ?? 'Queued', 'info', '⏳');
        else pushToast(announce.success, 'success', announce.icon);
        return r;
      },
      (err: unknown) => {
        pushToast(`Server error: ${err instanceof Error ? err.message : String(err)}`, 'error');
        return { success: false, reason: 'network' } as NudgeResult;
      },
    );
  }

  return {
    suggestTalk: (agentA: Id, agentB: Id, topic?: string) =>
      run({ action: { type: 'suggest_talk', agentA: Number(agentA), agentB: Number(agentB), topic } }, {
        kind: 'suggest_talk', agentIds: [agentA, agentB], icon: '💬',
        success: topic ? `${nameOf(agentA)} will bring up "${topic}" with ${nameOf(agentB)}` : `${nameOf(agentA)} and ${nameOf(agentB)} will have a chat`,
      }),
    suggestGoTo: (agentId: Id, locationId: Id, locationName?: string) =>
      run({ action: { type: 'suggest_go_to', agentId: Number(agentId), locationId: Number(locationId) } }, {
        kind: 'suggest_go_to', agentIds: [agentId], locationId: Number(locationId), icon: '📍',
        success: `${nameOf(agentId)} is heading to ${locationName ?? 'the spot'}`,
      }),
    triggerEvent: (eventType: string) =>
      run({ action: { type: 'trigger_event', eventType } }),
    giveMoney: (agentId: Id, amount: number) =>
      run({ action: { type: 'give_money', agentId: Number(agentId), amount } }, {
        kind: 'give_money', agentIds: [agentId], amount, icon: '🪙',
        success: `Gave ${nameOf(agentId)} ${amount} coins`,
      }),
    changeSpeed: (speed: number) =>
      run({ action: { type: 'change_speed', speed } }),
    togglePause: () =>
      run({ action: { type: 'toggle_pause' } }),
    // Refusals come back as a warning toast from `run` ("Resume the game first", ...).
    skipNight: () =>
      run({ action: { type: 'skip_night' } }),
    cancelNightSkip: () =>
      run({ action: { type: 'cancel_night_skip' } }),
    introduceAgent: (name: string, bio: string, traits: string[], job: string) =>
      run({ action: { type: 'introduce_agent', name, bio, traits, job } }, {
        kind: 'introduce_agent', agentIds: [], icon: '🏠',
        success: `${name} moved to town`,
      }),
    removeAgent: (agentId: Id) => {
      const name = nameOf(agentId);
      return run({ action: { type: 'remove_agent', agentId: Number(agentId) } }, {
        kind: 'remove_agent', agentIds: [agentId], icon: '👋',
        success: `${name} left town`,
      });
    },
    tellSecret: (agentId: Id, targetId: Id, factId: number) =>
      run({ action: { type: 'tell_secret', agentId: Number(agentId), targetId: Number(targetId), factId } }, {
        kind: 'tell_secret', agentIds: [agentId, targetId], icon: '🤫',
        success: `${nameOf(agentId)} will tell ${nameOf(targetId)} the secret`,
      }),
    forceConfront: (agentA: Id, agentB: Id) =>
      run({ action: { type: 'force_confront', agentA: Number(agentA), agentB: Number(agentB) } }, {
        kind: 'force_confront', agentIds: [agentA, agentB], icon: '⚔',
        success: `${nameOf(agentA)} is going to confront ${nameOf(agentB)}`,
      }),
  };
}
