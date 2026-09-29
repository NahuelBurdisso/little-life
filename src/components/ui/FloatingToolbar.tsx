import { trpc } from "../../lib/trpc";

interface FloatingToolbarProps {
  onNewAgent: () => void;
  onShowRelationships: () => void;
  onShowHistory: () => void;
  onShowAutoplay: () => void;
  autoCut: boolean;
  onToggleAutoCut: () => void;
  /** Distance from the right edge in px: clears the agent panel while one is open. */
  rightOffset?: number;
}

function ToolButton({
  icon,
  label,
  title,
  onClick,
  active,
  pressed,
}: {
  icon: string;
  label: string;
  title: string;
  onClick: () => void;
  /** Lit state: the feature is doing something right now. */
  active?: boolean;
  /** Only for toggles (aria-pressed). Plain openers leave it undefined. */
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={pressed}
      className={`group flex items-center gap-2 pl-2 pr-3 py-1.5 text-xs text-left w-full transition-colors border-l-2 ${
        active
          ? "bg-ui-gold/10 border-ui-gold text-ui-gold hover:bg-ui-gold/20"
          : "border-transparent text-ui-text hover:bg-ui-hover hover:border-ui-line-accent"
      }`}
    >
      <span aria-hidden="true" className="w-4 text-center text-sm leading-none">
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {pressed !== undefined && (
        <span className={`text-[9px] uppercase tracking-wide ${active ? "text-ui-gold" : "text-ui-muted"}`}>
          {active ? "on" : "off"}
        </span>
      )}
    </button>
  );
}

/**
 * The player's secondary tools as one warm-palette strip instead of four
 * unrelated grey buttons. Toggles (Auto-Cut, Autoplay) light up in gold and
 * say on/off in words, so state never hangs on colour alone.
 */
export function FloatingToolbar({
  onNewAgent,
  onShowRelationships,
  onShowHistory,
  onShowAutoplay,
  autoCut,
  onToggleAutoCut,
  rightOffset = 16,
}: FloatingToolbarProps) {
  // Same query key as the panel: a toggle there invalidates it, so this stays
  // current without polling while the panel is closed.
  const { data: autoplay } = trpc.autoplay.getConfig.useQuery();
  const autoplayOn = autoplay?.ENABLED ?? false;

  return (
    <div
      className="fixed bottom-16 z-30 w-44 bg-ui-panel/95 border border-ui-line shadow-lg divide-y divide-ui-line/60"
      style={{ right: rightOffset }}
      role="toolbar"
      aria-label="Town tools"
    >
      <ToolButton icon="➕" label="New Resident" title="Add a new resident to the town" onClick={onNewAgent} />
      <ToolButton icon="🔗" label="Relationships" title="Who likes, loves and loathes whom" onClick={onShowRelationships} />
      <ToolButton icon="📜" label="History" title="Every conversation, searchable" onClick={onShowHistory} />
      <ToolButton
        icon="🎞"
        label="Autoplay"
        title="Let the game watch for boredom and nudge the town for you"
        onClick={onShowAutoplay}
        active={autoplayOn}
        pressed={autoplayOn}
      />
      <ToolButton
        icon="🎬"
        label="Auto-Cut"
        title="Jump the camera to whoever the next dramatic event is about"
        onClick={onToggleAutoCut}
        active={autoCut}
        pressed={autoCut}
      />
    </div>
  );
}
