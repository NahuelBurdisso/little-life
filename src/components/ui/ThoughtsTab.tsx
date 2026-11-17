import { useState, type ReactNode } from "react";
import { CurrentThought } from "./CurrentThought";
import type { ThoughtContext } from "../../lib/thoughtLine";
import { GoalsView } from "./GoalsView";
import { SecretsOpinions } from "./SecretsOpinions";
import { MemoryLog } from "./MemoryLog";
import type { AgentAction } from '../../../server/db/schema';

interface ThoughtsTabProps {
  agent: {
    id: number | string;
    name: string;
    current_action: AgentAction;
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
    target_agent_id?: number | null;
    metadata: Record<string, unknown> | null;
  }[];
  /** Names and the current conversation, for the inner-monologue line. */
  thoughtContext: ThoughtContext;
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
  isPaused: boolean;
  /** World clock in game minutes, for game-minute stamps (goals). */
  nowMinutes: number;
}

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-1.5 text-xs font-medium text-ui-dim hover:text-ui-text transition-colors px-3"
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
  thoughtContext,
  memories,
  worldTick,
  tickSpeed,
  isPaused,
  nowMinutes,
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
        thoughtContext={thoughtContext}
      />

      {/* Layer 2: Goals & Ambition */}
      <div className="border-t border-ui-line">
        <CollapsibleSection title="Goals & Ambition" defaultOpen={false}>
          <GoalsView agentId={agentId} nowMinutes={nowMinutes} />
        </CollapsibleSection>
      </div>

      {/* Layer 3: Secrets & Opinions */}
      <div className="border-t border-ui-line">
        <CollapsibleSection title="Secrets & Opinions" defaultOpen={false}>
          <SecretsOpinions agentId={agentId} agentName={agent.name} />
        </CollapsibleSection>
      </div>

      {/* Layer 4: Recent Memories */}
      <div className="border-t border-ui-line">
        <CollapsibleSection title="Recent Memories" defaultOpen={false}>
          <MemoryLog
            memories={recentMemories}
            worldTick={worldTick}
            tickSpeed={tickSpeed}
            isPaused={isPaused}
          />
        </CollapsibleSection>
      </div>
    </div>
  );
}
