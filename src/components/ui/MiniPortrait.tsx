import { useState } from "react";
import { getAgentColor } from "../../lib/spriteConfig";
import { portraitSrc } from "./portraitMood";

interface MiniPortraitProps {
  agent: { name: string; portrait_sprite?: string; portraitSprite?: string };
  size?: number;
  /** Greyed out (asleep / unavailable). */
  dim?: boolean;
}

/**
 * Small neutral-expression portrait for lists and pickers. AgentPortrait is the
 * full mood-reactive one for the panel header; this skips the crossfade machinery
 * and falls back to a coloured initial tile when the PNG is missing.
 */
export function MiniPortrait({ agent, size = 20, dim = false }: MiniPortraitProps) {
  const [failed, setFailed] = useState(false);
  const key = agent.portrait_sprite ?? agent.portraitSprite;
  const frame = {
    width: size,
    height: size,
    flexShrink: 0,
    border: "1px solid var(--ui-border)",
    backgroundColor: "var(--ui-bg-panel)",
    opacity: dim ? 0.4 : 1,
    filter: dim ? "grayscale(1)" : undefined,
  } as const;

  if (!key || failed) {
    const color = "#" + getAgentColor(agent.name).toString(16).padStart(6, "0");
    return (
      <span
        className="inline-flex items-center justify-center font-bold"
        style={{ ...frame, color, fontSize: Math.max(9, size * 0.5) }}
        aria-hidden
      >
        {agent.name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={portraitSrc(key, "neutral")}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
      style={{ ...frame, imageRendering: "pixelated", objectFit: "cover" }}
    />
  );
}
