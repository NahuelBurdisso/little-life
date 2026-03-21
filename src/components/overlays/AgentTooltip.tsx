interface AgentTooltipProps {
  agent: { name: string; currentAction: any } | null;
  position: { x: number; y: number } | null;
}

export function AgentTooltip({ agent, position }: AgentTooltipProps) {
  if (!agent || !position) return null;

  const actionText =
    agent.currentAction?.description ??
    agent.currentAction?.type ??
    "Idle";

  return (
    <div
      className="fixed z-50 pointer-events-none px-2.5 py-1.5 bg-gray-900/90 border border-gray-600 rounded text-xs shadow-lg max-w-48"
      style={{
        left: position.x + 12,
        top: position.y - 8,
      }}
    >
      <div className="font-bold text-white">{agent.name}</div>
      <div className="text-gray-400 mt-0.5">{actionText}</div>
    </div>
  );
}
