import { useEffect, useRef, useState } from "react";
import { SPEED_FLASH_MS, playbackChange, speedArrows, speedText } from "./playbackLabel";

interface PlaybackOverlayProps {
  paused: boolean;
  speed: number;
}

interface Flash { key: number; arrows: 1 | 2 | 3; text: string }

/**
 * Pause / speed feedback drawn over the canvas: a PAUSED banner with a dimmed map while the
 * sim is stopped, and a short "▶▶ 2x" flash whenever the speed changes or play resumes. The
 * top bar's buttons change state but sit far from where the player is looking; this puts the
 * answer on the map itself. Never intercepts the pointer.
 *
 * Styled with the warm --ui-* tokens (fallbacks inline) and hard pixel shadows instead of blur.
 */
export function PlaybackOverlay({ paused, speed }: PlaybackOverlayProps) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const prev = useRef({ paused, speed });
  const counter = useRef(0);

  useEffect(() => {
    const before = prev.current;
    prev.current = { paused, speed };
    if (playbackChange(before, { paused, speed }) !== "flash") return;
    setFlash({ key: ++counter.current, arrows: speedArrows(speed), text: speedText(speed) });
    const timer = setTimeout(() => setFlash(null), SPEED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [paused, speed]);

  return (
    <div className="pbo-root" aria-hidden={!paused && !flash}>
      <style>{CSS}</style>
      <div className="pbo-dim" data-on={paused} />
      {paused && (
        <div className="pbo-banner pbo-paused" role="status">
          <svg className="pbo-icon pbo-bars" width="12" height="14" viewBox="0 0 12 14" shapeRendering="crispEdges" aria-hidden="true">
            <rect x="0" y="0" width="4" height="14" />
            <rect x="8" y="0" width="4" height="14" />
          </svg>
          <span>Paused</span>
        </div>
      )}
      {!paused && flash && (
        <div key={flash.key} className="pbo-banner pbo-speed" role="status">
          <svg className="pbo-icon" width={flash.arrows * 10 + 2} height="14" viewBox={`0 0 ${flash.arrows * 10 + 2} 14`} shapeRendering="crispEdges" aria-hidden="true">
            {Array.from({ length: flash.arrows }, (_, i) => (
              <polygon key={i} points={`${i * 10},0 ${i * 10 + 8},7 ${i * 10},14`} />
            ))}
          </svg>
          <span>{flash.text}</span>
        </div>
      )}
    </div>
  );
}

const CSS = `
.pbo-root { position: absolute; inset: 0; z-index: 15; pointer-events: none; overflow: hidden; }
.pbo-dim {
  position: absolute; inset: 0; opacity: 0; transition: opacity 0.25s ease-out;
  background: rgba(15, 14, 11, 0.26);
  box-shadow: inset 0 0 90px rgba(15, 14, 11, 0.55);
}
.pbo-dim[data-on="true"] { opacity: 1; }
.pbo-banner {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px;
  padding: 6px 16px 6px 14px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 14px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; line-height: 1;
  color: var(--ui-text-primary, #d4c9a8);
  background: var(--ui-bg-panel, #1a1814);
  border: 2px solid var(--ui-accent-gold, #c8a84b);
  box-shadow: 0 0 0 2px #1a1510, 4px 4px 0 2px rgba(0, 0, 0, 0.5);
  image-rendering: pixelated;
}
.pbo-banner .pbo-icon { fill: var(--ui-accent-gold, #c8a84b); flex: none; }
.pbo-paused .pbo-bars { animation: pbo-blink 1.4s steps(1, end) infinite; }
.pbo-speed { animation: pbo-flash ${SPEED_FLASH_MS}ms steps(8, end) both; }
@keyframes pbo-blink { 0%, 60% { opacity: 1; } 61%, 100% { opacity: 0.25; } }
@keyframes pbo-flash {
  0% { opacity: 0; transform: translate(-50%, -8px); }
  12% { opacity: 1; transform: translate(-50%, 0); }
  75% { opacity: 1; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .pbo-paused .pbo-bars, .pbo-speed { animation: none; }
  .pbo-dim { transition: none; }
}
`;
