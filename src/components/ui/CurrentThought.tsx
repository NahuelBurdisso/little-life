import { describeAction } from "../../lib/actionText";

interface CurrentThoughtProps {
  agent: {
    name: string;
    current_action: Record<string, any>;
    traits: string[];
  };
  needs: {
    hunger: number;
    energy: number;
    social: number;
    comfort: number;
    fun: number;
    mood: number;
    stress: number;
  } | null;
  states: {
    id: number;
    type: string;
    severity: number;
    source: string;
    metadata: Record<string, any> | null;
  }[];
}

function getMoodEmoji(mood: number): string {
  if (mood > 85) return "😄";
  if (mood > 70) return "🙂";
  if (mood > 55) return "😐";
  if (mood > 40) return "😕";
  if (mood > 25) return "😟";
  return "😢";
}

function getMoodLabel(mood: number): string {
  if (mood > 85) return "Elated";
  if (mood > 70) return "Happy";
  if (mood > 55) return "Okay";
  if (mood > 40) return "Blah";
  if (mood > 25) return "Down";
  return "Miserable";
}

function getMoodColor(mood: number): string {
  if (mood > 70) return "text-green-400";
  if (mood > 55) return "text-yellow-300";
  if (mood > 40) return "text-orange-400";
  return "text-red-400";
}

function assembleThought(
  agent: CurrentThoughtProps["agent"],
  needs: CurrentThoughtProps["needs"],
  states: CurrentThoughtProps["states"]
): string {
  if (!needs) return `${agent.name} is just existing right now.`;

  const { hunger, energy, social, mood, stress } = needs;

  // Find the most pressing need
  const pressures: { label: string; value: number; thought: string }[] = [
    {
      label: "hunger",
      value: 100 - hunger,
      thought: `${agent.name} is really craving something to eat.`,
    },
    {
      label: "energy",
      value: 100 - energy,
      thought: `${agent.name} feels exhausted and needs rest.`,
    },
    {
      label: "social",
      value: 100 - social,
      thought: `${agent.name} is feeling lonely and wants company.`,
    },
  ];

  const topPressure = pressures.sort((a, b) => b.value - a.value)[0];

  // Stress overrides if severe
  if (stress > 70) {
    return `${agent.name} is stressed out and struggling to focus.`;
  }

  // State-driven thoughts
  const crushedState = states.find((s) => s.type === "heartbroken" || s.type === "in_love");
  if (crushedState) {
    return crushedState.type === "in_love"
      ? `${agent.name} can't stop thinking about someone special.`
      : `${agent.name} is still hurting inside.`;
  }

  const sickState = states.find((s) => s.type === "sick" || s.type === "injured");
  if (sickState) {
    return `${agent.name} isn't feeling well and wishes they could rest.`;
  }

  // High mood — upbeat thoughts
  if (mood > 80) {
    return `${agent.name} is feeling great and in good spirits today.`;
  }

  // Critical need
  if (topPressure.value > 70) {
    return topPressure.thought;
  }

  // Moderate mood
  if (mood > 50) {
    return `${agent.name} is getting through the day, one step at a time.`;
  }

  // Low mood fallback
  return `${agent.name} feels a bit off and can't quite put their finger on why.`;
}

const STATE_COLORS: Record<string, string> = {
  in_love: "bg-pink-900/40 text-pink-300 border-pink-800/40",
  heartbroken: "bg-rose-900/40 text-rose-300 border-rose-800/40",
  sick: "bg-yellow-900/40 text-yellow-300 border-yellow-800/40",
  injured: "bg-orange-900/40 text-orange-300 border-orange-800/40",
  euphoric: "bg-purple-900/40 text-purple-300 border-purple-800/40",
  grieving: "bg-ui-raised/60 text-ui-text border-ui-line/40",
  enraged: "bg-red-900/40 text-red-300 border-red-800/40",
  jealous: "bg-amber-900/40 text-amber-300 border-amber-800/40",
};

export function CurrentThought({ agent, needs, states }: CurrentThoughtProps) {
  const mood = needs?.mood ?? 50;
  const thought = assembleThought(agent, needs, states);

  return (
    <div className="px-3 py-2 border-b border-ui-line">
      <div className="text-xs text-ui-dim font-medium mb-1.5">Inner Monologue</div>

      {/* Thought sentence */}
      <p className="text-[11px] text-ui-blue leading-relaxed italic mb-2">
        "{thought}"
      </p>

      {/* Mood row */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base leading-none">{getMoodEmoji(mood)}</span>
        <span className={`text-xs font-medium ${getMoodColor(mood)}`}>
          {getMoodLabel(mood)}
        </span>
        <span className="text-[10px] text-ui-muted">({Math.round(mood)})</span>
      </div>

      {/* Active states badges */}
      {states.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {states.map((s) => (
            <span
              key={s.id}
              className={`text-[10px] px-1.5 py-0.5 rounded border capitalize ${
                STATE_COLORS[s.type] ?? "bg-ui-raised/60 text-ui-text border-ui-line/40"
              }`}
            >
              {s.type.replace(/_/g, " ")}
              {s.severity < 1 && (
                <span className="ml-0.5 opacity-60">
                  {(s.severity * 100).toFixed(0)}%
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Current action */}
      <div className="text-[11px] text-ui-dim">
        <span className="text-ui-muted">Doing: </span>
        {describeAction(agent.current_action, agent.current_action?.locationName as string | undefined)}
      </div>
    </div>
  );
}
