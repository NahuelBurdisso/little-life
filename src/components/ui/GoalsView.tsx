import { trpc } from "../../lib/trpc";
import { EmptyState } from "./EmptyState";
import { SkeletonSection } from "./Skeleton";

interface GoalsViewProps {
  agentId: number;
  /** The world clock in game minutes (`gameMinutes(world.time)`). */
  nowMinutes: number;
}

const AMBITION_COLORS: Record<string, string> = {
  wealth: "text-yellow-400",
  love: "text-pink-400",
  power: "text-red-400",
  knowledge: "text-ui-blue",
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
  knowledge: "bg-ui-blue/20 border-blue-800/30",
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
  reactive: { label: "reactive", className: "bg-ui-raised text-ui-dim" },
  llm: { label: "autonomous", className: "bg-ui-blue/20 text-ui-blue" },
  event: { label: "event", className: "bg-orange-900/40 text-orange-300" },
  relationship: { label: "social", className: "bg-pink-900/40 text-pink-300" },
};

function daysActive(createdAt: number, nowMinutes: number): number {
  // `goals.created_at` is a game-minute stamp, so this is exact at any speed.
  // It used to be a tick stamp scaled by the current tick_speed, which misread
  // every goal older than the last speed change.
  return Math.max(0, Math.floor((nowMinutes - createdAt) / 1440));
}

export function GoalsView({ agentId, nowMinutes }: GoalsViewProps) {
  const { data, isLoading } = trpc.agents.getAgentThoughts.useQuery({ agentId });

  if (isLoading) {
    return <SkeletonSection rows={4} />;
  }

  const { goals = [], ambition } = data ?? {};

  return (
    <div className="px-3 py-2 border-b border-ui-line">
      <div className="text-xs text-ui-dim font-medium mb-2">Ambition & Goals</div>

      {/* Life ambition */}
      {ambition ? (
        <div
          className={`rounded px-2 py-1.5 border mb-2.5 ${
            AMBITION_BG[ambition.type] ?? "bg-ui-raised/40 border-ui-line/40"
          }`}
        >
          <div className="flex items-center justify-between mb-0.5">
            <span
              className={`text-xs font-semibold capitalize ${
                AMBITION_COLORS[ambition.type] ?? "text-ui-text"
              }`}
            >
              {ambition.type} ambition
            </span>
            <span className="text-[10px] text-ui-muted">
              intensity {Math.round(ambition.intensity * 100)}%
            </span>
          </div>
          {ambition.description ? (
            <p className="text-[11px] text-ui-text leading-relaxed">
              {ambition.description}
            </p>
          ) : (
            <p className="text-[11px] text-ui-muted italic">
              Driven by a deep desire for {ambition.type}.
            </p>
          )}
          {ambition.trigger && (
            <div className="text-[10px] text-ui-muted mt-0.5">
              Triggered by: {ambition.trigger.replace(/_/g, " ")}
            </div>
          )}
        </div>
      ) : (
        <EmptyState
          compact
          icon="🌟"
          title="No life ambition yet."
          hint="Big moments — love, loss, a windfall — can spark one."
          className="mb-1"
        />
      )}

      {/* Active goals */}
      {goals.length === 0 ? (
        <EmptyState
          compact
          icon="🎯"
          title="No active goals."
          hint="Short-term goals like making a friend or earning money will be tracked here."
        />
      ) : (
        <div className="space-y-2">
          {goals.map((goal) => {
            const progress = Math.min(100, Math.max(0, goal.progress * 100));
            const days = daysActive(goal.created_at, nowMinutes);
            const sourceBadge = SOURCE_BADGE[goal.source] ?? SOURCE_BADGE.reactive;
            const typeLabel = GOAL_TYPE_LABELS[goal.type] ?? goal.type.replace(/_/g, " ");

            return (
              <div key={goal.id} className="bg-ui-raised/30 rounded px-2 py-1.5">
                {/* Goal header */}
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-ui-text font-medium capitalize">
                    {typeLabel}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {days > 0 && (
                      <span className="text-[9px] text-ui-muted">
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
                  <p className="text-[10px] text-ui-dim leading-relaxed mb-1">
                    {goal.description}
                  </p>
                )}

                {/* Progress bar */}
                <div className="flex items-center gap-1.5">
                  <div className="flex-1 h-1.5 bg-ui-raised rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-ui-blue/70 transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-ui-muted w-7 text-right">
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
