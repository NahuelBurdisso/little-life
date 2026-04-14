import { useState } from "react";
import { CurrentThought } from "./CurrentThought";
import { GoalsView } from "./GoalsView";
import { SecretsOpinions } from "./SecretsOpinions";
import { MemoryLog } from "./MemoryLog";

interface ThoughtsTabProps {
  agent: {
    id: number | string;
    name: string;
    current_action: Record<string, any>;
    traits: string[];
  };
  needs: {
    hunger: number;
    energy: number;
    social: number;
    comfort: number;
    fun: number;
    mood: number;
    stress: number;
  } | null;
  activeStates: {
    id: number;
    type: string;
    severity: number;
    source: string;
    metadata: Record<string, any> | null;
  }[];
  memories: {
    id: number;
    description: string;
    type: string;
    importance: number;
    emotional_valence: number;
    created_at: number;
    metadata: Record<string, unknown>;
  }[];
  worldTick: number;
  tickSpeed: number;
}

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors px-3"
      >
        <span>{title}</span>
        <span className="text-[10px]">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

export function ThoughtsTab({
  agent,
  needs,
  activeStates,
  memories,
  worldTick,
  tickSpeed,
}: ThoughtsTabProps) {
  const agentId = Number(agent.id);
  const recentMemories = (memories ?? []).slice(0, 10);

  return (
    <div className="overflow-y-auto">
      {/* Layer 1: Inner Monologue — always visible */}
      <CurrentThought
        agent={agent}
        needs={needs}
        states={activeStates}
      />

      {/* Layer 2: Goals & Ambition */}
      <div className="border-t border-gray-700">
        <CollapsibleSection title="Goals & Ambition" defaultOpen={false}>
          <GoalsView agentId={agentId} worldTick={worldTick} />
        </CollapsibleSection>
      </div>

      {/* Layer 3: Secrets & Opinions */}
      <div className="border-t border-gray-700">
        <CollapsibleSection title="Secrets & Opinions" defaultOpen={false}>
          <SecretsOpinions agentId={agentId} agentName={agent.name} />
        </CollapsibleSection>
      </div>

      {/* Layer 4: Recent Memories */}
      <div className="border-t border-gray-700">
        <CollapsibleSection title="Recent Memories" defaultOpen={false}>
          <MemoryLog
            memories={recentMemories}
            worldTick={worldTick}
            tickSpeed={tickSpeed}
          />
        </CollapsibleSection>
      </div>
    </div>
  );
}
