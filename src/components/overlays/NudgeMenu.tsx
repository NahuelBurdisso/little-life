import { useState, useEffect, useRef, type ReactNode } from "react";
import { useNudge } from "../../hooks/useNudge";
import { trpc } from "../../lib/trpc";
import { locationIcon } from "../../lib/locationInfo";
import { MiniPortrait } from "../ui/MiniPortrait";
import { W } from "../ui/warmClasses";

interface NudgeMenuProps {
  agentId: string;
  selectedAgentId: string | null;
  position: { x: number; y: number };
  agents: any[];
  locations: any[];
  onClose: () => void;
  onSelectAgent: (id: string) => void;
}

type SubMenu = "talk" | "goto" | "money" | "pair" | "topic" | "secret" | null;

/** The sim refuses talk/go-to nudges for sleepers (server/routers/nudge.ts), so grey them out up front. */
function isAsleep(agent: any): boolean {
  const a = agent?.current_action;
  const type = typeof a === "string" ? a : a?.type;
  return type === "sleeping";
}

function AsleepTag() {
  return (
    <span className="ml-auto pl-2 text-[10px] text-[var(--ui-text-secondary)] shrink-0">💤 asleep</span>
  );
}

function Item({
  icon,
  children,
  onClick,
  disabled,
  title,
  danger,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs transition-colors ${
        disabled
          ? "text-[var(--ui-text-disabled)] cursor-not-allowed"
          : danger
            ? "text-[var(--ui-negative)] hover:bg-[var(--ui-negative)]/15"
            : "text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-hover)]"
      }`}
    >
      {icon != null && <span className="w-4 shrink-0 text-center">{icon}</span>}
      <span className="flex items-center flex-1 min-w-0">{children}</span>
    </button>
  );
}

export function NudgeMenu({
  agentId,
  selectedAgentId,
  position,
  agents,
  locations,
  onClose,
  onSelectAgent,
}: NudgeMenuProps) {
  const { suggestTalk, suggestGoTo, giveMoney, removeAgent, tellSecret, forceConfront } = useNudge();
  const [subMenu, setSubMenu] = useState<SubMenu>(null);
  const [topicText, setTopicText] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** Partner picked from the "Pair with..." entry; wins over the canvas selection. */
  const [pairWith, setPairWith] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu closes on every action (useNudge toasts the outcome), so the only way
  // to double-submit is two events landing before React unmounts it (Enter + click).
  const firedRef = useRef(false);

  const currentAgent = agents.find((a: any) => String(a.id) === agentId);
  const otherAgents = agents.filter((a: any) => String(a.id) !== agentId);
  const partnerId =
    pairWith ?? (selectedAgentId !== null && selectedAgentId !== agentId ? selectedAgentId : null);
  const partner = partnerId ? agents.find((a: any) => String(a.id) === partnerId) : null;
  const isPairMode = partnerId !== null;
  const eitherAsleep = isAsleep(currentAgent) || isAsleep(partner);

  const fire = (action: () => void) => {
    if (firedRef.current) return;
    firedRef.current = true;
    action();
    onClose();
  };

  // A right-click on another agent while the menu is open swaps the props without
  // remounting; start that menu from scratch so it never inherits the last one's
  // submenu, partner or spent double-submit guard.
  useEffect(() => {
    firedRef.current = false;
    setSubMenu(null);
    setPairWith(null);
    setConfirmRemove(false);
  }, [agentId, position.x, position.y]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Close on escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (subMenu) setSubMenu(null);
        else onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, subMenu]);

  // Only the secret picker needs this, and it is a full-table scan server-side.
  const { data: knownFacts } = trpc.knowledge.getKnownBy.useQuery(
    { agentId: Number(agentId) },
    { enabled: subMenu === "secret" },
  );

  // A secret the listener already knows is not a reveal, so drop those.
  const tellableSecrets = (knownFacts ?? [])
    .filter(
      (f: any) => f.sensitivity >= 2 && !(f.known_by as number[]).includes(Number(partnerId)),
    )
    .sort((a: any, b: any) => b.sensitivity - a.sensitivity)
    .slice(0, 8);

  // Clamp position to viewport
  const left = Math.max(4, Math.min(position.x, window.innerWidth - 250));
  const top = Math.max(4, Math.min(position.y, window.innerHeight - 340));

  const frame = `fixed z-50 ${W.modal} min-w-[220px] max-w-[280px] max-h-[70vh] py-1`;
  const back = (onBack: () => void, label = "← Back") => (
    <button
      type="button"
      className="w-full text-left px-3 py-1 text-[10px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]"
      onClick={onBack}
    >
      {label}
    </button>
  );
  const header = (children: ReactNode) => (
    <div className="px-3 py-1 mb-0.5 flex items-center gap-1.5 text-[10px] text-[var(--ui-accent-gold)] uppercase tracking-wider border-b border-[var(--ui-border)]">
      {children}
    </div>
  );

  // ─── Pair mode: two agents, secrets / confrontation / chat ───────────────────
  if (isPairMode) {
    return (
      <div ref={menuRef} className={frame} style={{ left, top }}>
        {header(
          <>
            {currentAgent && <MiniPortrait agent={currentAgent} size={16} />}
            <span className="truncate">{currentAgent?.name ?? "Agent"}</span>
            <span className="text-[var(--ui-text-secondary)]">+</span>
            {partner && <MiniPortrait agent={partner} size={16} />}
            <span className="truncate">{partner?.name ?? "Agent"}</span>
          </>,
        )}
        {subMenu === "topic" ? (
          <div className="px-3 py-1.5">
            <input
              autoFocus
              type="text"
              placeholder="Enter topic..."
              value={topicText}
              onChange={(e) => setTopicText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && topicText.trim()) {
                  fire(() => suggestTalk(agentId, partnerId!, topicText.trim()));
                }
              }}
              className={W.input}
            />
            <button
              disabled={!topicText.trim()}
              onClick={() => fire(() => suggestTalk(agentId, partnerId!, topicText.trim()))}
              className={`mt-1.5 w-full text-center px-2 py-1 text-xs ${W.btnPrimary}`}
            >
              Send
            </button>
          </div>
        ) : subMenu === "secret" ? (
          <div className="max-h-56 overflow-y-auto">
            {back(() => setSubMenu(null))}
            {tellableSecrets.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-[var(--ui-text-secondary)]">
                {currentAgent?.name ?? "They"} knows no secrets the other doesn't.
              </p>
            ) : (
              tellableSecrets.map((f: any) => (
                <Item
                  key={f.id}
                  icon="🤫"
                  title={f.content}
                  onClick={() => fire(() => tellSecret(agentId, partnerId!, f.id))}
                >
                  <span className="truncate">{f.content}</span>
                </Item>
              ))
            )}
          </div>
        ) : (
          <>
            {pairWith && back(() => setPairWith(null), "← Pick someone else")}
            <Item
              icon="💬"
              disabled={eitherAsleep}
              title={eitherAsleep ? "Someone is asleep" : undefined}
              onClick={() => fire(() => suggestTalk(agentId, partnerId!))}
            >
              Suggest they chat
            </Item>
            <Item
              icon="📝"
              disabled={eitherAsleep}
              title={eitherAsleep ? "Someone is asleep" : undefined}
              onClick={() => setSubMenu("topic")}
            >
              Suggest topic...
            </Item>
            <Item icon="🤫" onClick={() => setSubMenu("secret")}>
              Tell a secret...
            </Item>
            <Item icon="⚔️" onClick={() => fire(() => forceConfront(agentId, partnerId!))}>
              Force confrontation
            </Item>
            <Item
              icon="👁️"
              onClick={() => {
                onSelectAgent(agentId);
                onClose();
              }}
            >
              View relationship
            </Item>
            {eitherAsleep && (
              <p className="px-3 py-1 text-[10px] text-[var(--ui-text-secondary)]">
                💤 Chat suggestions wait until both are awake.
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  // ─── Single-agent mode ────────────────────────────────────────────────────────
  const asleep = isAsleep(currentAgent);
  return (
    <div ref={menuRef} className={frame} style={{ left, top }}>
      {header(
        <>
          {currentAgent && <MiniPortrait agent={currentAgent} size={16} />}
          <span className="truncate">{currentAgent?.name ?? "Agent"}</span>
          {asleep && <AsleepTag />}
        </>,
      )}

      {subMenu === "talk" && (
        <div className="max-h-56 overflow-y-auto">
          {back(() => setSubMenu(null))}
          {otherAgents.map((a: any) => {
            const blocked = asleep || isAsleep(a);
            return (
              <Item
                key={String(a.id)}
                icon={<MiniPortrait agent={a} size={16} dim={isAsleep(a)} />}
                disabled={blocked}
                title={blocked ? "Sleeping people can't be nudged to talk" : undefined}
                onClick={() => fire(() => suggestTalk(agentId, String(a.id)))}
              >
                <span className="truncate">{a.name}</span>
                {isAsleep(a) && <AsleepTag />}
              </Item>
            );
          })}
        </div>
      )}

      {subMenu === "pair" && (
        <div className="max-h-56 overflow-y-auto">
          {back(() => setSubMenu(null))}
          <p className="px-3 pb-1 text-[10px] text-[var(--ui-text-secondary)]">
            Secrets, confrontations, chats between two people.
          </p>
          {otherAgents.map((a: any) => (
            <Item
              key={String(a.id)}
              icon={<MiniPortrait agent={a} size={16} dim={isAsleep(a)} />}
              onClick={() => {
                setPairWith(String(a.id));
                setSubMenu(null);
              }}
            >
              <span className="truncate">{a.name}</span>
              {isAsleep(a) && <AsleepTag />}
            </Item>
          ))}
        </div>
      )}

      {subMenu === "goto" && (
        <div className="max-h-56 overflow-y-auto">
          {back(() => setSubMenu(null))}
          {locations.map((loc: any) => (
            <Item
              key={String(loc.id)}
              icon={locationIcon(loc.type)}
              disabled={asleep}
              onClick={() => fire(() => suggestGoTo(agentId, String(loc.id), loc.name))}
            >
              <span className="truncate">{loc.name}</span>
            </Item>
          ))}
        </div>
      )}

      {subMenu === "money" && (
        <div>
          {back(() => setSubMenu(null))}
          {[10, 25, 50, 100].map((amount) => (
            <Item key={amount} icon="🪙" onClick={() => fire(() => giveMoney(agentId, amount))}>
              {amount} coins
            </Item>
          ))}
        </div>
      )}

      {subMenu === null && !confirmRemove && (
        <>
          <Item
            icon="💬"
            disabled={asleep}
            title={asleep ? `${currentAgent?.name ?? "They"} is asleep` : undefined}
            onClick={() => setSubMenu("talk")}
          >
            Suggest talk to...
          </Item>
          <Item
            icon="🚶"
            disabled={asleep}
            title={asleep ? `${currentAgent?.name ?? "They"} is asleep` : undefined}
            onClick={() => setSubMenu("goto")}
          >
            Suggest go to...
          </Item>
          <Item icon="🪙" onClick={() => setSubMenu("money")}>
            Give money
          </Item>
          <Item icon="🤝" onClick={() => setSubMenu("pair")}>
            Pair with...
          </Item>
          <Item
            icon="👁️"
            onClick={() => {
              onSelectAgent(agentId);
              onClose();
            }}
          >
            View memories
          </Item>
          <div className="border-t border-[var(--ui-border)] my-1" />
          <Item icon="✕" danger onClick={() => setConfirmRemove(true)}>
            Remove from town
          </Item>
        </>
      )}

      {confirmRemove && (
        <div className="px-3 py-2">
          <p className="text-xs text-[var(--ui-text-primary)] mb-2">Remove {currentAgent?.name}?</p>
          <div className="flex gap-2">
            <button
              className="flex-1 px-2 py-1 text-xs border border-[var(--ui-negative)] bg-[var(--ui-negative)]/20 text-[var(--ui-negative)] hover:bg-[var(--ui-negative)]/30 transition-colors"
              onClick={() => fire(() => removeAgent(agentId))}
            >
              Confirm
            </button>
            <button className={`flex-1 px-2 py-1 text-xs ${W.btn}`} onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
