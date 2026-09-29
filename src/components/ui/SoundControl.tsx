import { useEffect, useSyncExternalStore, type WheelEvent } from "react";
import { audio } from "../../lib/audio/engine";

/**
 * The speaker next to the speed buttons: click toggles mute, the mouse wheel over it (or the
 * slider that opens on hover/focus) sets the volume. Settings persist (engine.ts).
 *
 * Sound is on by default but the browser won't start it before the first click anywhere on
 * the page — the engine listens for that gesture itself, so this button needs no special
 * "enable sound" state: any first click (this one included) brings the town up.
 */
export function SoundControl() {
  const settings = useSyncExternalStore(audio.subscribe, audio.getSettings, audio.getSettings);
  useEffect(() => { audio.install(); }, []);

  const { muted, volume } = settings;
  const silent = muted || volume <= 0;
  const icon = silent ? "🔇" : volume < 0.34 ? "🔈" : volume < 0.67 ? "🔉" : "🔊";
  const pct = Math.round(volume * 100);

  // Wheel up = louder. Steps of 5%; React's wheel listener is passive, and the top bar has
  // nothing to scroll anyway, so there is no default to prevent.
  const onWheel = (e: WheelEvent) => {
    if (e.deltaY === 0) return;
    audio.setVolume(volume + (e.deltaY < 0 ? 0.05 : -0.05));
  };

  const base = "text-xs border transition-colors";
  const idle =
    "border-[var(--ui-border)] bg-[var(--ui-bg-raised)] text-[var(--ui-text-secondary)] hover:bg-[var(--ui-bg-hover)] hover:text-[var(--ui-text-primary)] hover:border-[var(--ui-border-accent)]";

  return (
    <div className="group relative flex items-center" onWheel={onWheel}>
      <button
        onClick={() => audio.toggleMute()}
        aria-pressed={silent}
        aria-label={silent ? "Unmute sound" : "Mute sound"}
        className={`px-2 py-1 ${base} ${idle}`}
        title={silent ? "Sound off — click to turn on (wheel: volume)" : `Sound ${pct}% — click to mute (wheel: volume)`}
      >
        {icon}
      </button>
      {/* Opens below the button on hover or keyboard focus, so the bar's layout never shifts. */}
      <div className="absolute left-1/2 top-full z-50 hidden -translate-x-1/2 pt-1 group-hover:block group-focus-within:block">
        <div className="flex items-center gap-2 border border-[var(--ui-border)] bg-[var(--ui-bg-raised)] px-2 py-1 shadow-lg">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={muted ? 0 : pct}
            onChange={(e) => audio.setVolume(Number(e.target.value) / 100)}
            aria-label="Volume"
            className="h-1 w-24 cursor-pointer accent-[var(--ui-accent-gold)]"
          />
          <span className="w-8 text-right text-[10px] tabular-nums text-[var(--ui-text-secondary)]">
            {muted ? "off" : `${pct}%`}
          </span>
        </div>
      </div>
    </div>
  );
}
