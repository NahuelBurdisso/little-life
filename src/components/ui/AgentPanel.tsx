import { useState, useEffect } from "react";
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
import type { PersonalityProfile } from "../../../server/lib/personality";

type TabId = "profile" | "social" | "mind";

const FACT_COLORS: Record<string, string> = {
  crush: 'text-pink-400', heartbreak: 'text-rose-400', affair: 'text-red-400',
  theft: 'text-orange-400', blackmail: 'text-red-500', grudge: 'text-red-600',
  sickness: 'text-yellow-300', financial: 'text-yellow-400', alcoholic: 'text-amber-400',
  work_issue: 'text-orange-300', drunk_incident: 'text-amber-300', rumor: 'text-purple-400',
  confession: 'text-blue-400', seduction: 'text-pink-300', reputation: 'text-red-300',
  secret_told: 'text-indigo-400', gambling_loss: 'text-yellow-500',
};

function KnownFacts({ agentId }: { agentId: number }) {
  const { data: knownFacts } = trpc.facts.getKnownBy.useQuery({ agentId });
  const { agents: allAgents } = useAgents();

  if (!knownFacts || knownFacts.length === 0) {
    return (
      <div className="px-3 py-2 border-b border-gray-700">
        <div className="text-xs text-gray-500 font-medium mb-1">Known Facts</div>
        <p className="text-[11px] text-gray-600 italic">Doesn't know any gossip yet.</p>
      </div>
    );
  }

  // Sort: secrets first, then by sensitivity desc
  const sorted = [...knownFacts].sort((a: any, b: any) => {
    const aSecret = a.sensitivity >= 3 ? 2 : a.sensitivity >= 2 ? 1 : 0;
    const bSecret = b.sensitivity >= 3 ? 2 : b.sensitivity >= 2 ? 1 : 0;
    return bSecret - aSecret;
  });

  const totalAgents = allAgents.length;

  return (
    <div className="px-3 py-2 border-b border-gray-700">
      <div className="text-xs text-gray-500 font-medium mb-1.5">
        Known Facts ({knownFacts.length})
      </div>
      <div className="space-y-1.5">
        {sorted.slice(0, 15).map((fact: any) => {
          const knownCount = (fact.known_by as number[]).length;
          const secrecyLabel = fact.sensitivity >= 3
            ? '🔒' : fact.sensitivity >= 2
            ? '🔑' : '';
          const secrecyBg = fact.sensitivity >= 3
            ? 'bg-red-900/20 border border-red-900/30' : fact.sensitivity >= 2
            ? 'bg-yellow-900/10 border border-yellow-900/20' : '';

          return (
            <div key={fact.id} className={`text-[11px] rounded px-1.5 py-1 ${secrecyBg}`}>
              <div className="flex items-start gap-1">
                {secrecyLabel && <span className="shrink-0">{secrecyLabel}</span>}
                <span className={`capitalize font-medium shrink-0 ${FACT_COLORS[fact.type] ?? 'text-gray-400'}`}>
                  {fact.type.replace(/_/g, ' ')}
                </span>
                <span className="text-gray-400 flex-1">{fact.content}</span>
              </div>
              <div className="text-[9px] text-gray-600 mt-0.5 flex gap-2">
                <span>Known by {knownCount}/{totalAgents}</span>
                {fact.sensitivity >= 2 && knownCount <= 3 && (
                  <span className="text-red-400">← Secret</span>
                )}
                {fact.sensitivity >= 2 && knownCount > 3 && knownCount < totalAgents / 2 && (
                  <span className="text-yellow-400">← Spreading</span>
                )}
                {knownCount >= totalAgents / 2 && (
                  <span className="text-gray-500">← Common knowledge</span>
                )}
              </div>
            </div>
          );
        })}
        {sorted.length > 15 && (
          <div className="text-[10px] text-gray-600 italic">
            ...and {sorted.length - 15} more
          </div>
        )}
      </div>
    </div>
  );
}

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

const PERSONALITY_AXES: (keyof PersonalityProfile)[] = [
  "honesty",
  "aggression",
  "warmth",
  "impulsiveness",
  "vanity",
  "curiosity",
  "loyalty",
  "morality",
  "sensuality",
  "neuroticism",
];

