import { useEffect, useRef, useState } from "react";
import { getAgentColor } from "../../lib/spriteConfig";
import { formatMood } from "../../lib/formatters";
import { portraitMood, portraitSrc } from "./portraitMood";

interface AgentPortraitProps {
  agent: {
    name: string;
    age: number;
    portraitSprite?: string;
    portrait_sprite?: string;
  };
  economy: { job_title: string } | null;
  mood?: number;
  /** Active states (`{ type }` rows from getAgentSummary); they steer the portrait's expression. */
  states?: ReadonlyArray<{ type: string }>;
  size?: number;
}

const FADE_MS = 250;

function moodEmoji(mood: number): string {
  if (mood > 80) return "\u{1F60A}";
  if (mood > 60) return "\u{1F642}";
  if (mood > 40) return "\u{1F610}";
  if (mood > 20) return "\u{1F641}";
  return "\u{1F62D}";
}

export function AgentPortrait({ agent, economy, mood, states, size = 48 }: AgentPortraitProps) {
  // Sources that failed to load. Keyed by URL rather than a boolean so one missing expression
  // (the art script skips portraits it can't read) only demotes that expression to neutral.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const color = getAgentColor(agent.name);
  const hexColor = "#" + color.toString(16).padStart(6, "0");
  const letter = agent.name.charAt(0).toUpperCase();

  const spriteKey = agent.portrait_sprite ?? agent.portraitSprite;
  const neutralSrc = spriteKey ? portraitSrc(spriteKey, "neutral") : null;
  const moodSrc = spriteKey ? portraitSrc(spriteKey, portraitMood(mood, states)) : null;
  const spriteSrc = moodSrc && !failed.has(moodSrc) ? moodSrc : neutralSrc;
  const showSprite = spriteSrc !== null && !failed.has(spriteSrc);

  const markFailed = (src: string) => setFailed((prev) => new Set(prev).add(src));

  // Crossfade: keep the previous image underneath while the new one fades in over it.
  const [shown, setShown] = useState(spriteSrc);
  const [under, setUnder] = useState<string | null>(null);
  const topRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (spriteSrc === shown) return;
    setUnder(shown);
    setShown(spriteSrc);
    topRef.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });
    const t = setTimeout(() => setUnder(null), FADE_MS);
    return () => clearTimeout(t);
  }, [spriteSrc, shown]);

  // `shown` lags `spriteSrc` by one render; never paint a source that already failed meanwhile.
  const topSrc = shown && !failed.has(shown) ? shown : (spriteSrc ?? "");

  const frameStyle = {
    width: size,
    height: size,
    imageRendering: "pixelated" as const,
    flexShrink: 0,
    border: "1px solid #3d3a2e",
    backgroundColor: "#1a1814",
  };
  const layerStyle = {
    position: "absolute" as const,
    inset: 0,
    width: "100%",
    height: "100%",
    imageRendering: "pixelated" as const,
  };

  return (
    <div className="flex items-center gap-3">
      {showSprite ? (
        <div style={{ ...frameStyle, position: "relative" }}>
          {under && !failed.has(under) && <img src={under} alt="" aria-hidden style={layerStyle} />}
          <img
            ref={topRef}
            src={topSrc}
            alt={agent.name}
            width={size}
            height={size}
            onError={() => markFailed(topSrc)}
            style={layerStyle}
          />
        </div>
      ) : (
        <div
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            backgroundColor: hexColor,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: size * 0.45,
            fontWeight: "bold",
            color: "white",
            fontFamily: "monospace",
            flexShrink: 0,
          }}
        >
          {letter}
        </div>
      )}
      <div>
        <div className="font-bold text-white">{agent.name}</div>
        <div className="text-sm text-gray-400">
          {economy?.job_title ?? "Unknown"}, age {agent.age}
        </div>
        {mood !== undefined && (
          <div className="text-xs text-gray-500">
            {formatMood(mood)} {moodEmoji(mood)}
          </div>
        )}
      </div>
    </div>
  );
}
