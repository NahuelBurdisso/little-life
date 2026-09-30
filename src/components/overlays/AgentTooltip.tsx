import { describeAction } from "../../lib/actionText";
import { toneClass, type Thought } from "../../lib/thoughtLine";
import { MiniPortrait } from "../ui/MiniPortrait";
import type { PortraitMood } from "../ui/portraitMood";

interface AgentTooltipProps {
  /**
   * The live agent row (`agents.getActive`), looked up by id on every render in App so the card
   * keeps up while the pointer rests on a sprite. Nothing here is fetched: every field is already
   * on the client.
   */
  agent: {
    name: string;
    currentAction: unknown;
    place?: string | null;
    portrait_sprite?: string;
    gender?: string | null;
    age?: number | null;
  } | null;
  /** "On their mind" (`thoughtOf`), computed by the caller from the same live row. */
  thought?: Thought | null;
  /** Expression for the portrait (`portraitMood`). */
  mood?: PortraitMood;
  position: { x: number; y: number } | null;
}

export function AgentTooltip({ agent, thought, mood, position }: AgentTooltipProps) {
  if (!agent || !position) return null;

  const actionText = describeAction(agent.currentAction, agent.place);

  return (
    <div
      className="fixed z-50 pointer-events-none px-2.5 py-1.5 bg-ui-panel/95 border border-ui-line rounded-sm text-xs shadow-lg max-w-64"
      style={{
        left: position.x + 12,
        top: position.y - 8,
      }}
    >
      <div className="flex items-center gap-2">
        <MiniPortrait agent={agent} size={32} mood={mood} />
        <div className="min-w-0">
          <div className="font-bold text-ui-text">{agent.name}</div>
          <div className="text-ui-dim mt-0.5">{actionText}</div>
        </div>
      </div>
      {thought && (
        <div className={`mt-1.5 pt-1.5 border-t border-ui-line/60 italic leading-snug ${toneClass(thought.tone)}`}>
          {thought.text}
        </div>
      )}
    </div>
  );
}
