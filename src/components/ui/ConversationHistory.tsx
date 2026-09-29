import { useState, useMemo } from "react";
import { trpc } from "../../lib/trpc";
import { ConversationDetail } from "./ConversationDetail";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

interface ConversationHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  /** Participant names jump to that resident (the caller closes this modal). */
  onSelectAgent?: (agentId: string) => void;
}

type SentimentFilter = "all" | "positive" | "negative" | "neutral";
type TypeFilter = "all" | "llm" | "template";

function sentimentColor(s: number | null): string {
  if (s == null) return "#6a6250";
  if (s > 0.2) return "#10b981";
  if (s < -0.2) return "#ef4444";
  return "#8a7f65";
}

function sentimentLabel(s: number | null): string {
  if (s == null) return "?";
  if (s > 0.5) return "Very Positive";
  if (s > 0.2) return "Positive";
  if (s < -0.5) return "Very Negative";
  if (s < -0.2) return "Negative";
  return "Neutral";
}

function timeAgoReal(timestamp: number | null): string {
  if (!timestamp) return "";
  const ms = Date.now() - timestamp;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function ConversationHistory({ isOpen, onClose, onSelectAgent }: ConversationHistoryProps) {
  const { data: allConvos } = trpc.conversations.getAll.useQuery(
    { limit: 200 },
    { enabled: isOpen },
  );
  const [search, setSearch] = useState("");
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [selectedConvoId, setSelectedConvoId] = useState<number | null>(null);

  const filtered = useMemo(() => {
    if (!allConvos) return [];
    return allConvos.filter((c) => {
      // Search filter
      if (search) {
        const q = search.toLowerCase();
        const matchesName = c.participantNames.some((n: string) => n.toLowerCase().includes(q));
        const matchesTopic = c.topic?.toLowerCase().includes(q);
        const matchesPreview = c.preview?.toLowerCase().includes(q);
        if (!matchesName && !matchesTopic && !matchesPreview) return false;
      }
      // Sentiment filter
      if (sentimentFilter !== "all") {
        const s = c.sentiment ?? 0;
        if (sentimentFilter === "positive" && s <= 0.2) return false;
        if (sentimentFilter === "negative" && s >= -0.2) return false;
        if (sentimentFilter === "neutral" && (s > 0.2 || s < -0.2)) return false;
      }
      // Type filter — use trigger reason as source of truth
      if (typeFilter !== "all") {
        const isTemplate = (c.triggerReason ?? '').includes('template');
        if (typeFilter === "llm" && isTemplate) return false;
        if (typeFilter === "template" && !isTemplate) return false;
      }
      return true;
    });
  }, [allConvos, search, sentimentFilter, typeFilter]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-ui-panel border border-ui-line shadow-2xl w-[700px] max-w-[95vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-ui-line shrink-0">
          <h2 className="text-sm font-bold text-ui-text">Conversation History</h2>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ui-muted">
              {filtered.length}/{allConvos?.length ?? 0}
            </span>
            <button onClick={onClose} className="text-ui-dim hover:text-ui-text text-lg leading-none">
              &times;
            </button>
          </div>
        </div>

        {/* Search + Filters */}
        <div className="px-4 py-2 border-b border-ui-line space-y-2 shrink-0">
          <input
            type="text"
            placeholder="Search by agent name, topic, or content..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-ui-deep border border-ui-line rounded-sm px-3 py-1.5 text-xs text-ui-text placeholder-ui-muted focus:outline-none focus:border-ui-gold"
          />
          <div className="flex gap-1.5">
            {/* Sentiment filters */}
            {(["all", "positive", "neutral", "negative"] as SentimentFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setSentimentFilter(f)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  sentimentFilter === f
                    ? "bg-ui-hover text-ui-text border-ui-line-accent"
                    : "text-ui-dim border-ui-line hover:border-ui-line-accent"
                }`}
              >
                {f === "positive" ? "😊" : f === "negative" ? "😠" : f === "neutral" ? "😐" : "🔗"} {f}
              </button>
            ))}
            <div className="w-px bg-ui-line mx-1" />
            {/* Type filters */}
            {(["all", "llm", "template"] as TypeFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setTypeFilter(f)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  typeFilter === f
                    ? "bg-ui-hover text-ui-text border-ui-line-accent"
                    : "text-ui-dim border-ui-line hover:border-ui-line-accent"
                }`}
              >
                {f === "llm" ? "🤖" : f === "template" ? "📝" : "📋"} {f}
              </button>
            ))}
          </div>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto">
          {!allConvos ? (
            <div className="divide-y divide-ui-line/50" role="status" aria-label="Loading conversations">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="px-4 py-3 space-y-1.5">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-2.5 w-3/4" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            allConvos.length === 0 ? (
              <EmptyState
                icon="💬"
                title="Nobody has talked yet."
                hint="Every finished conversation is archived here, searchable by name, topic or line."
              />
            ) : (
              <EmptyState
                icon="🔍"
                title="No conversation matches."
                hint="Try a different name or topic, or reset the filters above."
              />
            )
          ) : (
            <div className="divide-y divide-ui-line/50">
              {filtered.map((c) => (
                // A div, not a button, because the participant names inside are
                // buttons of their own (buttons can't nest). The content column
                // is the keyboard target; the row itself is a mouse convenience.
                <div
                  key={c.id}
                  onClick={() => setSelectedConvoId(c.id)}
                  className="group w-full px-4 py-2.5 cursor-pointer hover:bg-ui-hover transition-colors flex gap-3"
                >
                  {/* Sentiment indicator */}
                  <div className="shrink-0 pt-0.5">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: sentimentColor(c.sentiment) }}
                      title={sentimentLabel(c.sentiment)}
                    />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ui-text font-medium truncate">
                        {(c.participants as number[]).map((id, i) => (
                          <span key={id}>
                            {i > 0 && <span className="text-ui-muted"> &amp; </span>}
                            {onSelectAgent ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectAgent(String(id));
                                }}
                                title={`Go to ${c.participantNames[i]}`}
                                className="cursor-pointer hover:text-ui-gold hover:underline underline-offset-2 focus-visible:text-ui-gold focus-visible:underline transition-colors"
                              >
                                {c.participantNames[i]}
                              </button>
                            ) : (
                              c.participantNames[i]
                            )}
                          </span>
                        ))}
                      </span>
                      <span className="text-[9px] text-ui-muted shrink-0">
                        {timeAgoReal(c.endedAt ?? c.startedAt)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedConvoId(c.id)}
                      className="block w-full text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-ui-gold"
                      aria-label={`Open conversation between ${c.participantNames.join(" and ")}`}
                    >
                      <div className="flex items-center gap-2 mt-0.5">
                        {c.topic && (
                          <span className="text-[10px] text-ui-dim italic truncate">{c.topic}</span>
                        )}
                        <span className="text-[9px] text-ui-muted shrink-0">
                          {c.turnCount} turn{c.turnCount !== 1 ? "s" : ""}
                        </span>
                      </div>
                      {c.preview && (
                        <div className="text-[10px] text-ui-muted truncate mt-0.5">
                          {c.preview}
                        </div>
                      )}
                    </button>
                  </div>

                  {/* Sentiment badge */}
                  <div className="shrink-0 flex items-center">
                    <span
                      className="text-[9px] px-1.5 py-0.5 rounded-sm"
                      style={{
                        color: sentimentColor(c.sentiment),
                        backgroundColor: sentimentColor(c.sentiment) + "15",
                      }}
                    >
                      {c.sentiment != null ? (c.sentiment > 0 ? "+" : "") + c.sentiment.toFixed(1) : "?"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail modal */}
      <ConversationDetail
        conversationId={selectedConvoId}
        onClose={() => setSelectedConvoId(null)}
        onSelectAgent={onSelectAgent}
      />
    </div>
  );
}
