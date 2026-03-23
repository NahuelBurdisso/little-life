import { formatMood } from "../../lib/formatters";
import { getCharacterSheet } from "../../lib/spriteConfig";

interface AgentPortraitProps {
  agent: { name: string; age: number; portraitSprite?: string };
  economy: { jobTitle: string } | null;
  mood: number | undefined;
}

function moodEmoji(mood: number): string {
  if (mood > 80) return "\u{1F60A}";
  if (mood > 60) return "\u{1F642}";
  if (mood > 40) return "\u{1F610}";
  if (mood > 20) return "\u{1F641}";
  return "\u{1F62D}";
}

export function AgentPortrait({ agent, economy, mood }: AgentPortraitProps) {
  // Deterministic character base from agent name
  const nameHash = agent.name.split("").reduce((h, c) => c.charCodeAt(0) + ((h << 5) - h), 0);
  const idx = Math.abs(nameHash) % 4;
  const base = ["adam", "alex", "amelia", "bob"][idx];
  const idleSrc = getCharacterSheet(base, "idle");

  return (
    <div className="flex items-center gap-3">
      <div className="w-12 h-16 rounded bg-gray-700 overflow-hidden" style={{ imageRendering: "pixelated" }}>
        <img
          src={idleSrc}
          alt={agent.name}
          className="w-[128px] h-[64px]"
          style={{ objectFit: "none", objectPosition: "0 0" }}
        />
      </div>
      <div>
        <div className="font-bold text-white">{agent.name}</div>
        <div className="text-sm text-gray-400">
          {economy?.jobTitle ?? "Unknown"}, age {agent.age}
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
