import { simEvents } from '../simEvents';

// ---------------------------------------------------------------------------
// PlanEventAdapter
//
// Normalises domain simEvents into the canonical `plan:evaluate-replan` event
// that ReplanEvaluator listens to.
// ---------------------------------------------------------------------------

/**
 * "started feeling drunk", plus the cause only when it is prose.
 *
 * Most `state:triggered` causes are internal labels — `action:drinking`,
 * `cascade:goal_failure_drinking`, `broke_3_days` — and this description is
 * shown to the player ("Rosa Chen changed plans: started feeling drunk:
 * cascade:goal_failure_drinking") and fed to the replan prompt and memory.
 * A label is recognisable by its `:` or `_`; a few causes are real phrases
 * ("exposed blackmail secret publicly") and those are kept.
 */
export function describeStateTrigger(state: string, cause?: string): string {
  const feeling = `started feeling ${state.replace(/_/g, ' ')}`;
  const isProse = cause != null && /\s/.test(cause.trim()) && !/[:_]/.test(cause);
  return isProse ? `${feeling}: ${cause!.trim()}` : feeling;
}

/** States that are good news — they don't disrupt a day the way a bad one does. */
const POSITIVE_STATES = new Set(['confident', 'euphoric', 'relieved']);

/**
 * How strongly a finished conversation should push its participants to
 * rethink the day. A replan is a full LLM plan for the rest of the day, and in
 * a 22-day trace most of them (≈540, the second-largest LLM load after
 * decomposition) followed pleasant small talk: "had a conversation with Marco
 * about exciting news" counted as dramatic because |sentiment| > 0.5. A warm
 * chat rarely changes where someone goes next; a fight often does. Positive
 * sentiment is halved, and only a clearly bad talk is dramatic.
 */
export function conversationReplanSignal(sentiment: number): { sentiment: number; isDramatic: boolean } {
  return {
    sentiment: sentiment > 0 ? sentiment * 0.5 : sentiment,
    isDramatic: sentiment <= -0.5,
  };
}

export function initPlanEventAdapter(): void {
  const DRAMATIC_STATES = new Set([
    'heartbroken',
    'angry',
    'infatuated',
    'arrested',
    'drunk',
    'grieving',
  ]);

  simEvents.on('conversation:ended', (payload: {
    agentId: number;
    otherName?: string;
    summary?: string;
    sentiment?: number;
  }) => {
    simEvents.emit('plan:evaluate-replan', {
      agentId: payload.agentId,
      type: 'conversation',
      description: `had a conversation with ${payload.otherName ?? 'someone'} about ${payload.summary ?? 'things'}`,
      ...conversationReplanSignal(payload.sentiment ?? 0),
    });
  });

  simEvents.on('state:triggered', (payload: {
    agentId: number;
    state: string;
    cause?: string;
  }) => {
    simEvents.emit('plan:evaluate-replan', {
      agentId: payload.agentId,
      type: 'state',
      description: describeStateTrigger(payload.state, payload.cause),
      // Every state used to arrive as -0.5, so "started feeling confident"
      // cleared the replan threshold like "started feeling sick" (71 replans
      // in the trace).
      sentiment: POSITIVE_STATES.has(payload.state) ? 0.2 : -0.5,
      isDramatic: DRAMATIC_STATES.has(payload.state),
    });
  });
}
