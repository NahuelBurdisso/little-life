import { useEffect } from "react";
import type { InboxEntry } from "../../lib/alertInbox";
import { TIER_STYLE } from "../../lib/alertTierStyle";
import { renderMessage } from "../../lib/activityMessage";
import { timeAgo } from "../../lib/formatters";
import { EmptyState } from "./EmptyState";

interface InboxViewProps {
  entries: readonly InboxEntry[];
  onMarkAllRead: () => void;
  onClear: () => void;
  /** Resident names for the "who" chips; ids missing here (removed residents) are skipped. */
  agents: ReadonlyArray<{ id: number | string; name: string }>;
  /** Jump to a resident (the caller closes the Journal first). */
  onFocusAgent: (agentId: string) => void;
  /** World clock, for the same "12m ago" game-time ages the activity feed shows. */
  nowTicks: number;
  tickSpeed: number;
  isPaused: boolean;
}

/**
 * The Journal's Inbox tab: every alert of this session after its toast has
 * gone, newest first (state in useDramaAlerts, list rules in lib/alertInbox.ts).
 * A row focuses its first resident; each resident also gets a chip, since the
 * story is often about the other one ("Your rumor reached Rosa" — Ray is the teller).
 */
export function InboxView({
  entries, onMarkAllRead, onClear, agents, onFocusAgent, nowTicks, tickSpeed, isPaused,
}: InboxViewProps) {
  // Showing it is reading it. Marked when the tab mounts rather than when it is
  // left, so the badges clear the moment the list is in front of the player;
  // rows that arrive while it is open stay unread (bold) until next time.
  // `onMarkAllRead` is a stable callback (useDramaAlerts).
  useEffect(() => {
    onMarkAllRead();
  }, [onMarkAllRead]);

  const nameOf = new Map(agents.map((a) => [String(a.id), a.name.split(" ")[0]]));

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-ui-line shrink-0">
        <span className="text-[11px] text-ui-muted">last {entries.length} alerts</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClear}
          disabled={entries.length === 0}
          className="text-[11px] text-ui-dim hover:text-ui-text disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon="🔔"
          title="Nothing yet."
          hint="Big moments in town — and what your nudges came to — will collect here."
        />
      ) : (
        <ul className="flex-1 min-h-0 overflow-y-auto">
          {entries.map((entry) => {
            const style = TIER_STYLE[entry.tier];
            const who = (entry.agent_ids ?? []).map(String).filter((id) => nameOf.has(id));
            const first = who[0];
            return (
              <li key={entry.id} className={`border-l-4 border-b border-b-ui-line/60 ${style.bar} ${entry.tier === "player" ? style.bg : ""}`}>
                <button
                  type="button"
                  disabled={first == null}
                  onClick={() => {
                    if (first != null) onFocusAgent(first);
                  }}
                  className="w-full text-left px-3 pt-1.5 pb-1 hover:bg-ui-hover disabled:hover:bg-transparent disabled:cursor-default"
                  title={first != null ? "Focus on this resident" : undefined}
                >
                  <div className="flex items-baseline gap-1.5 text-xs">
                    <span className={`${style.mark} shrink-0`} title={style.label}>{style.icon}</span>
                    <span className={entry.read ? "text-ui-dim" : "font-semibold"}>{renderMessage(entry)}</span>
                  </div>
                </button>
                <div className="flex items-center gap-1 px-3 pb-1.5 pl-6">
                  <span className="text-[10px] text-ui-muted mr-1">{timeAgo(entry.timestamp, nowTicks, tickSpeed, isPaused)}</span>
                  {who.length > 1 && who.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onFocusAgent(id)}
                      className="text-[10px] px-1.5 py-px bg-ui-raised border border-ui-line hover:border-ui-line-accent text-ui-dim hover:text-ui-text rounded-sm"
                    >
                      {nameOf.get(id)}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
