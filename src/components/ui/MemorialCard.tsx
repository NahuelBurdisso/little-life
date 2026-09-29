import { trpc } from "../../lib/trpc";
import { renderMessage, type ActivityEntry } from "../../lib/activityMessage";
import { timeAgo } from "../../lib/formatters";
import { AgentPortrait } from "./AgentPortrait";
import { EmptyState } from "./EmptyState";

interface MemorialCardProps {
  agent: {
    id: number;
    name: string;
    age: number;
    bio?: string | null;
    portrait_sprite?: string;
    traits?: string[];
  };
  economy: { job_title: string } | null;
  /** Newest first, as `getAgentSummary` returns them — the deceased keeps their memory stream. */
  memories: ReadonlyArray<{ id: number; description: string; type: string; created_at: number }>;
  world: { time: { totalTicks: number }; tick_speed: number; is_paused: boolean } | null | undefined;
  onClose: () => void;
}

/**
 * What the side panel shows for someone who has died. There is no cause-of-death
 * column, but `lifeEventsEngine.logDeath` writes a drama entry initiated by the
 * deceased ("X has died. <cause>. The town mourns."), so the cause and the date
 * are recovered from the activity log instead of needing a new query.
 */
export function MemorialCard({ agent, economy, memories, world, onClose }: MemorialCardProps) {
  const { data: entries } = trpc.activity.getRecent.useQuery({
    agentId: agent.id,
    categories: ["drama"],
    limit: 20,
  });

  const deathEntry = (entries as unknown as ActivityEntry[] | undefined)?.find((e) =>
    /has died/.test(renderMessage(e)),
  );
  const deathText = deathEntry ? renderMessage(deathEntry) : null;
  // "Omar has died. Caught in a fall. The town mourns." -> "Caught in a fall"
  const cause = deathText
    ?.replace(/^.*?\bhas died\.?\s*/, "")
    .replace(/\s*The town mourns\.?$/, "")
    .replace(/\.$/, "")
    .trim();
  const when =
    deathEntry && world
      ? timeAgo(deathEntry.timestamp, world.time.totalTicks, world.tick_speed, world.is_paused)
      : null;

  // Plans read as a to-do list, not a last word: prefer the most recent thing they
  // felt, said or noticed, and only fall back to whatever is newest.
  const lastMemory = memories.find((m) => m.type !== "plan" && m.type !== "routine") ?? memories[0];

  return (
    <div className="h-full bg-ui-panel border-l border-ui-line flex flex-col overflow-hidden">
      <div className="p-3 border-b border-ui-line flex justify-between items-start flex-shrink-0">
        <AgentPortrait agent={agent} economy={economy} deceased />
        <button
          onClick={onClose}
          className="text-ui-dim hover:text-ui-text text-lg leading-none ml-2 flex-shrink-0"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Epitaph */}
        <div className="px-3 py-4 border-b border-ui-line text-center bg-ui-deep/40">
          <div className="text-2xl opacity-70" aria-hidden="true">🕯</div>
          <div className="text-xs tracking-[0.2em] uppercase text-ui-dim mt-1">In memory of</div>
          <div className="text-base font-bold text-ui-text mt-0.5">{agent.name}</div>
          <div className="text-[11px] text-ui-muted">
            {economy?.job_title ? `${economy.job_title} · ` : ""}aged {agent.age}
          </div>
        </div>

        <div className="px-3 py-2 border-b border-ui-line">
          <div className="text-xs text-ui-dim font-medium mb-1">Passing</div>
          {cause ? (
            <p className="text-[11px] text-ui-text leading-relaxed">
              {cause}
              {when && <span className="text-ui-muted"> · {when}</span>}
            </p>
          ) : (
            <p className="text-[11px] text-ui-muted leading-relaxed">
              {agent.name} has passed away. The town remembers.
            </p>
          )}
        </div>

        {agent.traits && agent.traits.length > 0 && (
          <div className="px-3 py-2 border-b border-ui-line">
            <div className="text-xs text-ui-dim font-medium mb-1.5">Remembered as</div>
            <div className="flex flex-wrap gap-1">
              {agent.traits.map((t) => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-sm bg-ui-raised text-ui-text">
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="px-3 py-2 border-b border-ui-line">
          <div className="text-xs text-ui-dim font-medium mb-1">Last thought</div>
          {lastMemory ? (
            <p className="text-[11px] text-ui-text leading-relaxed italic border-l-2 border-ui-line-accent pl-2 line-clamp-5">
              “{lastMemory.description}”
            </p>
          ) : (
            <EmptyState compact icon="💭" title="Nothing was recorded." />
          )}
        </div>

        {agent.bio && (
          <div className="px-3 py-2 border-b border-ui-line">
            <div className="text-xs text-ui-dim font-medium mb-1">Backstory</div>
            <p className="text-[11px] text-ui-dim leading-relaxed">{agent.bio}</p>
          </div>
        )}
      </div>
    </div>
  );
}
