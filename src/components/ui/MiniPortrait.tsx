import { useState } from "react";
import { getAgentColor } from "../../lib/spriteConfig";
import { isPlaceholderSpriteKey } from "../../lib/residentArt/look";
import { generatedPortraitSrc } from "./generatedPortrait";
import { portraitSrc, type PortraitMood } from "./portraitMood";

interface MiniPortraitProps {
  /** `gender`/`age` pick a generated face's odds; pass the agent row so they match its sprite. */
  agent: { name: string; portrait_sprite?: string; portraitSprite?: string; gender?: string | null; age?: number | null };
  size?: number;
  /** Greyed out (asleep / unavailable). */
  dim?: boolean;
  /** Expression to wear (see `portraitMood`). Defaults to neutral. */
  mood?: PortraitMood;
}

/**
 * Small portrait for lists and pickers. AgentPortrait is the full mood-reactive
 * one for the panel header; this skips the crossfade machinery, wears a mood
 * only when the caller passes one, and falls back to the generated portrait when
 * the PNG is missing (a coloured initial tile only where no canvas exists).
 */
export function MiniPortrait({ agent, size = 20, dim = false, mood = "neutral" }: MiniPortraitProps) {
  // Sources that failed to load. Keyed by URL so one missing expression (the art
  // script skips portraits it can't read) only demotes that face to neutral.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
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

  const handDrawn = !isPlaceholderSpriteKey(key);
  const moodUrl = handDrawn ? portraitSrc(key!, mood) : null;
  const neutralUrl = handDrawn ? portraitSrc(key!, "neutral") : null;
  let src = moodUrl && !failed.has(moodUrl) ? moodUrl : neutralUrl;
  // No art for this key (nudged / custom residents): the generated face, in the same mood.
  if (!src || failed.has(src)) src = generatedPortraitSrc(agent, mood);

  if (!src || failed.has(src)) {
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
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed((prev) => new Set(prev).add(src))}
      style={{ ...frame, imageRendering: "pixelated", objectFit: "cover" }}
    />
  );
}
