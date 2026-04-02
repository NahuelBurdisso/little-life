interface PlanBlock {
  id: string | number;
  start_hour: number;
  end_hour: number;
  broad_action: string;
  location_hint?: string;
  status: "completed" | "active" | "pending" | "interrupted" | "replanned";
  decomposed_actions?: Array<{ action: string; duration_min: number }>;
}

interface DailyPlan {
  day: number;
  blocks: PlanBlock[];
}

interface PlanTimelineProps {
  dailyPlan: DailyPlan | null | undefined;
}

const STATUS_ICON: Record<PlanBlock["status"], string> = {
  completed: "✓",
  active: "►",
  pending: "○",
  interrupted: "✗",
  replanned: "↻",
};

function formatHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

export function PlanTimeline({ dailyPlan }: PlanTimelineProps) {
  if (!dailyPlan || !dailyPlan.blocks || dailyPlan.blocks.length === 0) {
    return (
      <div className="px-3 py-2 border-b border-gray-700">
        <div className="text-xs text-gray-500 font-medium mb-1">Today's Plan</div>
        <p className="text-[11px] text-gray-600 italic">
          No plan yet — agent hasn't woken up today.
        </p>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-gray-700">
      <div className="text-xs text-gray-500 font-medium mb-1">
        Today's Plan (Day {dailyPlan.day})
      </div>
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {dailyPlan.blocks.map((block) => {
          const icon = STATUS_ICON[block.status] ?? "○";
          const isActive = block.status === "active";
          const isInterrupted = block.status === "interrupted";
          const isReplanned = block.status === "replanned";
          const isCompleted = block.status === "completed";

          const rowClass = [
            "text-[11px] flex items-baseline gap-1.5 py-0.5 rounded px-1",
            isActive ? "border border-blue-500/50 bg-blue-900/10" : "",
          ]
            .filter(Boolean)
            .join(" ");

          const iconClass = isActive
            ? "text-blue-400 shrink-0"
            : isInterrupted
            ? "text-red-400 shrink-0"
            : isReplanned
            ? "text-amber-400 shrink-0"
            : isCompleted
            ? "text-gray-500 shrink-0"
            : "text-gray-500 shrink-0";

          const timeClass = isCompleted
            ? "text-gray-600 shrink-0"
            : "text-gray-500 shrink-0";

          const actionClass = [
            "flex-1 min-w-0",
            isActive ? "text-white font-semibold" : "",
            isInterrupted ? "text-red-400 line-through" : "",
            isReplanned ? "text-amber-300 italic" : "",
            !isActive && !isInterrupted && !isReplanned
              ? isCompleted
                ? "text-gray-600"
                : "text-gray-300"
              : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div key={block.id}>
              <div className={rowClass}>
                <span className={iconClass}>{icon}</span>
                <span className={timeClass}>
                  {formatHour(block.start_hour)}–{formatHour(block.end_hour)}
                </span>
                <span className={actionClass}>{block.broad_action}</span>
                {block.location_hint && (
                  <span className="text-gray-600 shrink-0 text-[10px]">
                    {block.location_hint}
                  </span>
                )}
              </div>

              {/* Decomposed actions shown only for active block */}
              {isActive &&
                block.decomposed_actions &&
                block.decomposed_actions.length > 0 && (
                  <div className="ml-6 mt-0.5 space-y-0.5">
                    {block.decomposed_actions.map((da, i) => (
                      <div
                        key={i}
                        className="text-[10px] text-gray-400 flex gap-1"
                      >
                        <span className="text-gray-600">•</span>
                        <span>
                          {da.action}{" "}
                          <span className="text-gray-600">({da.duration_min}min)</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
