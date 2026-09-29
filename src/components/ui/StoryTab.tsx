import { useState } from "react";
import { useTimeline } from "../../hooks/useTimeline";
import { useWorldState } from "../../hooks/useWorldState";
import { gameMinutes } from "../../../server/lib/gameClock";
import { TimelineList } from "./TimelineList";

interface StoryTabProps {
  agentId: number;
  agentName: string;
  /** Jump to another resident named in a line (never the owner: see subjectOf). */
  onSelectAgent?: (agentId: string) => void;
}

const LEVELS = [
  { value: 0.8, label: "Big moments" },
  { value: 0.6, label: "Notable" },
  { value: 0.3, label: "More" },
] as const;

/** The player's own doings sit at 0.4 (out of the gazette, see activityRegistry) - below "Notable". */
const PLAYER_CATEGORIES = ["player"];

/**
 * "Story so far": one resident's timeline. The same query as the town
 * Timeline, filtered to everything they did OR that happened to them, days
 * newest first. "Big moments" and "Notable" lead each day with the most
 * important line, so the confession outranks the errand it followed; "More" is
 * the full log, so it reads morning to night like a diary (sorted by
 * importance its timestamps jumped around). What the player did to this
 * resident always shows from "Notable" down: it is part of their story even
 * though it is deliberately low-importance.
 */
export function StoryTab({ agentId, agentName, onSelectAgent }: StoryTabProps) {
  const { world } = useWorldState();
  const [minImportance, setMinImportance] = useState<number>(0.6);
  const timeline = useTimeline({
    agentId,
    minImportance,
    order: minImportance <= 0.3 ? "time" : "importance",
    alwaysCategories: minImportance <= 0.6 ? PLAYER_CATEGORIES : undefined,
  });

  return (
    <div>
      <div className="flex gap-1.5 px-3 py-2 border-b border-ui-line" role="group" aria-label="How much of the story">
        {LEVELS.map((l) => (
          <button
            key={l.value}
            type="button"
            aria-pressed={minImportance === l.value}
            onClick={() => setMinImportance(l.value)}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              minImportance === l.value
                ? "bg-ui-hover text-ui-text border-ui-line-accent"
                : "text-ui-dim border-ui-line hover:border-ui-line-accent"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <TimelineList
        compact
        days={timeline.days}
        isLoading={timeline.isLoading}
        isError={timeline.isError}
        hasMore={timeline.hasMore}
        isFetchingMore={timeline.isFetchingMore}
        onLoadMore={timeline.fetchMore}
        nowMinute={world?.time ? gameMinutes(world.time) : null}
        onSelectAgent={onSelectAgent}
        ownerId={agentId}
        ownerName={agentName}
        emptyHint={
          minImportance > 0.3
            ? "Big and notable events land here, most important first — try “More” for the smaller ones."
            : "Their story fills in as the days go by."
        }
      />
    </div>
  );
}
