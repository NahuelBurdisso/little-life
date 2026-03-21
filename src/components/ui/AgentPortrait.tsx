import { formatMood } from "../../lib/formatters";

interface AgentPortraitProps {
  agent: { name: string; age: number; portraitSprite: string };
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
  return (
    <div className="flex items-center gap-3">
      <img
        src={agent.portraitSprite}
        alt={agent.name}
        className="w-12 h-12 rounded-full bg-gray-700 object-cover"
      />
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
