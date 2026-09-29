import { useHealthBanner } from "../../hooks/useHealth";
import type { BannerSeverity } from "../../lib/healthBanner";

/** Border / glyph / background per severity, from the `--ui-alert-*` tokens in globals.css. */
const TONE: Record<BannerSeverity, { glyph: string; border: string; bg: string; role: "alert" | "status" }> = {
  critical: { glyph: "!", border: "var(--ui-alert-bad-border)", bg: "var(--ui-alert-bad-bg)", role: "alert" },
  warning: { glyph: "~", border: "var(--ui-alert-warn-border)", bg: "var(--ui-alert-warn-bg)", role: "status" },
  notice: { glyph: "i", border: "var(--ui-alert-note-border)", bg: "var(--ui-alert-note-bg)", role: "status" },
};

/**
 * One slim line under the top bar saying what is wrong with the machinery behind
 * the town: socket down, LLM offline or slow, memory search off, ticks lagging.
 * Renders nothing when all is well. The critical ones (connection, LLM offline)
 * cannot be dismissed; the rest can, until the condition clears and returns.
 */
export function HealthBanner() {
  const { banner, dismiss } = useHealthBanner();
  if (!banner) return null;
  const tone = TONE[banner.severity];

  return (
    <div
      role={tone.role}
      title={banner.detail}
      className="flex items-center gap-2 px-3 py-1 text-xs flex-shrink-0"
      style={{
        background: tone.bg,
        color: "var(--ui-text-primary)",
        borderBottom: `1px solid ${tone.border}`,
        borderLeft: `3px solid ${tone.border}`,
      }}
    >
      <span
        aria-hidden="true"
        className={banner.pulse ? "ui-dot" : undefined}
        style={{ color: tone.border, fontWeight: 700, width: "1ch", textAlign: "center" }}
      >
        {tone.glyph}
      </span>
      <span className="flex-1 min-w-0 truncate">{banner.text}</span>
      {banner.dismissible && (
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="px-1.5 leading-none text-ui-dim hover:text-ui-text transition-colors"
        >
          ×
        </button>
      )}
    </div>
  );
}
