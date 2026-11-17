/**
 * Phase 1a (calls): walking over to someone because of what happened to them
 * (lib/socialCalls). The comfort visit's shape, for every kind of call.
 */

import { firstName } from '../../../ai/names';
import { getAgentStates } from '../../../lib/states';
import {
  callOf, endLinger, finishCall, lingerOf, socialCallKind,
} from '../../../lib/socialCalls/engine';
import type { AgentRow, ScoredAction } from './types';
import { meetingPlaceFor } from './helpers';
import { seekParty } from './seek';
import type { DecisionTickContext } from './context';

/**
 * Above the day plan (6000) so a call is not put off for "browse the market",
 * and above a pending proposal and a rendezvous; below the comfort visit's
 * promise (7000) and every emergency. An urgent call (a deathbed) a little higher.
 */
export const SOCIAL_CALL_SCORE = 6700;
export const URGENT_SOCIAL_CALL_SCORE = 6900;

/** A sick visit fits into the lunch hour: this many game minutes either side of `schedule.lunchTime`. */
export const LUNCH_VISIT_SLACK_MIN = 30;

/** In no state to go: they would only carry the illness in, or can't leave. */
const CALLER_NOT_NOW = new Set(['sick', 'depressed', 'arrested']);

function actionOf(a: Pick<AgentRow, 'current_action'>): string {
  return (a.current_action as { type?: string } | null)?.type ?? 'idle';
}


/**
 * The walk to the person this agent promised to call on, the stay at their side
 * after a vigil, or null. The rules:
 *   - nobody is pulled out of bed or off a work shift (the caller's, or the
 *     target's while they are at work), except by an urgent call (a deathbed), which may take the
 *     caller off a shift and through the evening — never out of their sleep;
 *   - a target asleep leaves the call pending: it keeps until its window closes;
 *   - a call to or from someone dead, gone or jailed is dropped, and one that
 *     no longer makes sense (the patient recovered) too; an expired one is
 *     recorded as missed (the kind's `onMissed`: the birthday they forgot).
 * Once the two are together, the social-queue step (social.ts) seats the
 * conversation with the call's trigger and topic.
 */
export function socialCallPhase(agent: AgentRow, d: DecisionTickContext): ScoredAction | null {
  const { activeAgents, allLocations, nowMinutes, world } = d;

  // After a good vigil the caller stays at the bedside a while.
  const linger = lingerOf(agent.id, nowMinutes);
  if (linger) {
    const target = activeAgents.find((a) => a.id === linger.targetId);
    if (target && target.current_location != null && actionOf(target) !== 'dead') {
      return {
        action: 'idle',
        score: URGENT_SOCIAL_CALL_SCORE,
        targetLocationId: target.current_location,
        description: `Sitting at ${firstName(target.name)}'s bedside`,
      };
    }
    endLinger(agent.id);
  }

  const call = callOf(agent.id);
  if (!call || nowMinutes < call.notBeforeMin) return null;
  const def = socialCallKind(call.kind);
  if (!def) {
    finishCall(call.id, 'dropped', nowMinutes);
    return null;
  }
  if (nowMinutes > call.expiresAtMin) {
    finishCall(call.id, 'expired', nowMinutes);
    return null;
  }
  const target = activeAgents.find((a) => a.id === call.targetId);
  const targetStates = target ? getAgentStates(target.id) as string[] : [];
  if (!target || actionOf(target) === 'dead' || targetStates.includes('arrested')
    || (def.stillRelevant && !def.stillRelevant(call))) {
    finishCall(call.id, 'dropped', nowMinutes);
    return null;
  }
  if (actionOf(target) === 'sleeping') return null;

  const callerStates = getAgentStates(agent.id) as string[];
  if (callerStates.some((s) => CALLER_NOT_NOW.has(s))) return null;
  const me = seekParty(agent, world.time.hour, callerStates);
  const them = seekParty(target, world.time.hour, targetStates);
  if (!call.urgent) {
    if (me.inSleepWindow || them.inSleepWindow) return null;
    // The target's shift only counts while they are at work: a fevered baker in
    // bed at home during her hours is exactly who gets visited (the first soak
    // had most sick visits wait out the patient's shift and expire).
    // A sick visit may also be made in the caller's lunch hour: a working caller
    // and a patient who sleeps early share only a few evening hours, and ~30% of
    // the step-2/3 soaks' sick visits lapsed in between. Only that kind: a
    // birthday or a welcome can wait for the evening; a sickbed is the errand
    // people did slip out for at noon.
    const lunchBreak = me.onShift && call.kind === 'sick_visit'
      && Math.abs(world.time.hour * 60 + world.time.minute - agent.schedule.lunchTime * 60) <= LUNCH_VISIT_SLACK_MIN;
    if ((me.onShift && !lunchBreak) || them.action === 'working') return null;
    if (them.onShift && target.current_location != null && target.current_location === target.workplace) return null;
  }

  const label = def.label(call, firstName(target.name));
  return {
    action: 'socializing',
    score: call.urgent ? URGENT_SOCIAL_CALL_SCORE : SOCIAL_CALL_SCORE,
    targetLocationId: meetingPlaceFor(target, allLocations),
    targetAgentId: target.id,
    topic: def.topic(call),
    source: 'social_call',
    description: label.there,
    walkDescription: label.walking,
  };
}
