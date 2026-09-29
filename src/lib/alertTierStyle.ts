import type { AlertTier } from "../../server/lib/alertTiers";

/**
 * Per-tier look of alert toasts and inbox rows (palette tokens in globals.css).
 * The player's own outcome gets a gold bar on a warm tint and a ✦ — the mark
 * the feed already uses for "you" — so it reads apart from the town's drama at
 * a glance.
 */
export const TIER_STYLE: Record<AlertTier, { bar: string; mark: string; icon: string; bg: string; label: string }> = {
  player: { bar: "border-l-ui-alert-player", mark: "text-ui-alert-player", icon: "✦", bg: "bg-ui-alert-player-bg", label: "Your doing" },
  major: { bar: "border-l-ui-alert-major", mark: "text-ui-alert-major", icon: "!", bg: "bg-ui-panel", label: "Big moment" },
  minor: { bar: "border-l-ui-alert-minor", mark: "text-ui-alert-minor", icon: "•", bg: "bg-ui-panel", label: "Worth a look" },
};
