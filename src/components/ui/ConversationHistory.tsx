import { useState, useMemo } from "react";
import { trpc } from "../../lib/trpc";
import { ConversationDetail } from "./ConversationDetail";

interface ConversationHistoryProps {
  isOpen: boolean;
  onClose: () => void;
}

type SentimentFilter = "all" | "positive" | "negative" | "neutral";
type TypeFilter = "all" | "llm" | "template";

function sentimentColor(s: number | null): string {
  if (s == null) return "#6b7280";
  if (s > 0.2) return "#22c55e";
  if (s < -0.2) return "#ef4444";
  return "#9ca3af";
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

export function ConversationHistory({ isOpen, onClose }: ConversationHistoryProps) {
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
        className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[700px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700 shrink-0">
          <h2 className="text-sm font-bold text-white">Conversation History</h2>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500">
              {filtered.length}/{allConvos?.length ?? 0}
            </span>
            <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">
              &times;
            </button>
          </div>
        </div>

        {/* Search + Filters */}
        <div className="px-4 py-2 border-b border-gray-700 space-y-2 shrink-0">
          <input
            type="text"
            placeholder="Search by agent name, topic, or content..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-gray-900 border border-gray-600 rounded-md px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <div className="flex gap-1.5">
            {/* Sentiment filters */}
            {(["all", "positive", "neutral", "negative"] as SentimentFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setSentimentFilter(f)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  sentimentFilter === f
                    ? "bg-gray-600 text-white border-gray-500"
                    : "text-gray-400 border-gray-700 hover:border-gray-500"
                }`}
              >
                {f === "positive" ? "😊" : f === "negative" ? "😠" : f === "neutral" ? "😐" : "🔗"} {f}
              </button>
            ))}
            <div className="w-px bg-gray-700 mx-1" />
            {/* Type filters */}
            {(["all", "llm", "template"] as TypeFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setTypeFilter(f)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  typeFilter === f
                    ? "bg-gray-600 text-white border-gray-500"
                    : "text-gray-400 border-gray-700 hover:border-gray-500"
                }`}
              >
                {f === "llm" ? "🤖" : f === "template" ? "📝" : "📋"} {f}
              </button>
            ))}
          </div>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-5 py-8 text-center text-xs text-gray-500">
              {allConvos?.length === 0 ? "No conversations yet." : "No conversations match your search."}
            </div>
          ) : (
            <div className="divide-y divide-gray-700/50">
              {filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedConvoId(c.id)}
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-700/30 transition-colors flex gap-3"
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
                      <span className="text-xs text-white font-medium truncate">
                        {c.participantNames.join(" & ")}
                      </span>
                      <span className="text-[9px] text-gray-600 shrink-0">
                        {timeAgoReal(c.endedAt ?? c.startedAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {c.topic && (
                        <span className="text-[10px] text-gray-400 italic truncate">{c.topic}</span>
                      )}
                      <span className="text-[9px] text-gray-600 shrink-0">
                        {c.turnCount} turn{c.turnCount !== 1 ? "s" : ""}
                      </span>
                    </div>
                    {c.preview && (
                      <div className="text-[10px] text-gray-500 truncate mt-0.5">
                        {c.preview}
                      </div>
                    )}
                  </div>

                  {/* Sentiment badge */}
                  <div className="shrink-0 flex items-center">
                    <span
                      className="text-[9px] px-1.5 py-0.5 rounded"
                      style={{
                        color: sentimentColor(c.sentiment),
                        backgroundColor: sentimentColor(c.sentiment) + "15",
                      }}
                    >
                      {c.sentiment != null ? (c.sentiment > 0 ? "+" : "") + c.sentiment.toFixed(1) : "?"}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail modal */}
      <ConversationDetail
        conversationId={selectedConvoId}
        onClose={() => setSelectedConvoId(null)}
      />
    </div>
  );
}
