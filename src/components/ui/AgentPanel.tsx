import { useState, useEffect } from "react";
import { useSelectedAgent } from "../../hooks/useSelectedAgent";
import { useConversations } from "../../hooks/useConversations";
import { useAgents } from "../../hooks/useAgents";
import { useWorldState } from "../../hooks/useWorldState";
import { formatMoney } from "../../lib/formatters";
import { AgentPortrait } from "./AgentPortrait";
import { NeedsBars } from "./NeedsBars";
import { ConversationViewer } from "./ConversationViewer";
import { RelationshipList } from "./RelationshipList";
import { PlanTimeline } from "./PlanTimeline";
import { ThoughtsTab } from "./ThoughtsTab";
import type { PersonalityProfile } from "../../../server/lib/personality";

type TabId = "profile" | "social" | "mind" | "thoughts";

interface AgentPanelProps {
  agentId: string;
  onClose: () => void;
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

export function AgentPanel({ agentId, onClose }: AgentPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("profile");

  // Reset tab when agent changes
  useEffect(() => {
    setActiveTab("profile");
  }, [agentId]);

  const {
    data,
    relationships,
    memories,
    states: agentStates,
    conversationHistory,
    status,
  } = useSelectedAgent(agentId);
  const { world } = useWorldState();
  const { agents: allAgents } = useAgents();
  const { conversations: activeConversations } = useConversations();

  // Nothing left to show for this id (removed agent, or an id from a world
  // that has since been replaced): deselect, the same as pressing ✕. Keeping
  // the panel open on a "not found" card would just be a dead end the user has
  // to dismiss by hand.
  useEffect(() => {
    if (status === "notFound") onClose();
  }, [status, onClose]);

  if (status === "error") {
    return (
      <div className="h-full bg-gray-800 border-l border-gray-700 flex flex-col items-center justify-center gap-2 p-3">
        <p className="text-sm text-gray-400">Couldn't load this resident.</p>
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-white underline">
          Close
        </button>
      </div>
    );
  }

  if (status !== "ready" || !data?.agent) {
    return (
      <div className="h-full bg-gray-800 border-l border-gray-700 flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  const { agent, needs, economy, reputation, hobbies } = data as any;

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
  const isPaused = world?.is_paused ?? false;

  const agentNameMap = new Map(allAgents.map((a: any) => [String(a.id), a.name]));
  const activeConvo = activeConversations.find((c: any) =>
    c.participants?.includes(Number(agentId))
  );
  const recentConvos = (conversationHistory ?? []).slice(0, 3);

  const tabs: { id: TabId; label: string }[] = [
    { id: "profile", label: "👤 Profile" },
    { id: "social", label: "💬 Social" },
    { id: "mind", label: "🧠 Mind" },
    { id: "thoughts", label: "💭 Thoughts" },
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

            {/* Reputation */}
            {reputation && (
              <div className="px-3 py-2 border-b border-gray-700">
                <div className="text-xs text-gray-500 font-medium mb-1">Reputation</div>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-medium ${
                    reputation.score >= 30 ? 'text-green-400' :
                    reputation.score <= -30 ? 'text-red-400' : 'text-gray-300'
                  }`}>
                    {reputation.label}
                  </span>
                  <span className="text-[10px] text-gray-500">({reputation.score > 0 ? '+' : ''}{reputation.score})</span>
                </div>
              </div>
            )}

            {/* Hobbies */}
            {hobbies && hobbies.length > 0 && (
              <div className="px-3 py-2 border-b border-gray-700">
                <div className="text-xs text-gray-500 font-medium mb-1.5">Hobbies</div>
                <div className="flex flex-wrap gap-1">
                  {hobbies.map((h: any) => (
                    <span
                      key={h.hobby}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/50 text-indigo-300"
                    >
                      {h.hobby} lv{h.level}
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
            {/* Self-Concept (evolving, generated from memories) */}
            {(agent as any).self_description && (
              <div className="px-3 py-2 border-b border-gray-700">
                <div className="text-xs text-gray-500 font-medium mb-1">Self-Concept</div>
                <p className="text-[11px] text-blue-300 leading-relaxed italic">{(agent as any).self_description}</p>
              </div>
            )}

            {/* Bio (static backstory) */}
            {agent.bio && (
              <div className="px-3 py-2 border-b border-gray-700">
                <div className="text-xs text-gray-500 font-medium mb-1">Backstory</div>
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

            {/* Daily plan */}
            <PlanTimeline dailyPlan={(agent as any).daily_plan} />

          </div>
        )}

        {/* ── Thoughts Tab ── */}
        {activeTab === "thoughts" && (
          <ThoughtsTab
            agent={agent}
            needs={needs ?? null}
            activeStates={agentStates ?? []}
            memories={memories ?? []}
            worldTick={worldTick}
            tickSpeed={tickSpeed}
            isPaused={isPaused}
          />
        )}
      </div>
    </div>
  );
}
