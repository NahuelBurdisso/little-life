import { useState } from "react";
import { useNudge } from "../../hooks/useNudge";
import { eventBlurb, eventIcon, formatTimeLeft } from "../../lib/eventUi";
import { displayPlaceName, hoursSummary, locationIcon, prettyLocationType, type LocationLike } from "../../lib/locationInfo";
import { eventMinutesLeft } from "../../../server/lib/gameClock";
import { MiniPortrait } from "./MiniPortrait";
import { W } from "./warmClasses";
import type { AgentView, WorldEventView } from '../../lib/apiTypes';

interface LocationPanelProps {
  location: LocationLike & { description?: string; capacity?: number };
  agents: AgentView[];
  /** Active world events (`world.getActiveEvents` rows). */
  events: WorldEventView[];
  /** World clock hour (0-23) for the open/closed badge; null before the world loads. */
  hour: number | null;
  nowMinutes: number | null;
  selectedAgentId: string | null;
  /** Select + focus an occupant (App's `focusAgent`). */
  onSelectAgent: (agentId: string) => void;
  onClose: () => void;
  /** Left offset in px, so the card clears the conversations sidebar. */
  left: number;
}

/**
 * Below this window width the card opens folded to its header. It floats over the map
 * right of the left sidebar, and at 1024 px a fixed 270 px card covered about half of
 * the ~540 px of map that is left. Same reasoning as App's narrower starting sidebars
 * (< 1200): the player can still unfold it with the chevron.
 */
const START_FOLDED_BELOW = 1200;

function actionType(agent: AgentView): string {
  const a = agent?.current_action;
  return (typeof a === "string" ? a : a?.type) ?? "idle";
}

/**
 * Card for a clicked building or open area: what it is, whether it is open, who is
 * inside, what is happening there, and (with an agent selected) a one-click "send
 * them here". Occupants come from the live agent list rather than
 * `locations.current_occupants`: the `locations.getAll` query is on no
 * invalidation channel, so that column would be frozen at load time.
 */
