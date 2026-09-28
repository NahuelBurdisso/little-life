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
      sentiment: payload.sentiment ?? 0,
      isDramatic: Math.abs(payload.sentiment ?? 0) > 0.5,
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
      sentiment: -0.5,
      isDramatic: DRAMATIC_STATES.has(payload.state),
    });
  });
}
