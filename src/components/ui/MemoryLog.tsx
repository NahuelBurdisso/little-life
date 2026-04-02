import React, { useState } from "react";
import { timeAgo } from "../../lib/formatters";

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
}

const TYPE_COLORS: Record<string, string> = {
  observation: "bg-blue-900/50 text-blue-300",
  social: "bg-purple-900/50 text-purple-300",
  emotional: "bg-pink-900/50 text-pink-300",
  work: "bg-yellow-900/50 text-yellow-300",
  conversation: "bg-green-900/50 text-green-300",
  event: "bg-orange-900/50 text-orange-300",
  routine: "bg-gray-700/50 text-gray-400",
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
          className="inline-block w-1 h-1 rounded-full bg-amber-400"
        />
      ))}
    </span>
  );
}

function valenceColor(valence: number): string {
  if (valence > 0.3) return "border-l-green-600";
  if (valence < -0.3) return "border-l-red-600";
  return "border-l-gray-600";
}

const TYPE_FILTER_BUTTONS: { label: string; value: string | null }[] = [
  { label: "ALL", value: null },
  { label: "💬", value: "conversation" },
  { label: "👁", value: "observation" },
  { label: "💭", value: "reflection" },
  { label: "📋", value: "plan" },
];

export function MemoryLog({ memories, worldTick, tickSpeed }: MemoryLogProps) {
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const filteredMemories = typeFilter
    ? memories.filter((m) => m.type === typeFilter)
    : memories;

  const displayMemories = filteredMemories.slice(0, 20);

  if (memories.length === 0) {
    return (
      <div className="px-3 py-2 border-b border-gray-700">
        <div className="text-xs text-gray-500 font-medium mb-1">Memories</div>
        <div className="text-xs text-gray-600 italic">No memories yet.</div>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-gray-700">
      <div className="text-xs text-gray-500 font-medium mb-1.5">
        Memories ({filteredMemories.length})
      </div>
      <div className="flex gap-1 mb-1.5 flex-wrap">
        {TYPE_FILTER_BUTTONS.map(({ label, value }) => (
          <button
            key={label}
            onClick={() => setTypeFilter(value)}
            className={`text-[10px] px-1.5 py-px rounded ${
              typeFilter === value
                ? "bg-gray-600 text-gray-200"
                : "bg-gray-800 text-gray-500 hover:text-gray-400"
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
              <span className="text-[10px] text-gray-600 ml-auto">
                {timeAgo(memory.created_at, worldTick, tickSpeed)}
              </span>
            </div>
            <div className={`text-[11px] leading-tight ${memory.type === 'reflection' ? 'text-purple-300 italic' : 'text-gray-300'}`}>
              {memory.description}
            </div>
            {memory.type === 'reflection' &&
              (memory.metadata as any)?.citation_ids?.length > 0 && (
                <div className="text-[10px] text-gray-500 mt-0.5">
                  ── based on {(memory.metadata as any).citation_ids.length} memories
                </div>
              )}
          </div>
        ))}
      </div>
    </div>
  );
}