export function LocationPanel({
  location,
  agents,
  events,
  hour,
  nowMinutes,
  selectedAgentId,
  onSelectAgent,
  onClose,
  left,
}: LocationPanelProps) {
  const { suggestGoTo } = useNudge();
  // Read once on mount: a window resized later keeps whatever the player chose.
  const [folded, setFolded] = useState(() => typeof window !== "undefined" && window.innerWidth < START_FOLDED_BELOW);

  const occupants = agents
    .filter((a) => a.current_location === location.id)
    .sort((a, b) => Number(actionType(a) === "sleeping") - Number(actionType(b) === "sleeping"));
  const here = events.filter((e) => e.location_id === location.id);
  const kind = prettyLocationType(location.type);
  const hours = hour != null ? hoursSummary(location.operating_hours, hour) : null;

  const selected = selectedAgentId ? agents.find((a) => String(a.id) === selectedAgentId) : null;
  const selectedFirst = selected ? String(selected.name).split(" ")[0] : "";
  let sendBlock: string | null = null;
  if (selected) {
    if (selected.current_location === location.id) sendBlock = `${selectedFirst} is already here`;
    else if (actionType(selected) === "sleeping") sendBlock = `${selectedFirst} is asleep`;
  }

  return (
    <div
      className="fixed top-[92px] z-30 max-h-[55vh] flex flex-col overflow-hidden bg-[var(--ui-bg-panel)] border border-[var(--ui-border-accent)] shadow-2xl text-[var(--ui-text-primary)]"
      // 22vw: 225 px at 1024, the old 270 px from ~1230 px up.
      style={{ left, width: "clamp(200px, 22vw, 270px)" }}
      role="dialog"
      aria-label={displayPlaceName(location.name, { sentenceStart: true })}
    >
      <div className={W.modalHeader}>
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-lg leading-none">{locationIcon(location.type)}</span>
          <div className="min-w-0">
            <div className={`${W.title} truncate`}>{displayPlaceName(location.name, { sentenceStart: true })}</div>
            {/* Derived outdoor spots are named after their type ("Town Hall"): don't say it twice. */}
            {kind !== location.name && <div className={`text-[10px] ${W.muted}`}>{kind}</div>}
          </div>
        </div>
        <div className="flex items-center shrink-0">
          <button
            onClick={() => setFolded((f) => !f)}
            className={`${W.close} text-xs`}
            aria-label={folded ? "Expand details" : "Collapse details"}
            aria-expanded={!folded}
          >
            {folded ? "▸" : "▾"}
          </button>
          <button onClick={onClose} className={W.close} aria-label="Close">
            &times;
          </button>
        </div>
      </div>

      {!folded && (
      <div className="overflow-y-auto">
        {location.description && (
          <p className={`px-4 pt-2.5 text-[11px] leading-snug ${W.muted}`}>{location.description}</p>
        )}

        <div className="px-4 py-2 flex items-center gap-2 text-[11px]">
          <span className={W.muted}>Hours</span>
          <span>{hours?.range ?? "—"}</span>
          {hours && (
            <span
              className="ml-auto px-1.5 py-0.5 text-[10px] font-bold border"
              style={{
                color: hours.open ? "var(--ui-positive)" : "var(--ui-negative)",
                borderColor: hours.open ? "var(--ui-positive)" : "var(--ui-negative)",
              }}
            >
              {hours.open ? "OPEN" : "CLOSED"}
            </span>
          )}
        </div>

        {here.length > 0 && (
          <div className={W.section}>
            <h3 className={W.sectionTitle}>Happening here</h3>
            <div className="space-y-1.5">
              {here.map((e) => (
                <div key={e.id} className="flex items-start gap-2 text-[11px]">
                  <span className="leading-none mt-0.5">{eventIcon(e.type)}</span>
                  <div className="min-w-0">
                    <div className="font-bold">
                      {e.name}
                      {nowMinutes != null && e.started_at != null && e.duration != null && (
                        <span className="ml-2 font-normal text-[10px] text-[var(--ui-accent-gold)]">
                          {formatTimeLeft(eventMinutesLeft(e, nowMinutes))}
                        </span>
                      )}
                    </div>
                    <div className={`text-[10px] ${W.muted}`}>{eventBlurb(e.type, e.description ?? "")}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={W.section}>
          <h3 className={W.sectionTitle}>
            Inside ({occupants.length}
            {location.capacity ? `/${location.capacity}` : ""})
          </h3>
          {occupants.length === 0 ? (
            <p className={`text-[11px] ${W.faint}`}>Nobody here right now.</p>
          ) : (
            <ul className="space-y-0.5">
              {occupants.map((a) => {
                const type = actionType(a);
                const asleep = type === "sleeping";
                return (
                  <li key={a.id}>
                    <button
                      onClick={() => onSelectAgent(String(a.id))}
                      className="w-full flex items-center gap-2 px-1.5 py-1 text-left text-xs hover:bg-[var(--ui-bg-hover)] transition-colors"
                      title={`Focus on ${a.name}`}
                    >
                      <MiniPortrait agent={a} size={22} dim={asleep} />
                      <span className="truncate">{a.name}</span>
                      <span className={`ml-auto pl-2 text-[10px] shrink-0 ${W.muted}`}>
                        {asleep ? "💤 " : ""}
                        {type.replace(/_/g, " ")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      )}

      {!folded && selected && (
        <div className="px-4 py-2.5 border-t border-[var(--ui-border)] bg-[var(--ui-bg-raised)]">
          <button
            disabled={sendBlock !== null}
            title={sendBlock ?? undefined}
            onClick={() => suggestGoTo(selected.id, location.id, location.name)}
            className={`w-full px-2 py-1.5 text-xs ${W.btnPrimary}`}
          >
            🚶 Send {selectedFirst} here
          </button>
          {sendBlock && <p className={`mt-1 text-[10px] ${W.muted}`}>{sendBlock}</p>}
        </div>
      )}
    </div>
  );
}
