import { trpc } from "../../lib/trpc";

interface GoalsViewProps {
  agentId: number;
  worldTick: number;
}

const AMBITION_COLORS: Record<string, string> = {
  wealth: "text-yellow-400",
  love: "text-pink-400",
  power: "text-red-400",
  knowledge: "text-blue-400",
  adventure: "text-green-400",
  family: "text-orange-300",
  friendship: "text-cyan-400",
  creativity: "text-purple-400",
  spirituality: "text-indigo-300",
  survival: "text-red-300",
  legacy: "text-amber-300",
};

const AMBITION_BG: Record<string, string> = {
  wealth: "bg-yellow-900/20 border-yellow-800/30",
  love: "bg-pink-900/20 border-pink-800/30",
  power: "bg-red-900/20 border-red-800/30",
  knowledge: "bg-blue-900/20 border-blue-800/30",
  adventure: "bg-green-900/20 border-green-800/30",
  family: "bg-orange-900/20 border-orange-800/30",
  friendship: "bg-cyan-900/20 border-cyan-800/30",
  creativity: "bg-purple-900/20 border-purple-800/30",
  spirituality: "bg-indigo-900/20 border-indigo-800/30",
  survival: "bg-red-900/20 border-red-800/30",
  legacy: "bg-amber-900/20 border-amber-800/30",
};

const GOAL_TYPE_LABELS: Record<string, string> = {
  earn_money: "Earn money",
  befriend: "Make a friend",
  romance: "Find romance",
  improve_skill: "Self-improve",
  explore: "Explore",
  resolve_conflict: "Resolve conflict",
  gain_influence: "Gain influence",
  rest: "Rest & recover",
  help_other: "Help someone",
  enjoy_leisure: "Enjoy leisure",
};

const SOURCE_BADGE: Record<string, { label: string; className: string }> = {
  reactive: { label: "reactive", className: "bg-gray-700 text-gray-400" },
  llm: { label: "autonomous", className: "bg-blue-900/40 text-blue-300" },
  event: { label: "event", className: "bg-orange-900/40 text-orange-300" },
  relationship: { label: "social", className: "bg-pink-900/40 text-pink-300" },
};

function daysActive(createdAt: number, worldTick: number): number {
  // Each tick is roughly a game minute; 1440 ticks = 1 game day
  const ticksActive = worldTick - createdAt;
  return Math.max(0, Math.floor(ticksActive / 1440));
}

export function GoalsView({ agentId, worldTick }: GoalsViewProps) {
  const { data, isLoading } = trpc.agents.getAgentThoughts.useQuery({ agentId });

  if (isLoading) {
    return (
      <div className="px-3 py-2 border-b border-gray-700">
        <div className="text-xs text-gray-500 font-medium mb-1">Ambition & Goals</div>
        <p className="text-[11px] text-gray-600 italic">Loading...</p>
      </div>
    );
  }

  const { goals = [], ambition } = data ?? {};

  return (
    <div className="px-3 py-2 border-b border-gray-700">
      <div className="text-xs text-gray-500 font-medium mb-2">Ambition & Goals</div>

      {/* Life ambition */}
      {ambition ? (
        <div
          className={`rounded px-2 py-1.5 border mb-2.5 ${
            AMBITION_BG[ambition.type] ?? "bg-gray-700/40 border-gray-600/40"
          }`}
        >
          <div className="flex items-center justify-between mb-0.5">
            <span
              className={`text-xs font-semibold capitalize ${
                AMBITION_COLORS[ambition.type] ?? "text-gray-300"
              }`}
            >
              {ambition.type} ambition
            </span>
            <span className="text-[10px] text-gray-500">
              intensity {Math.round(ambition.intensity * 100)}%
            </span>
          </div>
          {ambition.description ? (
            <p className="text-[11px] text-gray-300 leading-relaxed">
              {ambition.description}
            </p>
          ) : (
            <p className="text-[11px] text-gray-500 italic">
              Driven by a deep desire for {ambition.type}.
            </p>
          )}
          {ambition.trigger && (
            <div className="text-[10px] text-gray-600 mt-0.5">
              Triggered by: {ambition.trigger.replace(/_/g, " ")}
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-gray-600 italic mb-2">
          No life ambition yet.
        </div>
      )}

      {/* Active goals */}
      {goals.length === 0 ? (
        <p className="text-[11px] text-gray-600 italic">No active goals.</p>
      ) : (
        <div className="space-y-2">
          {goals.map((goal) => {
            const progress = Math.min(100, Math.max(0, goal.progress * 100));
            const days = daysActive(goal.created_at, worldTick);
            const sourceBadge = SOURCE_BADGE[goal.source] ?? SOURCE_BADGE.reactive;
            const typeLabel = GOAL_TYPE_LABELS[goal.type] ?? goal.type.replace(/_/g, " ");

            return (
              <div key={goal.id} className="bg-gray-700/30 rounded px-2 py-1.5">
                {/* Goal header */}
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-gray-200 font-medium capitalize">
                    {typeLabel}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {days > 0 && (
                      <span className="text-[9px] text-gray-600">
                        {days}d
                      </span>
                    )}
                    <span
                      className={`text-[9px] px-1 py-0.5 rounded capitalize ${sourceBadge.className}`}
                    >
                      {sourceBadge.label}
                    </span>
                  </div>
                </div>

                {/* Description */}
                {goal.description && (
                  <p className="text-[10px] text-gray-400 leading-relaxed mb-1">
                    {goal.description}
                  </p>
                )}

                {/* Progress bar */}
                <div className="flex items-center gap-1.5">
                  <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-blue-500/70 transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-500 w-7 text-right">
                    {Math.round(progress)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
