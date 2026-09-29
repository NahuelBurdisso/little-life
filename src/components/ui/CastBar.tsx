import { useEffect, useMemo, useRef, useState } from "react";
import { MiniPortrait } from "./MiniPortrait";
import { portraitMood } from "./portraitMood";
import { actionIcon, describeAction } from "../../lib/actionText";

/** The slice of an `agents.getActive` row the bar reads. */
interface CastAgent {
  id: number | string;
  name: string;
  portrait_sprite?: string;
  current_action?: unknown;
  current_location?: number | null;
  needs?: { mood?: number } | null;
  activeStates?: ReadonlyArray<{ type: string }>;
}

interface CastBarProps {
  /** Already in cast order (favourites first) — see `orderCast`. */
  agents: readonly CastAgent[];
  locations: ReadonlyArray<{ id: number; name: string }>;
  /** Rows from `conversations.getActive`; participants get the talking badge. */
  conversations: ReadonlyArray<{ status?: string; participants?: unknown }>;
  selectedAgentId: string | null;
  favorites: ReadonlySet<string>;
  onToggleFavorite: (agentId: string) => void;
  /** Click: select the resident and centre the camera on them. */
  onFocus: (agentId: string) => void;
  /** Double-click: select and lock the camera on them. */
  onFollow: (agentId: string) => void;
  /** Right-click: the same nudge menu as right-clicking their sprite. */
  onContextMenu: (agentId: string, pos: { x: number; y: number }) => void;
}

const COLLAPSED_KEY = "little-life:castbar:collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function actionType(action: unknown): string | null {
  if (action && typeof action === "object") {
    const t = (action as { type?: unknown }).type;
    if (typeof t === "string") return t;
  }
  return typeof action === "string" ? action : null;
}

/**
 * A strip of resident chips under the top bar, so the player never has to hunt
 * for someone on the map. It sits in the layout flow instead of floating over the
 * canvas: nothing on the map (or in the corners the toolbar and Follow button
 * use) ends up underneath it, and it scrolls sideways when the window is narrow.
 */
export function CastBar({
  agents,
  locations,
  conversations,
  selectedAgentId,
  favorites,
  onToggleFavorite,
  onFocus,
  onFollow,
  onContextMenu,
}: CastBarProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        // Per-viewer convenience only: fine to forget it.
      }
      return !c;
    });
  };

  const placeName = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations]);
  const talking = useMemo(() => {
    const ids = new Set<string>();
    for (const c of conversations) {
      if (c.status !== "active" || !Array.isArray(c.participants)) continue;
      for (const p of c.participants) ids.add(String(p));
    }
    return ids;
  }, [conversations]);

  // Keep the selected chip in view: Tab-cycling past the visible edge of a
  // scrolled strip would otherwise select someone the player can't see.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (collapsed || !selectedAgentId) return;
    const chip = stripRef.current?.querySelector<HTMLElement>(`[data-cast-id="${selectedAgentId}"]`);
    chip?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedAgentId, collapsed, agents.length]);

  return (
    <div className="flex items-stretch bg-ui-panel border-b border-ui-line flex-shrink-0" role="region" aria-label="Cast">
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        title={collapsed ? "Show the cast bar" : "Hide the cast bar"}
        className="flex-shrink-0 flex items-center gap-1.5 px-2.5 text-[10px] uppercase tracking-wider text-ui-dim hover:text-ui-text hover:bg-ui-hover transition-colors border-r border-ui-line"
      >
        <span aria-hidden="true" className="text-[9px]">{collapsed ? "▸" : "▾"}</span>
        Cast
        <span className="text-ui-muted normal-case tracking-normal">{agents.length}</span>
      </button>

      {!collapsed && (
        <div
          ref={stripRef}
          className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-2 overflow-x-auto [scrollbar-width:thin] [scrollbar-color:var(--ui-border-accent)_transparent]"
          role="list"
        >
          {agents.length === 0 && <span className="text-[11px] text-ui-muted px-1">Nobody in town yet.</span>}
          {agents.map((agent) => {
            const id = String(agent.id);
            const selected = id === selectedAgentId;
            const starred = favorites.has(id);
            const type = actionType(agent.current_action);
            const asleep = type === "sleeping";
            const chatting = type === "talking" || talking.has(id);
            const place = placeName.get(agent.current_location ?? -1) ?? null;
            const doing = describeAction(agent.current_action, place);
            // "Sleeping at X" already names the place; other verbs get it appended
            // only when the sentence doesn't carry it.
            const where = place && !doing.includes(place) ? ` · ${place}` : "";
            const summary = `${agent.name}: ${doing}${where}`;
            // "Dr. Sofia Petrov" should read Sofia, not "Dr.".
            const nameParts = agent.name.split(" ").filter(Boolean);
            const firstName = (nameParts.find((p) => !p.endsWith(".")) ?? nameParts[0] ?? agent.name);

            return (
              <div key={id} role="listitem" className="relative flex-shrink-0 group" data-cast-id={id}>
                <button
                  type="button"
                  onClick={() => onFocus(id)}
                  onDoubleClick={() => onFollow(id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onContextMenu(id, { x: e.clientX, y: e.clientY });
                  }}
                  aria-pressed={selected}
                  aria-label={summary}
                  title={`${summary}\nClick: focus · Double-click: follow · Right-click: actions`}
                  className={`flex items-center gap-1.5 pl-1 pr-2 py-0.5 border transition-colors ${
                    selected
                      ? "border-ui-gold bg-ui-gold/15 text-ui-gold"
                      : "border-ui-line bg-ui-raised text-ui-text hover:bg-ui-hover hover:border-ui-line-accent"
                  } ${asleep ? "opacity-70" : ""}`}
                >
                  <span className="relative flex-shrink-0">
                    <MiniPortrait agent={agent} size={28} mood={portraitMood(agent.needs?.mood, agent.activeStates)} />
                    {/* Sleeping / talking read as a badge on the face; the activity glyph sits opposite. */}
                    {(asleep || chatting) && (
                      <span
                        aria-hidden="true"
                        className="absolute -top-1 -right-1 text-[10px] leading-none drop-shadow"
                      >
                        {asleep ? "💤" : "💬"}
                      </span>
                    )}
                    {/* Asleep / chatting already have their glyph above; don't say it twice. */}
                    {!asleep && !chatting && (
                      <span
                        aria-hidden="true"
                        className="absolute -bottom-1 -right-1 text-[10px] leading-none bg-ui-deep/80 rounded-sm px-px"
                      >
                        {actionIcon(agent.current_action)}
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] max-w-16 truncate">{firstName}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onToggleFavorite(id)}
                  aria-pressed={starred}
                  aria-label={starred ? `Unstar ${agent.name}` : `Star ${agent.name}`}
                  title={starred ? "Remove from favourites" : "Add to favourites"}
                  className={`absolute -top-1 -left-1 w-4 h-4 flex items-center justify-center text-[11px] leading-none bg-ui-deep/85 border border-ui-line transition-opacity ${
                    starred
                      ? "text-ui-gold opacity-100"
                      : "text-ui-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-ui-gold"
                  }`}
                >
                  {starred ? "★" : "☆"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
