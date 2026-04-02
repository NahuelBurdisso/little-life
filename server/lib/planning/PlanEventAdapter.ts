import { simEvents } from '../simEvents';

// ---------------------------------------------------------------------------
// PlanEventAdapter
//
// Normalises domain simEvents into the canonical `plan:evaluate-replan` event
// that ReplanEvaluator listens to.
// ---------------------------------------------------------------------------

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
      description: `started feeling ${payload.state}${payload.cause ? ': ' + payload.cause : ''}`,
      sentiment: -0.5,
      isDramatic: DRAMATIC_STATES.has(payload.state),
    });
  });
}
