import { useState, useRef, useEffect, memo } from "react";
import { trpc } from "../../lib/trpc";
import { useConversations } from "../../hooks/useConversations";
import { useAgents } from "../../hooks/useAgents";
import { ConversationViewer } from "./ConversationViewer";
import { ConversationDetail } from "./ConversationDetail";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

function realTimeAgo(timestamp: number | null | undefined): string {
  if (!timestamp) return '';
  const ms = Date.now() - timestamp;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Left-border colour only: the other three sides stay the panel's line colour. */
function sentimentBorderColor(sentiment: number | undefined): string {
  if (sentiment === undefined) return "border-l-ui-line";
  if (sentiment > 0.2) return "border-l-ui-good";
  if (sentiment < -0.2) return "border-l-ui-bad";
  return "border-l-ui-line";
}

/**
 * "Rosa & Omar" where each name is its own button that selects + focuses that
 * resident. Kept out of the row's toggle button because buttons can't nest.
 */
function ParticipantNames({
  ids,
  agentNames,
  onSelectAgent,
  className = "",
}: {
  ids: number[];
  agentNames: Map<string, string>;
  onSelectAgent?: (agentId: string) => void;
  className?: string;
}) {
  return (
    <span className={`min-w-0 truncate ${className}`}>
      {ids.map((id, i) => {
        const name = agentNames.get(String(id)) ?? `Agent ${id}`;
        return (
          <span key={id}>
            {i > 0 && <span className="text-ui-muted"> &amp; </span>}
            {onSelectAgent && agentNames.has(String(id)) ? (
              <button
                type="button"
                onClick={() => onSelectAgent(String(id))}
                title={`Go to ${name}`}
                className="cursor-pointer hover:text-ui-gold hover:underline underline-offset-2 focus-visible:text-ui-gold focus-visible:underline transition-colors"
              >
                {name}
              </button>
            ) : (
              name
            )}
          </span>
        );
      })}
    </span>
  );
}

// Memoized conversation item to prevent re-renders when parent list updates
const ActiveConvoItem = memo(function ActiveConvoItem({
  convo,
  agentNames,
  isExpanded,
  onToggle,
  onSelectAgent,
}: {
  convo: any;
  agentNames: Map<string, string>;
  isExpanded: boolean;
  onToggle: () => void;
  onSelectAgent?: (agentId: string) => void;
}) {
  return (
    <div className="rounded-sm overflow-hidden border border-ui-line bg-ui-raised">
      <div className="px-2 pt-1.5 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-ui-good flex-shrink-0" />
        <ParticipantNames
          ids={convo.participants as number[]}
          agentNames={agentNames}
          onSelectAgent={onSelectAgent}
          className="flex-1 text-xs text-ui-text"
        />
        <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-ui-good/15 text-ui-good flex-shrink-0">
          active
        </span>
      </div>
      <button
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full text-left px-2 pb-1.5 pt-0.5 pl-[22px] hover:bg-ui-hover transition-colors flex items-center gap-1.5 min-w-0"
      >
        {convo.topic && (
          <span className="text-[10px] text-ui-dim truncate italic">{convo.topic}</span>
        )}
        <span className="text-[9px] text-ui-muted shrink-0">{realTimeAgo(convo.started_at)}</span>
        <span className="ml-auto text-[9px] text-ui-muted shrink-0">{isExpanded ? "▲" : "▼"}</span>
      </button>
      {isExpanded && (
        <div className="border-t border-ui-line">
          <ConversationViewer conversation={convo} agentNames={agentNames} onSelectAgent={onSelectAgent} />
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
  onDetail,
  onSelectAgent,
}: {
  convo: any;
  agentNames: Map<string, string>;
  isExpanded: boolean;
  onToggle: () => void;
  onDetail: () => void;
  onSelectAgent?: (agentId: string) => void;
}) {
  return (
    <div
      className={`rounded-sm overflow-hidden border border-ui-line border-l-2 ${sentimentBorderColor(convo.sentiment)} bg-ui-raised`}
    >
      <div className="flex items-center gap-1.5 px-2 pt-1.5">
        <ParticipantNames
          ids={convo.participants as number[]}
          agentNames={agentNames}
          onSelectAgent={onSelectAgent}
          className="text-xs text-ui-text"
        />
        <span className="text-[9px] text-ui-muted shrink-0 ml-auto">
          {realTimeAgo(convo.ended_at ?? convo.started_at)}
        </span>
        <button
          onClick={onDetail}
          className="text-ui-muted hover:text-ui-gold text-[10px] shrink-0 transition-colors"
          title="View impact"
          aria-label="View conversation impact"
        >
          📊
        </button>
      </div>
      <button
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full text-left px-2 pb-1.5 pt-0.5 hover:bg-ui-hover transition-colors flex items-center min-w-0"
      >
        <span className="text-[10px] text-ui-dim truncate italic flex-1">
          {convo.topic ?? "Read the exchange"}
        </span>
        <span className="text-[9px] text-ui-muted shrink-0">{isExpanded ? "▲" : "▼"}</span>
      </button>
      {isExpanded && (
        <div className="border-t border-ui-line">
          <ConversationViewer conversation={convo} agentNames={agentNames} onSelectAgent={onSelectAgent} />
        </div>
      )}
    </div>
  );
});

interface ConversationPanelProps {
  /** Selects + focuses the resident whose name was clicked. */
  onSelectAgent?: (agentId: string) => void;
}

export function ConversationPanel({ onSelectAgent }: ConversationPanelProps) {
  const [expandedActiveId, setExpandedActiveId] = useState<number | null>(null);
  const [detailConvoId, setDetailConvoId] = useState<number | null>(null);
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
    <div className="h-full bg-ui-panel border-r border-ui-line flex flex-col overflow-hidden">
      {/* Panel header */}
      <div className="px-3 py-2 border-b border-ui-line flex-shrink-0">
        <span className="text-xs font-semibold text-ui-text uppercase tracking-wide">
          Conversations
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {/* Active Conversations section */}
        <div className="px-3 pt-2 pb-1">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-ui-dim uppercase tracking-wide">
              Active Conversations
            </span>
            {activeConversations.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ui-good/20 text-ui-good font-medium">
                {activeConversations.length}
              </span>
            )}
          </div>

          {activeConversations.length === 0 ? (
            <EmptyState
              compact
              icon="🤫"
              title="The town is quiet."
              hint="Live chats appear here as neighbours bump into each other."
            />
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
                  onSelectAgent={onSelectAgent}
                />
              ))}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-ui-line/50 mx-3 my-2" />

        {/* Recent Conversations section */}
        <div className="px-3 pb-3">
          <div className="text-xs font-medium text-ui-dim uppercase tracking-wide mb-2">
            Recent
          </div>

          {!recentConversations ? (
            <div className="space-y-1.5" role="status" aria-label="Loading conversations">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : recentConversations.length === 0 ? (
            <EmptyState
              compact
              icon="💬"
              title="Nobody has talked yet."
              hint="Finished conversations are kept here so you can read them back."
            />
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
                  onDetail={() => setDetailConvoId(convo.id)}
                  onSelectAgent={onSelectAgent}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <ConversationDetail
        conversationId={detailConvoId}
        onClose={() => setDetailConvoId(null)}
        onSelectAgent={onSelectAgent}
      />
    </div>
  );
}
