import { useEffect, useRef } from "react";
import type { DramaAlert } from "../../hooks/useDramaAlerts";
import { TIER_STYLE } from "../../lib/alertTierStyle";
import { renderMessage } from "../../lib/activityMessage";

interface DramaAlertsProps {
  alerts: readonly DramaAlert[];
  dismiss: (id: number) => void;
  /** When true, each new alert also re-centers the camera on its subject. */
  autoFollow: boolean;
  onFocusAgent: (agentId: string) => void;
}

export function DramaAlerts({ alerts, dismiss, autoFollow, onFocusAgent }: DramaAlertsProps) {
  // Only ever cut to an alert once. Without this the camera would snap back to
  // the same agent on every unrelated re-render for as long as the toast lives.
  const lastCutIdRef = useRef(0);

  useEffect(() => {
    if (!autoFollow || alerts.length === 0) return;
    const newest = alerts[alerts.length - 1];
    if (newest.id <= lastCutIdRef.current) return;
    lastCutIdRef.current = newest.id;
    const subjectId = newest.agent_ids?.[0];
    if (subjectId != null) onFocusAgent(String(subjectId));
  }, [alerts, autoFollow, onFocusAgent]);

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
