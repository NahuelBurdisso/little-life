import { useState } from "react";
import { trpc } from "../../lib/trpc";
import { useConversations } from "../../hooks/useConversations";
import { useAgents } from "../../hooks/useAgents";
import { ConversationViewer } from "./ConversationViewer";

function sentimentBorderColor(sentiment: number | undefined): string {
  if (sentiment === undefined) return "border-gray-700";
  if (sentiment > 0.2) return "border-green-700";
  if (sentiment < -0.2) return "border-red-700";
  return "border-gray-700";
}

export function ConversationPanel() {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedActiveId, setExpandedActiveId] = useState<number | null>(null);
  const [expandedRecentId, setExpandedRecentId] = useState<number | null>(null);

  const { conversations: activeConversations } = useConversations();
  const { agents } = useAgents();
  const { data: recentConversations } = trpc.conversations.getRecent.useQuery({ limit: 10 });

  const agentNames = new Map(agents.map((a: any) => [String(a.id), a.name]));

  function participantNames(participants: number[]): string {
    return participants
      .map((id) => agentNames.get(String(id)) ?? `Agent ${id}`)
      .join(" & ");
  }

  if (collapsed) {
    return (
      <div
        className="flex-shrink-0 w-8 bg-gray-800 border-r border-gray-700 flex flex-col items-center pt-3 cursor-pointer hover:bg-gray-750 transition-colors"
        onClick={() => setCollapsed(false)}
        title="Show conversations"
      >
        <span className="text-base select-none">💬</span>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 w-[280px] bg-gray-800 border-r border-gray-700 flex flex-col overflow-hidden">
      {/* Panel header */}
      <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between flex-shrink-0">
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wide">
          Conversations
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="text-gray-500 hover:text-gray-300 text-sm leading-none transition-colors"
          title="Hide panel"
        >
          ◀
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Active Conversations section */}
        <div className="px-3 pt-2 pb-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
              Active Conversations
            </span>
            {activeConversations.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-900/60 text-green-300 font-medium">
                {activeConversations.length}
              </span>
            )}
          </div>

          {activeConversations.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No active conversations</p>
          ) : (
            <div className="space-y-1.5">
              {activeConversations.map((convo: any) => {
                const isExpanded = expandedActiveId === convo.id;
                return (
                  <div
                    key={convo.id}
                    className="rounded-md overflow-hidden border border-gray-700 bg-gray-750"
                  >
                    <button
                      onClick={() =>
                        setExpandedActiveId(isExpanded ? null : convo.id)
                      }
                      className="w-full text-left px-2 py-1.5 hover:bg-gray-700/50 transition-colors flex items-center gap-2"
                    >
                      {/* green active dot */}
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-white truncate">
                          {participantNames(convo.participants)}
                        </div>
                        {convo.topic && (
                          <div className="text-[10px] text-gray-500 truncate italic">
                            {convo.topic}
                          </div>
                        )}
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-300 flex-shrink-0">
                        active
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="border-t border-gray-700">
                        <ConversationViewer
                          conversation={convo}
                          agentNames={agentNames}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-gray-700/50 mx-3 my-2" />

        {/* Recent Conversations section */}
        <div className="px-3 pb-3">
          <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
            Recent
          </div>

          {!recentConversations || recentConversations.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No recent conversations</p>
          ) : (
            <div className="space-y-1.5">
              {recentConversations.map((convo: any) => {
                const isExpanded = expandedRecentId === convo.id;
                return (
                  <div
                    key={convo.id}
                    className={`rounded-md overflow-hidden border-l-2 ${sentimentBorderColor(convo.sentiment)} border border-gray-700 bg-gray-750`}
                  >
                    <button
                      onClick={() =>
                        setExpandedRecentId(isExpanded ? null : convo.id)
                      }
                      className="w-full text-left px-2 py-1.5 hover:bg-gray-700/50 transition-colors"
                    >
                      <div className="text-xs text-gray-300 truncate">
                        {participantNames(convo.participants)}
                      </div>
                      {convo.topic && (
                        <div className="text-[10px] text-gray-500 truncate italic">
                          {convo.topic}
                        </div>
                      )}
                    </button>
                    {isExpanded && (
                      <div className="border-t border-gray-700">
                        <ConversationViewer
                          conversation={convo}
                          agentNames={agentNames}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
