import React, { useState } from "react";
import { timeAgo } from "../../lib/formatters";
import { EmptyState } from "./EmptyState";

interface Memory {
  id: number;
  description: string;
  type: string;
  importance: number;
  emotional_valence: number;
  created_at: number;
  metadata: Record<string, unknown>;
}

interface MemoryLogProps {
  memories: Memory[];
  worldTick: number;
  tickSpeed: number;
  isPaused: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  observation: "bg-ui-blue/20 text-ui-blue",
  social: "bg-purple-900/50 text-purple-300",
  emotional: "bg-pink-900/50 text-pink-300",
  work: "bg-yellow-900/50 text-yellow-300",
  conversation: "bg-green-900/50 text-green-300",
  event: "bg-orange-900/50 text-orange-300",
  routine: "bg-ui-raised/50 text-ui-dim",
  reflection: "bg-purple-900/50 text-purple-300",
  plan: "bg-amber-900/50 text-amber-300",
  experience: "bg-teal-900/50 text-teal-300",
  opinion: "bg-indigo-900/50 text-indigo-300",
  gossip: "bg-yellow-900/50 text-yellow-300",
  secret: "bg-red-900/50 text-red-300",
};

function importanceDots(importance: number): React.ReactElement {
  // importance 0-10 mapped to 1-5 dots
  const count = Math.max(1, Math.min(5, Math.ceil(importance / 2)));
  return (
    <span className="inline-flex gap-px">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="inline-block w-1 h-1 rounded-full bg-ui-gold"
        />
      ))}
    </span>
  );
}

function valenceColor(valence: number): string {
  if (valence > 0.3) return "border-l-ui-good";
  if (valence < -0.3) return "border-l-ui-bad";
  return "border-l-ui-line";
}

const TYPE_FILTER_BUTTONS: { label: string; value: string | null }[] = [
  { label: "ALL", value: null },
  { label: "💬", value: "conversation" },
  { label: "👁", value: "observation" },
  { label: "💭", value: "reflection" },
  { label: "📋", value: "plan" },
];

export function MemoryLog({ memories, worldTick, tickSpeed, isPaused }: MemoryLogProps) {
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const filteredMemories = typeFilter
    ? memories.filter((m) => m.type === typeFilter)
    : memories;

  const displayMemories = filteredMemories.slice(0, 20);

  if (memories.length === 0) {
    return (
      <div className="px-3 py-2 border-b border-ui-line">
        <div className="text-xs text-ui-dim font-medium mb-1">Memories</div>
        <EmptyState
          compact
          icon="💭"
          title="No memories yet."
          hint="What they see, say and feel gets written down here as the day goes on."
        />
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-ui-line">
      <div className="text-xs text-ui-dim font-medium mb-1.5">
        Memories ({filteredMemories.length})
      </div>
      <div className="flex gap-1 mb-1.5 flex-wrap">
        {TYPE_FILTER_BUTTONS.map(({ label, value }) => (
          <button
            key={label}
            onClick={() => setTypeFilter(value)}
            className={`text-[10px] px-1.5 py-px rounded ${
              typeFilter === value
                ? "bg-ui-hover text-ui-text"
                : "bg-ui-raised text-ui-muted hover:text-ui-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
        {displayMemories.map((memory) => (
          <div
            key={memory.id}
            className={`border-l-2 ${valenceColor(memory.emotional_valence)} pl-2 py-0.5`}
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <span
                className={`text-[10px] px-1 py-px rounded ${TYPE_COLORS[memory.type] ?? TYPE_COLORS.routine}`}
              >
                {memory.type}
              </span>
              {importanceDots(memory.importance)}
              <span className="text-[10px] text-ui-muted ml-auto">
                {timeAgo(memory.created_at, worldTick, tickSpeed, isPaused)}
              </span>
            </div>
            <div className={`text-[11px] leading-tight ${memory.type === 'reflection' ? 'text-purple-300 italic' : 'text-ui-text'}`}>
              {memory.description}
            </div>
            {memory.type === 'reflection' &&
              (memory.metadata as any)?.citation_ids?.length > 0 && (
                <div className="text-[10px] text-ui-muted mt-0.5">
                  ── based on {(memory.metadata as any).citation_ids.length} memories
                </div>
              )}
          </div>
        ))}
      </div>
    </div>
  );
}
