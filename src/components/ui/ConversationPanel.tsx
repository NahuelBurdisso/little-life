import { useState, useRef, useEffect, memo } from "react";
import { trpc } from "../../lib/trpc";
import { useConversations } from "../../hooks/useConversations";
import { useAgents } from "../../hooks/useAgents";
import { ConversationViewer } from "./ConversationViewer";

function realTimeAgo(timestamp: number | null | undefined): string {
  if (!timestamp) return '';
  const ms = Date.now() - timestamp;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function sentimentBorderColor(sentiment: number | undefined): string {
  if (sentiment === undefined) return "border-gray-700";
  if (sentiment > 0.2) return "border-green-700";
  if (sentiment < -0.2) return "border-red-700";
  return "border-gray-700";
}

// Memoized conversation item to prevent re-renders when parent list updates
const ActiveConvoItem = memo(function ActiveConvoItem({
  convo,
  agentNames,
  isExpanded,
  onToggle,
}: {
  convo: any;
  agentNames: Map<string, string>;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const names = (convo.participants as number[])
    .map((id) => agentNames.get(String(id)) ?? `Agent ${id}`)
    .join(" & ");

  return (
    <div className="rounded-md overflow-hidden border border-gray-700 bg-gray-750">
      <button
        onClick={onToggle}
        className="w-full text-left px-2 py-1.5 hover:bg-gray-700/50 transition-colors flex items-center gap-2"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-white truncate">{names}</div>
          <div className="flex gap-1.5 items-center">
            {convo.topic && (
              <span className="text-[10px] text-gray-500 truncate italic">{convo.topic}</span>
            )}
            <span className="text-[9px] text-gray-600 shrink-0">{realTimeAgo(convo.started_at)}</span>
          </div>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-300 flex-shrink-0">
          active
        </span>
      </button>
      {isExpanded && (
        <div className="border-t border-gray-700">
          <ConversationViewer conversation={convo} agentNames={agentNames} />
        </div>
      )}
    </div>
  );
});

const RecentConvoItem = memo(function RecentConvoItem({
  convo,
  agentNames,
  isExpanded,
  onToggle,
}: {
  convo: any;
  agentNames: Map<string, string>;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const names = (convo.participants as number[])
    .map((id) => agentNames.get(String(id)) ?? `Agent ${id}`)
    .join(" & ");

  return (
    <div
      className={`rounded-md overflow-hidden border-l-2 ${sentimentBorderColor(convo.sentiment)} border border-gray-700 bg-gray-750`}
    >
      <button
        onClick={onToggle}
        className="w-full text-left px-2 py-1.5 hover:bg-gray-700/50 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-300 truncate">{names}</span>
          <span className="text-[9px] text-gray-600 shrink-0">{realTimeAgo(convo.ended_at ?? convo.started_at)}</span>
        </div>
        {convo.topic && (
          <div className="text-[10px] text-gray-500 truncate italic">{convo.topic}</div>
        )}
      </button>
      {isExpanded && (
        <div className="border-t border-gray-700">
          <ConversationViewer conversation={convo} agentNames={agentNames} />
        </div>
      )}
    </div>
  );
});

export function ConversationPanel() {
  const [expandedActiveId, setExpandedActiveId] = useState<number | null>(null);
  const [expandedRecentId, setExpandedRecentId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPosRef = useRef(0);

  const { conversations: activeConversations } = useConversations();
  const { agents } = useAgents();
  const { data: recentConversations } = trpc.conversations.getRecent.useQuery({ limit: 10 });

  const agentNames = new Map(agents.map((a: any) => [String(a.id), a.name]));

  // Preserve scroll position across re-renders
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      scrollPosRef.current = el.scrollTop;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  // Restore scroll position after data updates
  useEffect(() => {
    const el = scrollRef.current;
    if (el && scrollPosRef.current > 0) {
      el.scrollTop = scrollPosRef.current;
    }
  }, [activeConversations, recentConversations]);

  return (
    <div className="h-full bg-gray-800 border-r border-gray-700 flex flex-col overflow-hidden">
      {/* Panel header */}
      <div className="px-3 py-2 border-b border-gray-700 flex-shrink-0">
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wide">
          Conversations
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
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
              {activeConversations.map((convo: any) => (
                <ActiveConvoItem
                  key={convo.id}
                  convo={convo}
                  agentNames={agentNames}
                  isExpanded={expandedActiveId === convo.id}
                  onToggle={() =>
                    setExpandedActiveId(expandedActiveId === convo.id ? null : convo.id)
                  }
                />
              ))}
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
              {recentConversations.map((convo: any) => (
                <RecentConvoItem
                  key={convo.id}
                  convo={convo}
                  agentNames={agentNames}
                  isExpanded={expandedRecentId === convo.id}
                  onToggle={() =>
                    setExpandedRecentId(expandedRecentId === convo.id ? null : convo.id)
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
