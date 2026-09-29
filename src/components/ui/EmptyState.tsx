interface EmptyStateProps {
  /** A single emoji/glyph. Decorative — the line below carries the meaning. */
  icon: string;
  /** Friendly one-liner: what is missing. */
  title: string;
  /** What will eventually fill this space, so an empty panel reads as "not yet" instead of "broken". */
  hint?: string;
  /** Tighter padding for use inside a section that already has its own header. */
  compact?: boolean;
  className?: string;
}

/**
 * The one empty state for every list/panel. Replaces the italic grey
 * "No X yet." lines that made a fresh town look unfinished.
 */
export function EmptyState({ icon, title, hint, compact = false, className = "" }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center text-center ${compact ? "gap-0.5 py-2" : "gap-1 py-5"} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`opacity-50 grayscale-[30%] ${compact ? "text-base" : "text-2xl"}`}
      >
        {icon}
      </span>
      <p className="text-xs text-ui-dim">{title}</p>
      {hint && <p className="text-[10px] text-ui-muted leading-snug max-w-[220px]">{hint}</p>}
    </div>
  );
}
