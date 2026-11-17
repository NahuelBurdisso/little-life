import { useState, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useNudge, FEELING_ICONS, type StirFeeling } from "../../hooks/useNudge";
import { trpc } from "../../lib/trpc";
import { displayPlaceName, locationIcon } from "../../lib/locationInfo";
import { MiniPortrait } from "../ui/MiniPortrait";
import { W } from "../ui/warmClasses";
import type { AgentView, LocationView } from '../../lib/apiTypes';

interface NudgeMenuProps {
  agentId: string;
  selectedAgentId: string | null;
  position: { x: number; y: number };
  agents: AgentView[];
  locations: LocationView[];
  onClose: () => void;
  onSelectAgent: (id: string) => void;
  /** Opens the pair dossier for the two residents. Without it "View relationship" just selects. */
  onViewPair?: (a: string, b: string) => void;
}

type SubMenu =
  | "talk" | "goto" | "money" | "pair" | "topic" | "secret"
  // God powers that plant something: a thought, a rumor, a feeling, a letter.
  | "whisper" | "rumor" | "rumorText" | "feeling" | "feelingTarget" | "letter"
  | null;

/** Same caps as server/lib/godPowers.ts (WHISPER_MAX, RUMOR_MAX). */
const WHISPER_MAX = 140;
const RUMOR_MAX = 120;

const FEELINGS: Array<{ state: StirFeeling; label: string; hint: string; needsTarget: boolean }> = [
  { state: "infatuated", label: "Infatuated with...", hint: "They can't stop thinking about someone", needsTarget: true },
  { state: "jealous", label: "Jealous of...", hint: "Someone is getting too close to the one they love", needsTarget: true },
  { state: "confident", label: "Confident", hint: "On top of the world — until someone pricks their vanity", needsTarget: false },
  { state: "stressed", label: "Stressed", hint: "Everything piles up at once", needsTarget: false },
];

/** A one-line text box with a counter and a send button; Enter sends. */
function TextPrompt({
  placeholder,
  max,
  value,
  onChange,
  onSend,
  hint,
}: {
  placeholder: string;
  max: number;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  hint?: ReactNode;
}) {
  const ok = value.trim().length > 0;
  return (
    <div className="px-3 py-1.5">
      {hint && <p className="pb-1 text-[10px] text-[var(--ui-text-secondary)]">{hint}</p>}
      <input
        autoFocus
        type="text"
        placeholder={placeholder}
        maxLength={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ok) onSend();
        }}
        className={W.input}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-[10px] text-[var(--ui-text-disabled)] tabular-nums">
          {value.length}/{max}
        </span>
        <button
          disabled={!ok}
          onClick={onSend}
          className={`ml-auto px-3 py-1 text-xs ${W.btnPrimary}`}
        >
          Plant it
        </button>
      </div>
    </div>
  );
}

