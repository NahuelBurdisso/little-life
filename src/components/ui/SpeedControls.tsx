import { useState } from "react";
import { useNudge } from "../../hooks/useNudge";

interface SpeedControlsProps {
  isPaused: boolean;
  currentSpeed: number;
}

const SPEEDS = [0.5, 1, 2, 4];

export function SpeedControls({ isPaused, currentSpeed }: SpeedControlsProps) {
  const { togglePause, changeSpeed } = useNudge();
  // Which control is waiting on the server. The highlight below follows `world`,
  // which only updates after the round trip and its refetch, so without this a
  // click showed nothing until then (and nothing at all if the request failed).
  const [pending, setPending] = useState<"pause" | number | null>(null);

  const run = async (key: "pause" | number, fn: () => Promise<unknown>) => {
    if (pending !== null) return;
    setPending(key);
    try {
      await fn();
    } finally {
      setPending(null);
    }
  };

  const base = "text-xs border transition-colors disabled:cursor-wait";
  const idle =
    "border-[var(--ui-border)] bg-[var(--ui-bg-raised)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-bg-hover)] hover:text-[var(--ui-text-primary)] hover:border-[var(--ui-border-accent)]";
  const active =
    "border-[var(--ui-accent-gold)] bg-[var(--ui-accent-gold)]/20 text-[var(--ui-accent-gold)]";

  return (
    <div className="flex items-center gap-1" aria-busy={pending !== null}>
      <button
        onClick={() => run("pause", () => togglePause())}
        disabled={pending !== null}
        aria-pressed={isPaused}
        className={`px-3 py-1 text-sm ${base} ${isPaused ? active : idle} ${pending === "pause" ? "animate-pulse" : ""}`}
        title={isPaused ? "Resume (Space)" : "Pause (Space)"}
      >
        {isPaused ? "▶" : "⏸"}
      </button>
      {SPEEDS.map((s, i) => (
        <button
          key={s}
          onClick={() => run(s, () => changeSpeed(s))}
          disabled={pending !== null}
          aria-pressed={!isPaused && currentSpeed === s}
          className={`px-2 py-1 ${base} ${
            !isPaused && currentSpeed === s ? active : idle
          } ${pending === s ? "animate-pulse" : ""}`}
          title={`${s}x speed (${i + 1})`}
        >
          {s}x
        </button>
      ))}
    </div>
  );
}