function PersonalityAxes({ personality }: { personality: PersonalityProfile | null | undefined }) {
  if (!personality) {
    return <p className="text-xs text-gray-600 italic">No personality data.</p>;
  }
  return (
    <div className="space-y-1.5">
      {PERSONALITY_AXES.map((axis) => {
        const value = Math.round(personality[axis] ?? 0);
        return (
          <div key={axis} className="flex items-center gap-2 text-xs">
            <span className="w-24 text-gray-400 capitalize">{axis}</span>
            <div className="flex-1 bg-gray-700 h-2 rounded overflow-hidden">
              <div
                className="bg-blue-400 h-2 rounded transition-all duration-300"
                style={{ width: `${value}%` }}
              />
            </div>
            <span className="w-6 text-right text-gray-500">{value}</span>
          </div>
        );
      })}
    </div>
  );
}

function ActiveStates({ states }: { states: any[] }) {
  if (!states || states.length === 0) {
    return <p className="text-xs text-gray-600 italic">No active states.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {states.map((state: any) => (
        <div
          key={state.id}
          className="flex items-center gap-1.5 text-xs bg-gray-700 rounded px-2 py-1"
        >
          <span className="font-medium text-gray-200 capitalize">
            {state.type.replace(/_/g, " ")}
          </span>
          <span className="text-gray-500">
            {(state.severity * 100).toFixed(0)}%
          </span>
        </div>
      ))}
    </div>
  );
}