/** The sim refuses talk/go-to nudges for sleepers (server/routers/nudge.ts), so grey them out up front. */
function isAsleep(agent: AgentView | null | undefined): boolean {
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
      role="menuitem"
      className={`w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs transition-colors outline-none focus-visible:bg-[var(--ui-bg-hover)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--ui-accent-gold)] ${
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
  onViewPair,
}: NudgeMenuProps) {
  const {
    suggestTalk, suggestGoTo, giveMoney, removeAgent, tellSecret, forceConfront,
    whisperThought, startRumor, stirFeeling, sendLetter,
  } = useNudge();
  const [subMenu, setSubMenu] = useState<SubMenu>(null);
  const [topicText, setTopicText] = useState("");
  const [whisperText, setWhisperText] = useState("");
  /** Who the rumor is about; the right-clicked agent is the one who hears it first. */
  const [rumorSubject, setRumorSubject] = useState<string | null>(null);
  const [rumorText, setRumorText] = useState("");
  /** Optional second person the rumor involves (stored as the fact's target). */
  const [rumorTarget, setRumorTarget] = useState<string>("");
  const [feeling, setFeeling] = useState<StirFeeling | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** Partner picked from the "Pair with..." entry; wins over the canvas selection. */
  const [pairWith, setPairWith] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu closes on every action (useNudge toasts the outcome), so the only way
  // to double-submit is two events landing before React unmounts it (Enter + click).
  const firedRef = useRef(false);

  const currentAgent = agents.find((a) => String(a.id) === agentId);
  const otherAgents = agents.filter((a) => String(a.id) !== agentId);
  const partnerId =
    pairWith ?? (selectedAgentId !== null && selectedAgentId !== agentId ? selectedAgentId : null);
  const partner = partnerId ? agents.find((a) => String(a.id) === partnerId) : null;
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
    setWhisperText("");
    setRumorSubject(null);
    setRumorText("");
    setRumorTarget("");
    setFeeling(null);
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

  // Escape peels one layer: text box / list -> its parent list -> the menu root,
  // remove confirmation -> root, "pick someone else" -> root; only from the root
  // does it close the menu. Capture phase + stopPropagation for the same reason
  // as TopBar's confirm dialog: App owns a document-level Escape chain that closes
  // the whole context menu, so a bubble listener here could never get in first and
  // Esc used to throw away a half-typed whisper along with the submenu.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const parent: SubMenu = isPairMode ? null
        : subMenu === "rumorText" ? "rumor"
        : subMenu === "feelingTarget" ? "feeling"
        : null;
      if (subMenu) {
        e.stopPropagation();
        setSubMenu(parent);
      } else if (confirmRemove) {
        e.stopPropagation();
        setConfirmRemove(false);
      } else if (pairWith) {
        e.stopPropagation();
        setPairWith(null);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose, subMenu, confirmRemove, pairWith, isPairMode]);

  // Keyboard reach: whichever view is showing, put focus on its first item (a view
  // with a text box already grabbed it through autoFocus), so arrows / Enter work
  // without a mouse. Runs after paint of the new view, hence the layout key list.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu || menu.contains(document.activeElement)) return;
    menu.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [agentId, position.x, position.y, subMenu, confirmRemove, pairWith, isPairMode]);

  // Arrow keys / Home / End walk the enabled items of the current view (disabled
  // buttons aren't focusable anyway); only when a menu item has focus, so the
  // arrows still move the caret inside the whisper / topic text boxes.
  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute("role") !== "menuitem") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
    const i = items.indexOf(target);
    if (i < 0) return;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next == null) return;
    e.preventDefault();
    items[next].focus();
    items[next].scrollIntoView({ block: "nearest" });
  };

  // Only the secret picker needs this, and it is a full-table scan server-side.
  const { data: knownFacts } = trpc.knowledge.getKnownBy.useQuery(
    { agentId: Number(agentId) },
    { enabled: subMenu === "secret" },
  );

  // The letter picker: what the server would let a letter carry to this resident, best stakes first
  // (knowledge.getLetterable). Only while the picker shows, and never cached: what a resident
  // already knows changes by the minute, and a stale row is a refused letter.
  const { data: letterFacts, isLoading: letterLoading } = trpc.knowledge.getLetterable.useQuery(
    { recipientId: Number(agentId) },
    { enabled: subMenu === "letter", gcTime: 0 },
  );

  // A secret the listener already knows is not a reveal, so drop those.
  const tellableSecrets = (knownFacts ?? [])
    .filter(
      (f) => f.sensitivity >= 2 && !(f.known_by as number[]).includes(Number(partnerId)),
    )
    .sort((a, b) => b.sensitivity - a.sensitivity)
    .slice(0, 8);

  // Clamp position to viewport
  const left = Math.max(4, Math.min(position.x, window.innerWidth - 250));
  // The single-agent menu is ~11 rows now that the planting powers are in it.
  const top = Math.max(4, Math.min(position.y, window.innerHeight - 420));

  const menuLabel = isPairMode
    ? `Nudge ${currentAgent?.name ?? "resident"} and ${partner?.name ?? "another resident"}`
    : `Nudge ${currentAgent?.name ?? "resident"}`;
  const frame = `fixed z-50 ${W.modal} min-w-[220px] max-w-[280px] max-h-[70vh] py-1`;
  const back = (onBack: () => void, label = "← Back") => (
    <button
      type="button"
      role="menuitem"
      className="w-full text-left px-3 py-1 text-[10px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] outline-none focus-visible:text-[var(--ui-accent-gold)]"
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

  const firstOf = (a: { name?: string } | null | undefined) => (a?.name ? String(a.name).split(" ")[0] : "them");
  const rumorAbout = rumorSubject ? agents.find((a) => String(a.id) === rumorSubject) : null;

  /** Detail box for a rumor about `rumorSubject`, heard first by the right-clicked agent. */
  const rumorTextMenu = (onBack: () => void) => (
    <>
      {back(onBack)}
      <TextPrompt
        placeholder={`${firstOf(rumorAbout)} is secretly...`}
        max={RUMOR_MAX}
        value={rumorText}
        onChange={setRumorText}
        hint={
          <>
            What {firstOf(currentAgent)} "heard" about {firstOf(rumorAbout)}. It spreads if{" "}
            {firstOf(currentAgent)} is the gossiping kind.
          </>
        }
        onSend={() =>
          fire(() => startRumor(agentId, rumorSubject!, rumorText.trim(), rumorTarget || undefined))
        }
      />
      <label className="px-3 pb-1.5 flex items-center gap-2 text-[10px] text-[var(--ui-text-secondary)]">
        Involving
        <select
          value={rumorTarget}
          onChange={(e) => setRumorTarget(e.target.value)}
          className="flex-1 min-w-0 bg-[var(--ui-bg-deep)] border border-[var(--ui-border)] px-1 py-0.5 text-[11px] text-[var(--ui-text-primary)]"
        >
          <option value="">nobody else</option>
          {agents
            .filter((a) => String(a.id) !== rumorSubject && String(a.id) !== agentId)
            .map((a) => (
              <option key={String(a.id)} value={String(a.id)}>
                {a.name}
              </option>
            ))}
        </select>
      </label>
    </>
  );

  // ─── Pair mode: two agents, secrets / confrontation / chat ───────────────────
  if (isPairMode) {
    return (
      <div ref={menuRef} className={frame} style={{ left, top }} role="menu" aria-label={menuLabel} onKeyDown={onMenuKeyDown}>
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
        ) : subMenu === "rumorText" ? (
          rumorTextMenu(() => setSubMenu(null))
        ) : subMenu === "secret" ? (
          <div className="max-h-56 overflow-y-auto">
            {back(() => setSubMenu(null))}
            {tellableSecrets.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-[var(--ui-text-secondary)]">
                {currentAgent?.name ?? "They"} knows no secrets the other doesn't.
              </p>
            ) : (
              tellableSecrets.map((f) => (
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
              icon={FEELING_ICONS.infatuated}
              title={`${firstOf(currentAgent)} can't stop thinking about ${firstOf(partner)}`}
              onClick={() => fire(() => stirFeeling(agentId, "infatuated", partnerId!))}
            >
              Make {firstOf(currentAgent)} fall for {firstOf(partner)}
            </Item>
            <Item
              icon={FEELING_ICONS.jealous}
              title={`${firstOf(currentAgent)} sees ${firstOf(partner)} as a rival`}
              onClick={() => fire(() => stirFeeling(agentId, "jealous", partnerId!))}
            >
              Make {firstOf(currentAgent)} jealous of {firstOf(partner)}
            </Item>
            <Item
              icon="🗣"
              title={`${firstOf(currentAgent)} hears a rumor about ${firstOf(partner)}`}
              onClick={() => {
                setRumorSubject(partnerId);
                setSubMenu("rumorText");
              }}
            >
              Rumor about {firstOf(partner)}...
            </Item>
            <Item
              icon="👁️"
              onClick={() => {
                // The dossier is the relationship view; selecting the resident
                // was all this entry could do before there was a per-pair page.
                if (onViewPair && partnerId) onViewPair(agentId, partnerId);
                else onSelectAgent(agentId);
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
    <div ref={menuRef} className={frame} style={{ left, top }} role="menu" aria-label={menuLabel} onKeyDown={onMenuKeyDown}>
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
          {otherAgents.map((a) => {
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
          {otherAgents.map((a) => (
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
          {locations.map((loc) => (
            <Item
              key={String(loc.id)}
              icon={locationIcon(loc.type)}
              disabled={asleep}
              onClick={() => fire(() => suggestGoTo(agentId, String(loc.id), loc.name))}
            >
              <span className="truncate">{displayPlaceName(loc.name, { sentenceStart: true })}</span>
            </Item>
          ))}
        </div>
      )}

      {subMenu === "whisper" && (
        <>
          {back(() => setSubMenu(null))}
          <TextPrompt
            placeholder="Maybe I should..."
            max={WHISPER_MAX}
            value={whisperText}
            onChange={setWhisperText}
            hint={<>A thought that comes to {firstOf(currentAgent)} out of nowhere. It colors their plans and talk.</>}
            onSend={() => fire(() => whisperThought(agentId, whisperText.trim()))}
          />
        </>
      )}

      {subMenu === "rumor" && (
        <div className="max-h-56 overflow-y-auto">
          {back(() => setSubMenu(null))}
          <p className="px-3 pb-1 text-[10px] text-[var(--ui-text-secondary)]">
            {firstOf(currentAgent)} hears a rumor about...
          </p>
          {otherAgents.map((a) => (
            <Item
              key={String(a.id)}
              icon={<MiniPortrait agent={a} size={16} />}
              onClick={() => {
                setRumorSubject(String(a.id));
                setSubMenu("rumorText");
              }}
            >
              <span className="truncate">{a.name}</span>
            </Item>
          ))}
        </div>
      )}

      {subMenu === "rumorText" && rumorTextMenu(() => setSubMenu("rumor"))}

      {subMenu === "letter" && (
        <div className="max-h-56 overflow-y-auto">
          {back(() => setSubMenu(null))}
          <p className="px-3 pb-1 text-[10px] text-[var(--ui-text-secondary)]">
            {firstOf(currentAgent)} learns it from an unsigned letter. Nobody is blamed.
          </p>
          {letterLoading ? (
            <p className="px-3 py-2 text-[11px] text-[var(--ui-text-secondary)]">Looking through the town's secrets...</p>
          ) : (letterFacts ?? []).length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-[var(--ui-text-secondary)]">
              They already know everything worth writing about.
            </p>
          ) : (
            (letterFacts ?? []).map((f) => (
              <Item
                key={f.factId}
                icon="✉"
                title={f.content}
                onClick={() => fire(() => sendLetter(agentId, f.factId))}
              >
                <span className="truncate">{f.content}</span>
              </Item>
            ))
          )}
        </div>
      )}

      {subMenu === "feeling" && (
        <div>
          {back(() => setSubMenu(null))}
          {FEELINGS.map((f) => (
            <Item
              key={f.state}
              icon={FEELING_ICONS[f.state]}
              title={f.hint}
              onClick={() => {
                if (f.needsTarget) {
                  setFeeling(f.state);
                  setSubMenu("feelingTarget");
                } else {
                  fire(() => stirFeeling(agentId, f.state));
                }
              }}
            >
              {f.label}
            </Item>
          ))}
        </div>
      )}

      {subMenu === "feelingTarget" && feeling && (
        <div className="max-h-56 overflow-y-auto">
          {back(() => setSubMenu("feeling"))}
          <p className="px-3 pb-1 text-[10px] text-[var(--ui-text-secondary)]">
            {feeling === "infatuated"
              ? `Who does ${firstOf(currentAgent)} fall for?`
              : `Who is ${firstOf(currentAgent)} jealous of?`}
          </p>
          {otherAgents.map((a) => (
            <Item
              key={String(a.id)}
              icon={<MiniPortrait agent={a} size={16} />}
              onClick={() => fire(() => stirFeeling(agentId, feeling, String(a.id)))}
            >
              <span className="truncate">{a.name}</span>
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
          <div role="separator" className="border-t border-[var(--ui-border)] my-1" />
          <Item icon="💭" title="Plant a thought in their head" onClick={() => setSubMenu("whisper")}>
            Whisper a thought...
          </Item>
          <Item icon="🗣" title="They hear a made-up story about someone" onClick={() => setSubMenu("rumor")}>
            Start a rumor...
          </Item>
          <Item icon="✉" title="A real secret, put in their hands with no name on it" onClick={() => setSubMenu("letter")}>
            Send an anonymous letter...
          </Item>
          <Item icon="💗" title="Stir a feeling in their heart" onClick={() => setSubMenu("feeling")}>
            Stir a feeling...
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
          <div role="separator" className="border-t border-[var(--ui-border)] my-1" />
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
              role="menuitem"
              className="flex-1 px-2 py-1 text-xs border border-[var(--ui-negative)] bg-[var(--ui-negative)]/20 text-[var(--ui-negative)] hover:bg-[var(--ui-negative)]/30 transition-colors"
              onClick={() => fire(() => removeAgent(agentId))}
            >
              Confirm
            </button>
            <button role="menuitem" className={`flex-1 px-2 py-1 text-xs ${W.btn}`} onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
