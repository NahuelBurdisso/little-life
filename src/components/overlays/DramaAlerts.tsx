import { useEffect, useRef } from "react";
import { useDramaAlerts } from "../../hooks/useDramaAlerts";
import { renderMessage } from "../../lib/activityMessage";

interface DramaAlertsProps {
  /** When true, each new alert also re-centers the camera on its subject. */
  autoFollow: boolean;
  onFocusAgent: (agentId: string) => void;
}

export function DramaAlerts({ autoFollow, onFocusAgent }: DramaAlertsProps) {
  const { alerts, dismiss } = useDramaAlerts();

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
        return (
          <button
            key={alert.id}
            type="button"
            onClick={() => {
              if (subjectId != null) onFocusAgent(String(subjectId));
              dismiss(alert.id);
            }}
            className="pointer-events-auto max-w-md text-left text-xs font-semibold px-3 py-1.5 bg-[#1a1814] border-l-4 border border-[#3a3028] shadow-lg text-[#e0d8c0] hover:bg-[#2e2b20] transition-colors"
            style={{ borderLeftColor: "#a03028" }}
            title={subjectId != null ? "Focus on this agent" : "Dismiss"}
          >
            <span className="text-[#a03028] mr-1.5">!</span>
            {message}
          </button>
        );
      })}
    </div>
  );
}