export function AgentPanel({ agentId, onClose }: AgentPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("profile");

  // Reset tab when agent changes
  useEffect(() => {
    setActiveTab("profile");
  }, [agentId]);

  const { data, relationships, memories, isLoading } = useSelectedAgent(agentId);
  const { world } = useWorldState();
  const { agents: allAgents } = useAgents();
  const { conversations: activeConversations } = useConversations();

  const { data: conversationHistory } = trpc.conversations.getHistory.useQuery(
    { agentId: Number(agentId), limit: 5 }
  );
  const { data: agentStates } = trpc.agents.getStates.useQuery(
    { agentId: Number(agentId) }
  );

  if (isLoading || !data?.agent) {
    return (
      <div className="h-full bg-gray-800 border-l border-gray-700 flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  const { agent, needs, economy } = data;

  // Deceased agent view
  if (!agent.is_active) {
    return (
      <div className="h-full bg-gray-800 border-l border-gray-700 flex flex-col overflow-hidden">
        <div className="p-3 border-b border-gray-700 flex justify-between items-start flex-shrink-0">
          <div>
            <div className="text-sm font-bold text-gray-500 line-through">{agent.name}</div>
            <div className="text-xs text-red-400 font-medium">☠ Deceased</div>
            {economy && <div className="text-[10px] text-gray-600 mt-0.5">{economy.job_title}</div>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">✕</button>
        </div>
        <div className="px-3 py-3 text-xs text-gray-500 italic border-b border-gray-700">
          {agent.name} has passed away. Their memory lives on in the town.
        </div>
        {agent.bio && (
          <div className="px-3 py-2 border-b border-gray-700">
            <div className="text-xs text-gray-600 font-medium mb-1">Bio</div>
            <p className="text-[11px] text-gray-500 leading-relaxed">{agent.bio}</p>
          </div>
        )}
      </div>
    );
  }
  const worldTick = world?.time?.totalTicks ?? 0;
  const tickSpeed = world?.tick_speed ?? 1;

  const agentNameMap = new Map(allAgents.map((a: any) => [String(a.id), a.name]));
  const activeConvo = activeConversations.find((c: any) =>
    c.participants?.includes(Number(agentId))
  );
  const recentConvos = (conversationHistory ?? []).slice(0, 3);

  const tabs: { id: TabId; label: string }[] = [
    { id: "profile", label: "👤 Profile" },
    { id: "social", label: "💬 Social" },
    { id: "mind", label: "🧠 Mind" },
  ];

  return (
    <div className="h-full bg-gray-800 border-l border-gray-700 flex flex-col overflow-hidden">
      {/* Header: portrait + close button */}
      <div className="p-3 border-b border-gray-700 flex justify-between items-start flex-shrink-0">
        <AgentPortrait
          agent={agent}
          economy={economy}
          mood={needs?.mood}
        />
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white text-lg leading-none ml-2 flex-shrink-0"
        >
          ✕
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-700 flex-shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-2 text-[11px] font-medium transition-colors ${
              activeTab === tab.id
                ? "text-white border-b-2 border-blue-400"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content — independently scrollable */}
      <div className="flex-1 overflow-y-auto">

        {/* ── Profile Tab ── */}
        {activeTab === "profile" && (
          <div>
            {/* Needs bars */}
            {needs && <NeedsBars needs={needs} />}

            {/* Economy info */}
            {economy && (
              <div className="px-3 py-2 border-b border-gray-700 text-sm">
                <span className="text-yellow-400">{formatMoney(economy.money)}</span>
                <span className="text-gray-400 ml-2">
                  • {economy.job_title}
                </span>
              </div>
            )}

            {/* Current action */}
            <div className="px-3 py-2 border-b border-gray-700 text-sm text-gray-300">
              <span className="text-gray-500">Currently: </span>
              {describeAction(agent.current_action)}
            </div>

            {/* Active states */}
            <div className="px-3 py-2 border-b border-gray-700">
              <div className="text-xs text-gray-500 font-medium mb-1.5">
                Active States
              </div>
              <ActiveStates states={agentStates ?? []} />
            </div>

            {/* Traits */}
            {agent.traits && agent.traits.length > 0 && (
              <div className="px-3 py-2 border-b border-gray-700">
                <div className="text-xs text-gray-500 font-medium mb-1.5">Traits</div>
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

            {/* Personality axes */}
            <div className="px-3 py-2 border-b border-gray-700">
              <div className="text-xs text-gray-500 font-medium mb-2">
                Personality
              </div>
              <PersonalityAxes personality={agent.personality} />
            </div>
          </div>
        )}

        {/* ── Social Tab ── */}
        {activeTab === "social" && (
          <div>
            <RelationshipList
              relationships={relationships ?? []}
              selectedAgentId={agentId}
            />

            {/* Active conversation */}
            {activeConvo && (
              <div className="border-b border-gray-700">
                <div className="px-3 pt-2 text-xs text-gray-500 font-medium">
                  Active Conversation
                </div>
                <ConversationViewer
                  conversation={activeConvo}
                  agentNames={agentNameMap}
                />
              </div>
            )}

            {/* Recent conversation history */}
            {recentConvos.length > 0 && (
              <div className="px-3 py-2 border-b border-gray-700">
                <div className="text-xs text-gray-500 font-medium mb-1.5">
                  Recent Conversations ({recentConvos.length})
                </div>
                <div className="space-y-2">
                  {recentConvos.map((convo: any) => (
                    <ConversationViewer
                      key={convo.id}
                      conversation={convo}
                      agentNames={agentNameMap}
                    />
                  ))}
                </div>
              </div>
            )}

            {!activeConvo && recentConvos.length === 0 && (
              <div className="px-3 py-4 text-xs text-gray-600 italic">
                No conversations yet.
              </div>
            )}
          </div>
        )}

        {/* ── Mind Tab ── */}
        {activeTab === "mind" && (
          <div>
            {/* Bio */}
            {agent.bio && (
              <div className="px-3 py-2 border-b border-gray-700">
                <div className="text-xs text-gray-500 font-medium mb-1">Bio</div>
                <p className="text-[11px] text-gray-300 leading-relaxed">{agent.bio}</p>
              </div>
            )}

            {/* Schedule */}
            {agent.schedule && (
              <div className="px-3 py-2 border-b border-gray-700">
                <div className="text-xs text-gray-500 font-medium mb-1.5">Daily Schedule</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                  <span className="text-gray-400">Wake</span>
                  <span className="text-gray-300">{(agent.schedule as any).wakeTime}:00</span>
                  <span className="text-gray-400">Work</span>
                  <span className="text-gray-300">
                    {agent.workplace ? `${(agent.schedule as any).workStart}:00 - ${(agent.schedule as any).workEnd}:00` : 'No job'}
                  </span>
                  <span className="text-gray-400">Lunch</span>
                  <span className="text-gray-300">{(agent.schedule as any).lunchTime}:00</span>
                  <span className="text-gray-400">Sleep</span>
                  <span className="text-gray-300">{(agent.schedule as any).sleepTime}:00</span>
                </div>
              </div>
            )}

            {/* Known facts / gossip */}
            <KnownFacts agentId={Number(agentId)} />

            {/* Memories */}
            <MemoryLog
              memories={memories ?? []}
              worldTick={worldTick}
              tickSpeed={tickSpeed}
            />
          </div>
        )}
      </div>
    </div>
  );
}
