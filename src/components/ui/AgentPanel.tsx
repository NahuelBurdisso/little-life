import { trpc } from "../../lib/trpc";
import { useSelectedAgent } from "../../hooks/useSelectedAgent";
import { useConversations } from "../../hooks/useConversations";
import { useAgents } from "../../hooks/useAgents";
import { useWorldState } from "../../hooks/useWorldState";
import { formatMoney } from "../../lib/formatters";
import { AgentPortrait } from "./AgentPortrait";
import { NeedsBars } from "./NeedsBars";
import { ConversationViewer } from "./ConversationViewer";
import { RelationshipList } from "./RelationshipList";
import { MemoryLog } from "./MemoryLog";

interface AgentPanelProps {
  agentId: string;
  onClose: () => void;
}

function describeAction(action: any): string {
  if (!action) return "Idle";
  if (typeof action === "string") return action;
  if (action.type) {
    const type = action.type as string;
    const label = type.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    if (action.target) return `${label} (${action.target})`;
    if (action.locationName) return `${label} at ${action.locationName}`;
    return label;
  }
  return "Idle";
}

export function AgentPanel({ agentId, onClose }: AgentPanelProps) {
  const { data, relationships, memories, isLoading } =
    useSelectedAgent(agentId);
  const { world } = useWorldState();
  const { agents: allAgents } = useAgents();
  const { conversations: activeConversations } = useConversations();
  const { data: conversationHistory } = trpc.conversations.getHistory.useQuery(
    { agentId: Number(agentId), limit: 5 },
  );

  if (isLoading || !data?.agent) {
    return (
      <div className="w-[300px] flex-shrink-0 bg-gray-800 border-l border-gray-700 flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  const { agent, needs, economy } = data;
  const worldTick = world?.time?.totalTicks ?? 0;
  const tickSpeed = world?.tickSpeed ?? 1;

  return (
    <div className="w-[300px] flex-shrink-0 bg-gray-800 border-l border-gray-700 flex flex-col overflow-y-auto">
      {/* Header: portrait + close button */}
      <div className="p-3 border-b border-gray-700 flex justify-between items-start">
        <AgentPortrait
          agent={agent}
          economy={economy}
          mood={needs?.mood}
        />
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white text-lg leading-none ml-2 flex-shrink-0"
        >
          \u2715
        </button>
      </div>

      {/* Needs bars */}
      {needs && <NeedsBars needs={needs} />}

      {/* Economy info */}
      {economy && (
        <div className="px-3 py-2 border-b border-gray-700 text-sm">
          <span className="text-yellow-400">{formatMoney(economy.money)}</span>
          <span className="text-gray-400 ml-2">
            \u2022 {economy.jobTitle}
          </span>
        </div>
      )}

      {/* Current action */}
      <div className="px-3 py-2 border-b border-gray-700 text-sm text-gray-300">
        <span className="text-gray-500">Currently: </span>
        {describeAction(agent.currentAction)}
      </div>

      {/* Active conversation */}
      {(() => {
        const agentNameMap = new Map(allAgents.map((a: any) => [a._id, a.name]));
        const activeConvo = activeConversations.find((c: any) =>
          c.participants?.includes(agentId)
        );
        const recentConvos = (conversationHistory ?? []).slice(0, 3);

        if (!activeConvo && recentConvos.length === 0) return null;

        return (
          <>
            {activeConvo && (
              <ConversationViewer
                conversation={activeConvo}
                agentNames={agentNameMap}
              />
            )}
            {recentConvos.length > 0 && (
              <div className="px-3 py-2 border-b border-gray-700">
                <div className="text-xs text-gray-500 font-medium mb-1.5">
                  Recent Conversations ({recentConvos.length})
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {recentConvos.map((convo: any) => (
                    <ConversationViewer
                      key={convo._id}
                      conversation={convo}
                      agentNames={agentNameMap}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Traits */}
      {agent.traits && agent.traits.length > 0 && (
        <div className="px-3 py-2 border-b border-gray-700">
          <div className="flex flex-wrap gap-1">
            {agent.traits.map((trait: string) => (
              <span
                key={trait}
                className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300"
              >
                {trait}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Relationships */}
      <RelationshipList
        relationships={relationships ?? []}
        selectedAgentId={agentId}
      />

      {/* Memories */}
      <MemoryLog
        memories={memories ?? []}
        worldTick={worldTick}
        tickSpeed={tickSpeed}
      />
    </div>
  );
}
