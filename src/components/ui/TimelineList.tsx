import { useEffect, useRef } from "react";
import { formatGameMinute, formatTime, gameTimeAgo, seasonEmoji } from "../../lib/formatters";
import { renderMessage } from "../../lib/activityMessage";
import { dayOfMinute, relativeDay, subjectOf, type TimelineDay } from "../../lib/timeline";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

/**
 * Presentation of the categories `activity_log.category` actually holds (the
 * live feed regroups by row type, so its table can't be reused). Colours are
 * the feed's own warm ramp.
 */
export const TIMELINE_CATEGORIES: Record<string, { icon: string; color: string; label: string }> = {
  drama:        { icon: "!", color: "#a03028", label: "Drama" },
  relationship: { icon: "♦", color: "#c06090", label: "Bonds" },
  social:       { icon: "💬", color: "#6080c0", label: "Social" },
  interaction:  { icon: "⚔", color: "#c07840", label: "Scenes" },
  goal:         { icon: "▶", color: "#c07840", label: "Goals" },
  aspiration:   { icon: "★", color: "#9b7ab0", label: "Dreams" },
  world_event:  { icon: "~", color: "#4080a0", label: "World" },
  economy:      { icon: "$", color: "#c8a84b", label: "Money" },
  state:        { icon: "◆", color: "#787060", label: "States" },
  player:       { icon: "✦", color: "#c8a84b", label: "You" },
};
const FALLBACK_CATEGORY = { icon: "·", color: "#787060", label: "Other" };

interface TimelineListProps {
  days: TimelineDay[];
  /** `getTimeline` is still fetching its first page. */
  isLoading: boolean;
  isError?: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore: () => void;
  /** Current game minute, for "yesterday" / "3h ago"; null before the world loads. */
  nowMinute: number | null;
  /** Focus a resident. Rows without a resident to go to stay plain text. */
  onSelectAgent?: (agentId: string) => void;
  /**
   * The resident whose story this is. Clicks then jump to the OTHER person in
   * a line, and the empty state talks about them instead of the town.
   */
  ownerId?: number;
  ownerName?: string;
  /** Narrow layout for the side panel. */
  compact?: boolean;
  /** Shown when nothing matches; the modal says which filter to relax. */
  emptyHint?: string;
}

/**
 * Days as sections, newest first: "Day 12 · autumn · yesterday", that day's
 * Town Crier headline, then the events that mattered with their game time.
 * Scrolling to the end pulls the next page back through the server's cursor.
 * Shared by the town Timeline modal and a resident's Story tab.
 */
export function TimelineList({
  days, isLoading, isError, hasMore, isFetchingMore, onLoadMore, nowMinute,
  onSelectAgent, ownerId, ownerName, compact = false, emptyHint,
}: TimelineListProps) {
  const sentinel = useRef<HTMLDivElement | null>(null);

  // Infinite scroll. The observer is rebuilt after every page (the deps) rather
  // than kept: a page shorter than the viewport leaves the sentinel visible,
  // and an observer that already reported "visible" would never fire again,
  // stalling the scroll one short page in. A fresh observe() reports at once.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || isFetchingMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadMore();
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, isFetchingMore, days.length, onLoadMore]);

  if (isLoading) {
    return (
      <div className="p-4 space-y-3" role="status" aria-label="Loading the timeline">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return <EmptyState icon="⚠" title="Couldn't load the timeline." hint="Is the server running?" />;
  }

  if (days.length === 0) {
    return (
      <EmptyState
        icon="🕰"
        title={ownerName ? `Nothing has happened to ${ownerName} yet.` : "No big moments yet."}
        hint={emptyHint ?? "Notable events collect here, day by day, as the town lives them."}
      />
    );
  }

  const nowDay = nowMinute != null ? dayOfMinute(nowMinute) : null;

  return (
    <div>
      {days.map((d) => (
        <section key={d.day} aria-label={`Day ${d.day}`} className="border-b border-ui-line/60 last:border-b-0">
          <header className={`sticky top-0 z-10 bg-ui-raised/95 backdrop-blur-sm border-b border-ui-line/60 ${compact ? "px-3 py-1.5" : "px-4 py-2"}`}>
            <div className="flex items-baseline gap-2">
              <h3 className="text-xs font-bold text-ui-gold tracking-wide">Day {d.day}</h3>
              <span className="text-[10px] text-ui-dim">
                <span aria-hidden="true">{seasonEmoji(d.season)} </span>
                {d.season}
                {nowDay != null && <> · {relativeDay(d.day, nowDay)}</>}
              </span>
              <span className="ml-auto text-[10px] text-ui-muted">{d.events.length}</span>
            </div>
            {d.headline && (
              <p className="text-[11px] italic text-ui-text/80 leading-snug mt-0.5" title="The Town Crier's headline for the day">
                <span aria-hidden="true">📰 </span>{d.headline}
              </p>
            )}
          </header>
          <ul className={compact ? "px-2 py-1" : "px-3 py-1.5"}>
            {d.events.map((e) => {
              const cat = TIMELINE_CATEGORIES[e.category] ?? FALLBACK_CATEGORY;
              const minute = e.game_minute ?? 0;
              const message = renderMessage(e);
              const clock = formatTime({ hour: Math.floor((minute % 1440) / 60), minute: minute % 60 });
              const subject = subjectOf(e, ownerId);
              const big = e.importance >= 0.8;
              const title = `${formatGameMinute(minute)}${nowMinute != null ? ` · ${gameTimeAgo(minute, nowMinute)}` : ""}`;
              const body = (
                <>
                  <span className="shrink-0 w-3 text-center" style={{ color: cat.color }} aria-hidden="true">{cat.icon}</span>
                  <span className="shrink-0 w-14 text-right text-ui-muted tabular-nums" title={title}>{clock}</span>
                  <span className={big ? "text-ui-text font-semibold" : "text-ui-dim"}>{message}</span>
                </>
              );
              const rowClass = `w-full text-left text-[11px] leading-snug flex gap-1.5 border-l-2 pl-1.5 py-0.5 ${big ? "" : "opacity-90"}`;
              return (
                <li key={e.id}>
                  {onSelectAgent && subject != null ? (
                    <button
                      type="button"
                      onClick={() => onSelectAgent(String(subject))}
                      className={`${rowClass} cursor-pointer hover:bg-ui-hover focus-visible:bg-ui-hover transition-colors`}
                      style={{ borderLeftColor: cat.color, borderLeftWidth: big ? 3 : 2 }}
                      aria-label={`${clock} ${message} — focus resident`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={rowClass} style={{ borderLeftColor: cat.color, borderLeftWidth: big ? 3 : 2 }}>
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {/* Scroll end: loads the next page, with a button for keyboard users. */}
      <div ref={sentinel} className="px-4 py-3 text-center text-[10px] text-ui-muted">
        {isFetchingMore ? (
          <span role="status">Reading further back…</span>
        ) : hasMore ? (
          <button type="button" onClick={onLoadMore} className="hover:text-ui-text underline">
            Load older days
          </button>
        ) : (
          <span>The beginning of the record.</span>
        )}
      </div>
    </div>
  );
}
