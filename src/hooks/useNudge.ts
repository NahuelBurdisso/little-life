import { trpc } from '../lib/trpc';
import { emitCanvasEvent } from '../lib/canvasBus';

/**
 * Resolve `p`, then tell the canvas the player just acted on these agents so it can
 * answer with something visible right away (the server's own reaction takes a poll).
 */
function announce<T>(p: Promise<T>, kind: string, agentIds: Array<number | string>): Promise<T> {
  return p.then((r) => {
    emitCanvasEvent({ type: 'intervention', kind, agentIds: agentIds.map(Number) });
    return r;
  });
}

export function useNudge() {
  const mutation = trpc.nudge.execute.useMutation();

  return {
    suggestTalk: (agentA: number | string, agentB: number | string, topic?: string) =>
      announce(mutation.mutateAsync({ action: { type: "suggest_talk", agentA: Number(agentA), agentB: Number(agentB), topic } }), 'suggest_talk', [agentA, agentB]),
    suggestGoTo: (agentId: number | string, locationId: number | string) =>
      announce(mutation.mutateAsync({ action: { type: "suggest_go_to", agentId: Number(agentId), locationId: Number(locationId) } }), 'suggest_go_to', [agentId]),
    triggerEvent: (eventType: string) =>
      mutation.mutateAsync({ action: { type: "trigger_event", eventType } }),
    giveMoney: (agentId: number | string, amount: number) =>
      announce(mutation.mutateAsync({ action: { type: "give_money", agentId: Number(agentId), amount } }), 'give_money', [agentId]),
    changeSpeed: (speed: number) =>
      mutation.mutateAsync({ action: { type: "change_speed", speed } }),
    togglePause: () =>
      mutation.mutateAsync({ action: { type: "toggle_pause" } }),
    introduceAgent: (name: string, bio: string, traits: string[], job: string) =>
      mutation.mutateAsync({ action: { type: "introduce_agent", name, bio, traits, job } }),
    removeAgent: (agentId: number | string) =>
      mutation.mutateAsync({ action: { type: "remove_agent", agentId: Number(agentId) } }),
    tellSecret: (agentId: number | string, targetId: number | string, factId: number) =>
      announce(mutation.mutateAsync({ action: { type: "tell_secret", agentId: Number(agentId), targetId: Number(targetId), factId } }), 'tell_secret', [agentId, targetId]),
    forceConfront: (agentA: number | string, agentB: number | string) =>
      announce(mutation.mutateAsync({ action: { type: "force_confront", agentA: Number(agentA), agentB: Number(agentB) } }), 'force_confront', [agentA, agentB]),
  };
}
