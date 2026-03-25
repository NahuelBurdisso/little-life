import { trpc } from '../lib/trpc';

export function useNudge() {
  const mutation = trpc.nudge.execute.useMutation();

  return {
    suggestTalk: (agentA: string, agentB: string, topic?: string) =>
      mutation.mutateAsync({ action: { type: "suggest_talk", agentA, agentB, topic } }),
    suggestGoTo: (agentId: string, locationId: string) =>
      mutation.mutateAsync({ action: { type: "suggest_go_to", agentId, locationId } }),
    triggerEvent: (eventType: string) =>
      mutation.mutateAsync({ action: { type: "trigger_event", eventType } }),
    giveMoney: (agentId: string, amount: number) =>
      mutation.mutateAsync({ action: { type: "give_money", agentId, amount } }),
    changeSpeed: (speed: number) =>
      mutation.mutateAsync({ action: { type: "change_speed", speed } }),
    togglePause: () =>
      mutation.mutateAsync({ action: { type: "toggle_pause" } }),
    introduceAgent: (name: string, bio: string, traits: string[], job: string) =>
      mutation.mutateAsync({ action: { type: "introduce_agent", name, bio, traits, job } }),
    removeAgent: (agentId: string) =>
      mutation.mutateAsync({ action: { type: "remove_agent", agentId } }),
  };
}
