import type { DramaAlert } from "../../hooks/useDramaAlerts";
import { TIER_STYLE } from "../../lib/alertTierStyle";
import { renderMessage } from "../../lib/activityMessage";

interface DramaAlertsProps {
  alerts: readonly DramaAlert[];
  dismiss: (id: number) => void;
  onFocusAgent: (agentId: string) => void;
}

/**
 * Alert toasts. Cutting the camera to a new alert is no longer done here: the
 * Director (hooks/useDirector.ts) weighs alerts against every other scene
 * instead of jumping to whichever arrived last.
 */
export function DramaAlerts({ alerts, dismiss, onFocusAgent }: DramaAlertsProps) {
  if (alerts.length === 0) return null;

  return (
    <div className="fixed top-[104px] left-1/2 -translate-x-1/2 z-40 flex flex-col gap-1 pointer-events-none">
      {alerts.map(alert => {
        const message = renderMessage(alert);
        const subjectId = alert.agent_ids?.[0];
        const style = TIER_STYLE[alert.tier];
        return (
          <button
            key={alert.id}
            type="button"
            onClick={() => {
              if (subjectId != null) onFocusAgent(String(subjectId));
              dismiss(alert.id);
            }}
            className={`pointer-events-auto max-w-md text-left text-xs px-3 py-1.5 border-l-4 border border-ui-line shadow-lg text-ui-text hover:bg-ui-hover transition-colors ${style.bar} ${style.bg} ${
              alert.tier === "minor" ? "font-normal" : "font-semibold"
            }`}
            title={subjectId != null ? "Focus on this resident" : "Dismiss"}
          >
            <span className={`${style.mark} mr-1.5`}>{style.icon}</span>
            {message}
          </button>
        );
      })}
    </div>
  );
}
