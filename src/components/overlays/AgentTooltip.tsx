import { describeAction } from "../../lib/actionText";

interface AgentTooltipProps {
  agent: { name: string; currentAction: unknown; place?: string | null } | null;
  position: { x: number; y: number } | null;
}

export function AgentTooltip({ agent, position }: AgentTooltipProps) {
  if (!agent || !position) return null;

  const actionText = describeAction(agent.currentAction, agent.place);

  return (
    <div
      className="fixed z-50 pointer-events-none px-2.5 py-1.5 bg-ui-panel/95 border border-ui-line rounded-sm text-xs shadow-lg max-w-52"
      style={{
        left: position.x + 12,
        top: position.y - 8,
      }}
    >
      <div className="font-bold text-ui-text">{agent.name}</div>
      <div className="text-ui-dim mt-0.5">{actionText}</div>
    </div>
  );
}
