import { trpc } from "../../lib/trpc";

interface FloatingToolbarProps {
  onNewAgent: () => void;
  onShowRelationships: () => void;
  onShowHistory: () => void;
  /** The town's record by game day ("what happened yesterday?"). */
  onShowTimeline: () => void;
  onShowAutoplay: () => void;
  autoCut: boolean;
  onToggleAutoCut: () => void;
  /** First-run guide: the residents overview and the "?" help. */
  onMeetTheTown?: () => void;
  onShowHelp?: () => void;
  /** Folded into a one-icon-wide rail (App owns the state, see useToolbarCollapsed). */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function ToolButton({
  icon,
  label,
  title,
  onClick,
  active,
  pressed,
  rail,
}: {
  icon: string;
  label: string;
  title: string;
  onClick: () => void;
  /** Lit state: the feature is doing something right now. */
  active?: boolean;
  /** Only for toggles (aria-pressed). Plain openers leave it undefined. */
  pressed?: boolean;
  /** Icon-only presentation: the label moves to the tooltip and the accessible name. */
  rail?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={rail ? `${label} - ${title}` : title}
      aria-label={rail ? label : undefined}
      aria-pressed={pressed}
      className={`group relative flex items-center text-xs text-left w-full transition-colors border-l-2 ${
        rail ? "justify-center px-0 py-1.5" : "gap-2 pl-2 pr-3 py-1.5"
      } ${
        active
          ? "bg-ui-gold/10 border-ui-gold text-ui-gold hover:bg-ui-gold/20"
          : "border-transparent text-ui-text hover:bg-ui-hover hover:border-ui-line-accent"
      }`}
    >
      <span aria-hidden="true" className={`${rail ? "" : "w-4"} text-center text-sm leading-none`}>
        {icon}
      </span>
      {!rail && <span className="flex-1">{label}</span>}
      {!rail && pressed !== undefined && (
        <span className={`text-[9px] uppercase tracking-wide ${active ? "text-ui-gold" : "text-ui-muted"}`}>
          {active ? "on" : "off"}
        </span>
      )}
    </button>
  );
}

/**
 * The player's secondary tools as one warm-palette strip instead of four
 * unrelated grey buttons. Toggles (Director, Autoplay) light up in gold and
 * say on/off in words, so state never hangs on colour alone (in the rail the
 * gold bar and aria-pressed carry it).
 *
 * Renders inside the map box (absolute, bottom-right) so it follows the panels
 * instead of floating over them, and folds into an icon rail: expanded it is
 * w-44 and hid ~20% of the map at 1280 wide.
 */
export function FloatingToolbar({
  onNewAgent,
  onShowRelationships,
  onShowHistory,
  onShowTimeline,
  onShowAutoplay,
  autoCut,
  onToggleAutoCut,
  onMeetTheTown,
  onShowHelp,
  collapsed,
  onToggleCollapsed,
}: FloatingToolbarProps) {
  // Same query key as the panel: a toggle there invalidates it, so this stays
  // current without polling while the panel is closed.
  const { data: autoplay } = trpc.autoplay.getConfig.useQuery();
  const autoplayOn = autoplay?.ENABLED ?? false;
  const rail = collapsed;

  return (
    <div
      className={`absolute bottom-3 right-3 z-30 bg-ui-panel/95 border border-ui-line shadow-lg divide-y divide-ui-line/60 max-h-[calc(100%-1.5rem)] overflow-y-auto ${
        rail ? "w-9" : "w-44"
      }`}
      role="toolbar"
      aria-label="Town tools"
      aria-orientation="vertical"
    >
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!rail}
        aria-label={rail ? "Expand town tools" : "Collapse town tools"}
        title={rail ? "Expand the tools" : "Fold the tools into an icon rail"}
        className={`flex items-center w-full py-1 text-[10px] uppercase tracking-wider text-ui-muted hover:text-ui-text hover:bg-ui-hover transition-colors ${
          rail ? "justify-center px-0" : "justify-between pl-3 pr-2"
        }`}
      >
        {!rail && <span>Tools</span>}
        <span aria-hidden="true" className="text-xs leading-none">{rail ? "«" : "»"}</span>
      </button>
      <ToolButton rail={rail} icon="➕" label="New Resident" title="Add a new resident to the town" onClick={onNewAgent} />
      <ToolButton rail={rail} icon="🔗" label="Relationships" title="Who likes, loves and loathes whom" onClick={onShowRelationships} />
      <ToolButton rail={rail} icon="📜" label="History" title="Every conversation, searchable" onClick={onShowHistory} />
      <ToolButton rail={rail} icon="🕰" label="Timeline" title="The town's big moments, day by day" onClick={onShowTimeline} />
      <ToolButton
        rail={rail}
        icon="🎞"
        label="Autoplay"
        title="Let the game watch for boredom and nudge the town for you"
        onClick={onShowAutoplay}
        active={autoplayOn}
        pressed={autoplayOn}
      />
      <ToolButton
        rail={rail}
        icon="🎬"
        label="Director"
        title="Let the camera pick the best scene and caption it (C toggles captions; moving the map pauses it)"
        onClick={onToggleAutoCut}
        active={autoCut}
        pressed={autoCut}
      />
      {onMeetTheTown && (
        <ToolButton rail={rail} icon="🏘️" label="Meet the Town" title="Who lives here: ties, rivals, secrets, stories" onClick={onMeetTheTown} />
      )}
      {onShowHelp && (
        <ToolButton rail={rail} icon="❓" label="Help (?)" title="How to play and every hotkey" onClick={onShowHelp} />
      )}
    </div>
  );
}
