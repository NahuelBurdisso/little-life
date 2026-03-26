import { getAgentColor } from "../../lib/spriteConfig";
import { formatMood } from "../../lib/formatters";

interface AgentPortraitProps {
  agent: { name: string; age: number; portraitSprite?: string };
  economy: { job_title: string } | null;
  mood?: number;
  size?: number;
}

function moodEmoji(mood: number): string {
  if (mood > 80) return "\u{1F60A}";
  if (mood > 60) return "\u{1F642}";
  if (mood > 40) return "\u{1F610}";
  if (mood > 20) return "\u{1F641}";
  return "\u{1F62D}";
}

export function AgentPortrait({ agent, economy, mood, size = 48 }: AgentPortraitProps) {
  const color = getAgentColor(agent.name);
  const hexColor = "#" + color.toString(16).padStart(6, "0");
  const letter = agent.name.charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-3">
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
