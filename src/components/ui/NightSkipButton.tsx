import { useState } from "react";
import { useNightSkip } from "../../hooks/useNightSkip";
import { useNudge } from "../../hooks/useNudge";

/**
 * "Skip to morning" next to the speed buttons. Appears only when the night can
 * be skipped (everyone asleep, or between 23:00 and 05:00 — the rules are the
 * server's, lib/nightSkip.ts) and turns into a stop button while it runs. The
 * canvas dims and says "Skipping night…" meanwhile (PlaybackOverlay).
 */
export function NightSkipButton() {
  const { active, canSkip } = useNightSkip();
  const { skipNight, cancelNightSkip } = useNudge();
  // Between the click and the server's answer nothing else shows the press.
  const [pending, setPending] = useState(false);

  if (!active && !canSkip) return null;

  const run = async (fn: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    try {
      await fn();
    } finally {
      setPending(false);
    }
  };

  const base = "px-2 py-1 text-xs border transition-colors disabled:cursor-wait";
  return active ? (
    <button
      onClick={() => run(cancelNightSkip)}
      disabled={pending}
      className={`${base} border-[var(--ui-accent-blue)] bg-[var(--ui-accent-blue)]/20 text-[var(--ui-text-primary)] hover:bg-[var(--ui-accent-blue)]/30 animate-pulse`}
      title="Stop skipping and go back to your speed"
    >
      🌙 Skipping… ✕
    </button>
  ) : (
    <button
      onClick={() => run(skipNight)}
      disabled={pending}
      className={`${base} border-[var(--ui-border)] bg-[var(--ui-bg-raised)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-bg-hover)] hover:text-[var(--ui-text-primary)] hover:border-[var(--ui-border-accent)] ${pending ? "animate-pulse" : ""}`}
      title="Fast-forward to 06:00. Stops early if something important happens."
    >
      ⏩ Skip to morning
    </button>
  );
}
