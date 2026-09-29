import { useState } from "react";
import { useAgents } from "../../hooks/useAgents";
import { useTimeline } from "../../hooks/useTimeline";
import { useWorldState } from "../../hooks/useWorldState";
import { gameMinutes } from "../../../server/lib/gameClock";
import { TimelineList, TIMELINE_CATEGORIES } from "./TimelineList";

interface TimelineViewProps {
  /** A line was clicked: the caller closes the Journal and focuses the resident. */
  onSelectAgent?: (agentId: string) => void;
}

/** What counts as worth a line. `activity_log.importance` runs 0..1; the registry puts drama at 0.8. */
const IMPORTANCE_LEVELS = [
  { value: 0.8, label: "Big moments", hint: "Only the events that shook the town" },
  { value: 0.6, label: "Notable", hint: "Everything that would make the paper" },
  { value: 0.3, label: "More", hint: "Adds goals, states and smaller scenes" },
  { value: 0, label: "Everything", hint: "The whole log, chatter included" },
] as const;

const CATEGORY_KEYS = Object.keys(TIMELINE_CATEGORIES);

/**
 * "What happened yesterday?" — the Journal's Timeline tab: the town's record by
 * game day, a scroll back through everything that mattered
 * (server/lib/timeline.ts), instead of the feed's window of the latest 50 rows.
 * Filter by importance, resident and category; click a line to go to that resident.
 *
 * Mounted only while its tab is showing, so a closed Journal holds no query and
 * no subscription (useTimeline); the filters reset when the tab is left.
 */
export function TimelineView({ onSelectAgent }: TimelineViewProps) {
  const { agents } = useAgents();
  const { world } = useWorldState();
  const [minImportance, setMinImportance] = useState<number>(0.6);
  const [agentId, setAgentId] = useState<number | undefined>(undefined);
  const [categories, setCategories] = useState<string[]>([]);

  const timeline = useTimeline({ minImportance, agentId, categories });
  const nowMinute = world?.time ? gameMinutes(world.time) : null;

  const toggleCategory = (key: string) =>
    setCategories((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const filtered = agentId != null || categories.length > 0 || minImportance !== 0.6;
  const chip = (on: boolean) =>
    `text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
      on ? "bg-ui-hover text-ui-text border-ui-line-accent" : "text-ui-dim border-ui-line hover:border-ui-line-accent"
    }`;

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-ui-line space-y-2 shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {IMPORTANCE_LEVELS.map((l) => (
            <button
              key={l.value}
              type="button"
              onClick={() => setMinImportance(l.value)}
              aria-pressed={minImportance === l.value}
              title={l.hint}
              className={chip(minImportance === l.value)}
            >
              {l.label}
            </button>
          ))}
          <div className="w-px self-stretch bg-ui-line mx-1" />
          <label className="sr-only" htmlFor="timeline-resident">Resident</label>
          <select
            id="timeline-resident"
            value={agentId ?? ""}
            onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : undefined)}
            className="bg-ui-deep border border-ui-line rounded-sm px-2 py-0.5 text-[10px] text-ui-text focus:outline-none focus:border-ui-gold"
          >
            <option value="">Everyone</option>
            {[...agents].sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)).map((a: { id: number; name: string }) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          {filtered && (
            <button
              type="button"
              onClick={() => { setMinImportance(0.6); setAgentId(undefined); setCategories([]); }}
              className="text-[10px] text-ui-dim hover:text-ui-text underline ml-auto"
            >
              Reset
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
          {CATEGORY_KEYS.map((key) => {
            const c = TIMELINE_CATEGORIES[key];
            const on = categories.includes(key);
            return (
              <button key={key} type="button" onClick={() => toggleCategory(key)} aria-pressed={on} className={chip(on)}>
                <span style={{ color: c.color }} aria-hidden="true">{c.icon}</span> {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <TimelineList
          days={timeline.days}
          isLoading={timeline.isLoading}
          isError={timeline.isError}
          hasMore={timeline.hasMore}
          isFetchingMore={timeline.isFetchingMore}
          onLoadMore={timeline.fetchMore}
          nowMinute={nowMinute}
          onSelectAgent={onSelectAgent}
          emptyHint={filtered ? "Nothing matches these filters — try a lower importance or reset them." : undefined}
        />
      </div>
    </div>
  );
}
