import { useEffect } from "react";
import type { InboxEntry } from "../../lib/alertInbox";
import { TIER_STYLE } from "../../lib/alertTierStyle";
import { renderMessage } from "../../lib/activityMessage";
import { timeAgo } from "../../lib/formatters";
import { useEscapeClose } from "../../hooks/useEscapeClose";

interface InboxProps {
  isOpen: boolean;
  onClose: () => void;
  entries: readonly InboxEntry[];
  onMarkAllRead: () => void;
  onClear: () => void;
  /** Resident names for the "who" chips; ids missing here (removed residents) are skipped. */
  agents: ReadonlyArray<{ id: number | string; name: string }>;
  onFocusAgent: (agentId: string) => void;
  /** World clock, for the same "12m ago" game-time ages the activity feed shows. */
  nowTicks: number;
  tickSpeed: number;
  isPaused: boolean;
}

/**
 * The 🔔 inbox: every alert of this session after its toast has gone, newest
 * first (state in useDramaAlerts, list rules in lib/alertInbox.ts). A row
 * focuses its first resident; each resident also gets a chip, since the story
 * is often about the other one ("Your rumor reached Rosa" — Ray is the teller).
 *
 * A popover under the TopBar rather than a modal: the point of opening it is
 * usually to jump to someone on the map, so it closes on that jump, on a click
 * outside, and on Escape (taken in the capture phase, like the guide overlays,
 * because App's Escape chain doesn't know about it).
 */
export function Inbox({
  isOpen, onClose, entries, onMarkAllRead, onClear, agents, onFocusAgent, nowTicks, tickSpeed, isPaused,
}: InboxProps) {
  useEscapeClose(isOpen, onClose);

  // Opening it is reading it. Marked on open rather than on close so the badge
  // clears the moment the list is in front of the player; rows that arrive
  // while it is open stay unread (bold) until next time.
  useEffect(() => {
    // `onMarkAllRead` is a stable callback (useDramaAlerts), so this runs on
    // the open transition only.
    if (isOpen) onMarkAllRead();
  }, [isOpen, onMarkAllRead]);

  if (!isOpen) return null;

  const nameOf = new Map(agents.map((a) => [String(a.id), a.name.split(" ")[0]]));

  return (
    <>
      {/* Click-away layer: transparent, below the panel, above the map. */}
      <button
        type="button"
        aria-label="Close inbox"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Alerts inbox"
        className="fixed top-12 right-4 z-50 w-96 max-w-[calc(100vw-2rem)] max-h-[60vh] flex flex-col bg-ui-panel border border-ui-line shadow-xl text-ui-text"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-ui-line">
          <span className="font-bold text-sm text-ui-gold">🔔 Inbox</span>
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
          <button
            type="button"
            onClick={onClose}
            className="text-ui-dim hover:text-ui-text text-sm leading-none px-1"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {entries.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-ui-muted">
            Nothing yet. Big moments in town — and what your nudges came to — will collect here.
          </div>
        ) : (
          <ul className="overflow-y-auto">
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
                      if (first == null) return;
                      onFocusAgent(first);
                      onClose();
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
                        onClick={() => {
                          onFocusAgent(id);
                          onClose();
                        }}
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
    </>
  );
}
