import { useState } from "react";
import { formatGameMinute, gameTimeAgo } from "../../lib/formatters";
import type { ArcKind, StoryArc } from "../../../server/lib/chronicle";
import type { BrewingItem, BrewingKind } from "../../../server/lib/brewing";
import { EmptyState } from "./EmptyState";

/**
 * The Journal's Brewing and Stories tabs (they used to be tabs of the activity
 * feed, squeezed into its ~120px strip). Presentational: Journal.tsx owns the
 * queries, whose freshness comes from the feed's `activity.onUpdate`
 * subscription (useActivityFeed).
 */

/** Presentation for the derived story arcs on the Stories tab. */
const ARC_KINDS: Record<ArcKind, { icon: string; color: string }> = {
  romance:        { icon: '♥', color: '#c06090' },
  rivalry:        { icon: '⚔', color: '#a03028' },
  reconciliation: { icon: '☘', color: '#a0c060' },
  love_triangle:  { icon: '△', color: '#9b7ab0' },
  downfall:       { icon: '▼', color: '#c07840' },
  scandal:        { icon: '◉', color: '#c8a84b' },
};

/** Presentation for the Brewing tab: what kind of trouble a row is. */
const BREWING_KINDS: Record<BrewingKind, { icon: string; label: string }> = {
  snap:          { icon: '🔥', label: 'About to snap' },
  secret:        { icon: '🤫', label: 'Secret spreading' },
  confrontation: { icon: '⚔', label: 'Confrontation queued' },
  nudge:         { icon: '✦', label: 'Your nudge is waiting' },
  goal:          { icon: '▶', label: 'Goal within reach' },
  relationship:  { icon: '♥', label: 'About to change' },
};

/**
 * Heat -> colour, on the feed's own warm ramp (ui-gold -> the goal orange -> the
 * drama red) so a hot row reads as the same "danger" the Drama chip already means.
 */
function heatColor(heat: number): string {
  if (heat >= 0.85) return '#a03028';
  if (heat >= 0.6) return '#c07840';
  return '#c8a84b';
}

export function BrewingList({
  items,
  onSelectAgent,
}: {
  items: readonly BrewingItem[];
  onSelectAgent?: (agentId: string) => void;
}) {
  if (items.length === 0) {
    return <EmptyState icon="🔥" title="All quiet." hint="Nothing is about to boil over. Tension, spreading secrets and queued confrontations show up here before they go off." />;
  }
  return (
    <div className="space-y-0.5 px-3 py-2">
      {items.map(item => {
        const { icon, label } = BREWING_KINDS[item.kind];
        const color = heatColor(item.heat);
        const pct = Math.round(item.heat * 100);
        const focusId = item.agentIds[0];
        const body = (
          <>
            <span className="shrink-0" title={label}>{icon}</span>
            <span className="text-ui-dim flex-1">{item.text}</span>
            {/* Heat bar: how close to going off. The hottest pulse. */}
            <span
              className="shrink-0 inline-block w-16 h-1.5 bg-ui-line self-center"
              title={`${label} — heat ${pct}%`}
              role="img"
              aria-label={`Heat ${pct}%`}
            >
              <span
                className={`block h-full ${item.heat >= 0.85 ? 'brew-pulse' : ''}`}
                style={{ width: `${pct}%`, backgroundColor: color }}
              />
            </span>
          </>
        );
        const rowClass = 'w-full text-left text-xs flex gap-2 border-l-2 pl-2 py-1';
        return onSelectAgent && focusId != null ? (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectAgent(String(focusId))}
            className={`${rowClass} cursor-pointer hover:bg-ui-hover focus-visible:bg-ui-hover transition-colors`}
            style={{ borderLeftColor: color }}
            aria-label={`${item.text} — focus agent`}
          >
            {body}
          </button>
        ) : (
          <div key={item.id} className={rowClass} style={{ borderLeftColor: color }}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

export function StoryArcList({
  arcs,
  nowMinute,
  onSelectAgent,
}: {
  arcs: readonly StoryArc[];
  /** Current game minute for the beats' ages; null before the world loads. */
  nowMinute: number | null;
  onSelectAgent?: (agentId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (arcs.length === 0) {
    return <EmptyState icon="📖" title="No stories yet." hint="Romances, rivalries and scandals take shape here once the town has some history." />;
  }
  return (
    <div className="space-y-2 px-3 py-2">
      {arcs.map(arc => {
        const { icon, color } = ARC_KINDS[arc.kind];
        const isExpanded = expanded.has(arc.id);
        return (
          <div key={arc.id} className="border-l-2 pl-2" style={{ borderLeftColor: color }}>
            <button
              type="button"
              onClick={() => toggle(arc.id)}
              aria-expanded={isExpanded}
              className="w-full text-left text-xs flex gap-1.5 items-center py-0.5 cursor-pointer hover:bg-ui-hover focus-visible:bg-ui-hover transition-colors"
            >
              <span className="shrink-0" style={{ color }}>{icon}</span>
              <span className="font-semibold flex-1" style={{ color }}>{arc.title}</span>
              {/* Heat: how live the thread is, not how long it has run. */}
              <span
                className="shrink-0 inline-block w-10 h-1 bg-ui-line"
                title={`Heat ${Math.round(arc.heat * 100)}%`}
              >
                <span
                  className="block h-full"
                  style={{ width: `${Math.round(arc.heat * 100)}%`, backgroundColor: color }}
                />
              </span>
              <span className="shrink-0 text-ui-muted">{isExpanded ? '▲' : '▼'}</span>
            </button>

            <p className="text-[11px] text-ui-dim italic pl-4">{arc.summary}</p>

            {/* Cast, so an arc can be used to jump to whoever is in it —
                the header is already a toggle, so these can't live in it. */}
            {onSelectAgent && (
              <div className="flex flex-wrap gap-1 pl-4 py-0.5">
                {arc.participants.map((id, pi) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSelectAgent(String(id))}
                    className="text-[10px] px-1 border border-ui-line text-[#a09070] hover:bg-ui-hover focus-visible:bg-ui-hover transition-colors"
                  >
                    {arc.participantNames[pi]}
                  </button>
                ))}
              </div>
            )}

            {isExpanded && (
              <div className="ml-3 border-l-2 border-ui-line-accent pl-1.5 space-y-0.5 mb-1">
                {arc.beats.map((beat, bi) => (
                  <div key={`${arc.id}-${bi}`} className="text-[11px] flex gap-1.5">
                    {/* Game time on both ends: a beat's age stands still while
                        the game is paused and counts game days, not the hours
                        the server happened to run. Undated beats (a scandal's
                        backstory secret) get no age rather than a made-up one. */}
                    <span
                      className="text-ui-muted shrink-0 w-12 text-right"
                      title={beat.gameMinute != null ? formatGameMinute(beat.gameMinute) : undefined}
                    >
                      {nowMinute != null && beat.gameMinute != null ? gameTimeAgo(beat.gameMinute, nowMinute) : ''}
                    </span>
                    <span className="text-[#a09070]">{beat.description}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
