import { EmptyState } from "./EmptyState";

interface PlanBlock {
  id: string | number;
  start_hour: number;
  end_hour: number;
  broad_action: string;
  location_hint?: string;
  status: "completed" | "active" | "pending" | "interrupted" | "replanned" | "skipped";
  decomposed_actions?: Array<{ action: string; duration_min: number }>;
}

interface DailyPlan {
  day: number;
  blocks: PlanBlock[];
  /** 'fallback' = schedule-derived plan cached while the LLM was failing. */
  source?: "llm" | "fallback";
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
  skipped: "–",
};

function formatHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

export function PlanTimeline({ dailyPlan }: PlanTimelineProps) {
  if (!dailyPlan || !dailyPlan.blocks || dailyPlan.blocks.length === 0) {
    return (
      <div className="px-3 py-2 border-b border-ui-line">
        <div className="text-xs text-ui-dim font-medium mb-1">Today's Plan</div>
        <EmptyState
          compact
          icon="🗓"
          title="No plan for today yet."
          hint="Each morning they sketch out the day — the blocks show up here and tick off as they go."
        />
      </div>
    );
  }

  // A fallback plan is the agent's routine, written down because the LLM
  // planner failed. The server never executes it (the utility AI runs the
  // agent), so its blocks stay 'pending' all day; drawing them with the usual
  // status icons would read as a plan that is stuck. Show it as a muted,
  // clearly labelled routine instead.
  const isFallback = dailyPlan.source === "fallback";

  return (
    <div className="px-3 py-2 border-b border-ui-line">
      <div className="text-xs text-ui-dim font-medium mb-1 flex items-center gap-1.5">
        <span>Today's Plan (Day {dailyPlan.day})</span>
        {isFallback && (
          <span
            className="text-[9px] px-1 py-0.5 rounded bg-amber-900/30 text-amber-400/80 font-normal"
            title="The planner couldn't produce a plan for today (no answer from the LLM, or an answer it couldn't read), so this is the agent's usual routine. It is replaced by a real plan once the planner succeeds."
          >
            routine · planner unavailable
          </span>
        )}
      </div>
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {dailyPlan.blocks.map((block) => {
          if (isFallback) {
            return (
              <div
                key={block.id}
                className="text-[11px] flex items-baseline gap-1.5 py-0.5 px-1 text-ui-muted italic"
              >
                <span className="text-ui-muted shrink-0 not-italic">·</span>
                <span className="text-ui-muted shrink-0 not-italic">
                  {formatHour(block.start_hour)}–{formatHour(block.end_hour)}
                </span>
                <span className="flex-1 min-w-0">{block.broad_action}</span>
                {block.location_hint && (
                  <span className="text-ui-muted shrink-0 text-[10px] not-italic">
                    {block.location_hint}
                  </span>
                )}
              </div>
            );
          }

          const icon = STATUS_ICON[block.status] ?? "○";
          const isActive = block.status === "active";
          const isInterrupted = block.status === "interrupted";
          const isReplanned = block.status === "replanned";
          const isCompleted = block.status === "completed" || block.status === "skipped";

          const rowClass = [
            "text-[11px] flex items-baseline gap-1.5 py-0.5 rounded px-1",
            isActive ? "border border-ui-line-accent bg-ui-gold/10" : "",
          ]
            .filter(Boolean)
            .join(" ");

          const iconClass = isActive
            ? "text-ui-gold shrink-0"
            : isInterrupted
            ? "text-ui-bad shrink-0"
            : isReplanned
            ? "text-ui-warn shrink-0"
            : isCompleted
            ? "text-ui-muted shrink-0"
            : "text-ui-muted shrink-0";

          const timeClass = isCompleted
            ? "text-ui-muted shrink-0"
            : "text-ui-muted shrink-0";

          const actionClass = [
            "flex-1 min-w-0",
            isActive ? "text-ui-text font-semibold" : "",
            isInterrupted ? "text-ui-bad line-through" : "",
            isReplanned ? "text-ui-warn italic" : "",
            !isActive && !isInterrupted && !isReplanned
              ? isCompleted
                ? "text-ui-muted"
                : "text-ui-text"
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
                  <span className="text-ui-muted shrink-0 text-[10px]">
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
                        className="text-[10px] text-ui-dim flex gap-1"
                      >
                        <span className="text-ui-muted">•</span>
                        <span>
                          {da.action}{" "}
                          <span className="text-ui-muted">({da.duration_min}min)</span>
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
