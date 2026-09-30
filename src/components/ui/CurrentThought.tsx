import { describeAction } from "../../lib/actionText";
import { styleOf, stateLabel } from "../../lib/stateStyle";
import { thoughtOf, toneClass, type ThoughtContext } from "../../lib/thoughtLine";

interface CurrentThoughtProps {
  agent: {
    id?: number | string;
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
    /** Whom the feeling is about, so the line can name them (`thoughtOf`). */
    target_agent_id?: number | null;
    metadata: Record<string, any> | null;
  }[];
  /** Who is who, and the talk this resident is in: what `thoughtOf` needs to name names. */
  thoughtContext: ThoughtContext;
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

export function CurrentThought({ agent, needs, states, thoughtContext }: CurrentThoughtProps) {
  const mood = needs?.mood ?? 50;
  // The same line the hover card shows (lib/thoughtLine.ts), so the two never disagree.
  const thought = thoughtOf({ id: agent.id, name: agent.name, needs, activeStates: states }, thoughtContext);

  return (
    <div className="px-3 py-2 border-b border-ui-line">
      <div className="text-xs text-ui-dim font-medium mb-1.5">Inner Monologue</div>

      {/* Thought sentence */}
      <p className={`text-[11px] leading-relaxed italic mb-2 ${toneClass(thought.tone)}`}>
        "{thought.text}"
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
                styleOf(s.type)?.chip ?? "bg-ui-raised/60 text-ui-text border-ui-line/40"
              }`}
            >
              {stateLabel(s.type)}
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
