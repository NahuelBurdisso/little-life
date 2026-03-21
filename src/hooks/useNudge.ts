import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useNudge() {
  const nudgeMutation = useMutation(api.nudge.nudge);

  return {
    suggestTalk: (agentA: string, agentB: string, topic?: string) =>
      nudgeMutation({ action: { type: "suggest_talk", agentA, agentB, topic } }),
    suggestGoTo: (agentId: string, locationId: string) =>
      nudgeMutation({ action: { type: "suggest_go_to", agentId, locationId } }),
    triggerEvent: (eventType: string) =>
      nudgeMutation({ action: { type: "trigger_event", eventType } }),
    giveMoney: (agentId: string, amount: number) =>
      nudgeMutation({ action: { type: "give_money", agentId, amount } }),
    changeSpeed: (speed: number) =>
      nudgeMutation({ action: { type: "change_speed", speed } }),
    togglePause: () =>
      nudgeMutation({ action: { type: "toggle_pause" } }),
    introduceAgent: (name: string, bio: string, traits: string[], job: string) =>
      nudgeMutation({ action: { type: "introduce_agent", name, bio, traits, job } }),
    removeAgent: (agentId: string) =>
      nudgeMutation({ action: { type: "remove_agent", agentId } }),
  };
}
