import { useState, useEffect } from "react";
import { useSelectedAgent } from "../../hooks/useSelectedAgent";
import { useConversations } from "../../hooks/useConversations";
import { useAgents } from "../../hooks/useAgents";
import { useWorldState } from "../../hooks/useWorldState";
import { formatMoney } from "../../lib/formatters";
import { AgentPortrait } from "./AgentPortrait";
import { NeedsBars } from "./NeedsBars";
import { ConversationViewer } from "./ConversationViewer";
import { EmptyState } from "./EmptyState";
import { MemorialCard } from "./MemorialCard";
import { Skeleton, SkeletonSection } from "./Skeleton";
import { RelationshipList } from "./RelationshipList";
import { PlanTimeline } from "./PlanTimeline";
import { ThoughtsTab } from "./ThoughtsTab";
import { StoryTab } from "./StoryTab";
import type { PersonalityProfile } from "../../../server/lib/personality";
import { gameMinutes } from "../../../server/lib/gameClock";

type TabId = "profile" | "social" | "mind" | "thoughts" | "story";

interface AgentPanelProps {
  agentId: string;
  onClose: () => void;
  /** Select + focus another resident (relationship rows, conversation speakers). */
  onSelectAgent?: (agentId: string) => void;
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
    return <EmptyState compact icon="🧩" title="No personality profile." />;
  }
  return (
    <div className="space-y-1.5">
      {PERSONALITY_AXES.map((axis) => {
        const value = Math.round(personality[axis] ?? 0);
        return (
          <div key={axis} className="flex items-center gap-2 text-xs">
            <span className="w-24 text-ui-dim capitalize">{axis}</span>
            <div className="flex-1 bg-ui-raised h-2 rounded overflow-hidden">
              <div
                className="bg-ui-blue h-2 rounded transition-all duration-300"
                style={{ width: `${value}%` }}
              />
            </div>
            <span className="w-6 text-right text-ui-muted">{value}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AgentPanel({ agentId, onClose, onSelectAgent }: AgentPanelProps) {
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
      <div className="h-full bg-ui-panel border-l border-ui-line flex flex-col items-center justify-center gap-2 p-3">
        <p className="text-sm text-ui-dim">Couldn't load this resident.</p>
        <button onClick={onClose} className="text-xs text-ui-dim hover:text-ui-text underline">
          Close
        </button>
      </div>
    );
  }

  if (status !== "ready" || !data?.agent) {
    return (
      <div className="h-full bg-ui-panel border-l border-ui-line flex flex-col overflow-hidden" role="status" aria-label="Loading resident">
        <div className="p-3 border-b border-ui-line flex items-center gap-3">
          <Skeleton className="w-12 h-12" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <div className="flex border-b border-ui-line">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex-1 py-2.5 flex justify-center">
              <Skeleton className="h-2.5 w-10" />
            </div>
          ))}
        </div>
        <SkeletonSection rows={5} />
        <SkeletonSection rows={3} />
        <SkeletonSection rows={4} />
      </div>
    );
  }

  const { agent, needs, economy, reputation, hobbies } = data as any;

  // Deceased agent view
  if (!agent.is_active) {
    return <MemorialCard agent={agent} economy={economy} memories={memories ?? []} world={world} onClose={onClose} />;
  }
  const worldTick = world?.time?.totalTicks ?? 0;
  const tickSpeed = world?.tick_speed ?? 1;
  const isPaused = world?.is_paused ?? false;
  const nowMinutes = world?.time ? gameMinutes(world.time) : 0;

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
    { id: "story", label: "📖 Story" },
  ];

  return (
    <div className="h-full bg-ui-panel border-l border-ui-line flex flex-col overflow-hidden">
      {/* Header: portrait + close button */}
      <div className="p-3 border-b border-ui-line flex justify-between items-start flex-shrink-0">
        <AgentPortrait
          agent={agent}
          economy={economy}
          mood={needs?.mood}
          states={agentStates}
        />
        <button
          onClick={onClose}
          className="text-ui-dim hover:text-ui-text text-lg leading-none ml-2 flex-shrink-0"
        >
          ✕
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-ui-line flex-shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            // No side padding and tighter tracking: with five tabs the 300px default
            // panel gave each 60px, and "💭 Thoughts" was clipped by 7px.
            className={`flex-1 min-w-0 px-0 py-2 text-[10px] tracking-tighter whitespace-nowrap font-medium transition-colors ${
              activeTab === tab.id
                ? "text-ui-gold border-b-2 border-ui-gold bg-ui-raised/40"
                : "text-ui-dim hover:text-ui-text"
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
              <div className="px-3 py-2 border-b border-ui-line text-sm">
                <span className="text-ui-gold">{formatMoney(economy.money)}</span>
                <span className="text-ui-dim ml-2">
                  • {economy.job_title}
                </span>
              </div>
            )}

            {/* Traits */}
            {agent.traits && agent.traits.length > 0 && (
              <div className="px-3 py-2 border-b border-ui-line">
                <div className="text-xs text-ui-dim font-medium mb-1.5">Traits</div>
                <div className="flex flex-wrap gap-1">
                  {agent.traits.map((trait: string) => (
                    <span
                      key={trait}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-ui-raised text-ui-text"
                    >
                      {trait}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Reputation */}
            {reputation && (
              <div className="px-3 py-2 border-b border-ui-line">
                <div className="text-xs text-ui-dim font-medium mb-1">Reputation</div>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-medium ${
                    reputation.score >= 30 ? 'text-green-400' :
                    reputation.score <= -30 ? 'text-red-400' : 'text-ui-text'
                  }`}>
                    {reputation.label}
                  </span>
                  <span className="text-[10px] text-ui-muted">({reputation.score > 0 ? '+' : ''}{reputation.score})</span>
                </div>
              </div>
            )}

            {/* Hobbies */}
            {hobbies && hobbies.length > 0 && (
              <div className="px-3 py-2 border-b border-ui-line">
                <div className="text-xs text-ui-dim font-medium mb-1.5">Hobbies</div>
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
            <div className="px-3 py-2 border-b border-ui-line">
              <div className="text-xs text-ui-dim font-medium mb-2">
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
              onSelectAgent={onSelectAgent}
            />

            {/* Active conversation */}
            {activeConvo && (
              <div className="border-b border-ui-line">
                <div className="px-3 pt-2 text-xs text-ui-dim font-medium">
                  Active Conversation
                </div>
                <ConversationViewer
                  conversation={activeConvo}
                  agentNames={agentNameMap}
                  onSelectAgent={onSelectAgent}
                />
              </div>
            )}

            {/* Recent conversation history */}
            {recentConvos.length > 0 && (
              <div className="px-3 py-2 border-b border-ui-line">
                <div className="text-xs text-ui-dim font-medium mb-1.5">
                  Recent Conversations ({recentConvos.length})
                </div>
                <div className="space-y-2">
                  {recentConvos.map((convo: any) => (
                    <ConversationViewer
                      key={convo.id}
                      conversation={convo}
                      agentNames={agentNameMap}
                      onSelectAgent={onSelectAgent}
                    />
                  ))}
                </div>
              </div>
            )}

            {!activeConvo && recentConvos.length === 0 && (
              <EmptyState
                icon="💬"
                title="No conversations yet."
                hint="Chats with neighbours will show up here, with who said what."
              />
            )}
          </div>
        )}

        {/* ── Mind Tab ── */}
        {activeTab === "mind" && (
          <div>
            {/* Self-Concept (evolving, generated from memories) */}
            {(agent as any).self_description && (
              <div className="px-3 py-2 border-b border-ui-line">
                <div className="text-xs text-ui-dim font-medium mb-1">Self-Concept</div>
                <p className="text-[11px] text-ui-blue leading-relaxed italic">{(agent as any).self_description}</p>
              </div>
            )}

            {/* Bio (static backstory) */}
            {agent.bio && (
              <div className="px-3 py-2 border-b border-ui-line">
                <div className="text-xs text-ui-dim font-medium mb-1">Backstory</div>
                <p className="text-[11px] text-ui-text leading-relaxed">{agent.bio}</p>
              </div>
            )}

            {/* Schedule */}
            {agent.schedule && (
              <div className="px-3 py-2 border-b border-ui-line">
                <div className="text-xs text-ui-dim font-medium mb-1.5">Daily Schedule</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                  <span className="text-ui-dim">Wake</span>
                  <span className="text-ui-text">{(agent.schedule as any).wakeTime}:00</span>
                  <span className="text-ui-dim">Work</span>
                  <span className="text-ui-text">
                    {agent.workplace ? `${(agent.schedule as any).workStart}:00 - ${(agent.schedule as any).workEnd}:00` : 'No job'}
                  </span>
                  <span className="text-ui-dim">Lunch</span>
                  <span className="text-ui-text">{(agent.schedule as any).lunchTime}:00</span>
                  <span className="text-ui-dim">Sleep</span>
                  <span className="text-ui-text">{(agent.schedule as any).sleepTime}:00</span>
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
            nowMinutes={nowMinutes}
          />
        )}

        {/* ── Story Tab ── */}
        {activeTab === "story" && (
          <StoryTab agentId={Number(agentId)} agentName={agent.name} onSelectAgent={onSelectAgent} />
        )}
      </div>
    </div>
  );
}
