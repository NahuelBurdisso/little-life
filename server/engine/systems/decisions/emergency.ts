/**
 * Phase 1 of a decision: the emergency override (storm, hunger, sleep, loneliness, despair).
 */

import { CONFIG } from '../../../lib/constants';
import { isOpenAt } from '../../../lib/gameClock';
import { effectiveSleepWindow, inSleepWindow } from '../../../lib/sleepSchedule';
import { distance } from '../../../lib/utils';
import { PersonalityProfile } from '../../../lib/personality';
import { getEffectivePersonality } from '../../../lib/states';
import { sleepTargetFor } from '../../../lib/intimacy/tryst';
import type { AgentRow, NeedsRow, LocationRow, RelRow, ScoredAction } from './types';
import { nearestLocation, getRelationshipValues } from './helpers';
import type { MealPlan } from './meals';

// --- Emergency Check ---

/** Below this hunger a hunger emergency takes someone off their shift. */
export const HUNGER_INTERRUPTS_WORK = 5;

export function checkEmergency(
  agent: AgentRow,
  agentNeeds: NeedsRow,
  allLocations: LocationRow[],
  allRelationships: RelRow[],
  otherAgents: AgentRow[],
  activeEventTypes?: Set<string>,
  mealTarget?: () => MealPlan | null,
  hour?: number,
): ScoredAction | null {
  const critical = agentNeeds.thresholds?.critical ?? CONFIG.NEEDS.THRESHOLDS.critical;

  // Storm/weather emergency: outdoor agents flee home in bad conditions
  if (agent.current_location === null && activeEventTypes?.has('storm')) {
    return { action: 'idle', score: 9999, targetLocationId: agent.home };
  }

  const crises: { need: string; value: number }[] = [];
  // A hunger crisis with no meal to be had anywhere is not actionable: it would
  // win every pass and hold the agent at an empty table. Let the next crisis
  // (sleep, company) or the normal layers run until a shop opens or restocks.
  //
  // Nor does it pull someone off a shift until they are truly starving: the
  // farm's output was half a shift a day once meals cost food, because every
  // dip under 15 walked the farmers into town. Workers eat at lunch
  // (checkSchedule) and, carrying food, where they stand.
  let hungerMeal: MealPlan | null = null;
  const onShift = (agent.current_action as { type?: string } | null)?.type === 'working';
  if (agentNeeds.hunger < critical && !(onShift && agentNeeds.hunger >= HUNGER_INTERRUPTS_WORK)) {
    hungerMeal = mealTarget ? mealTarget() : { locationId: agent.home ?? undefined, here: false };
    if (hungerMeal != null) crises.push({ need: 'hunger', value: agentNeeds.hunger });
  }
  if (agentNeeds.energy < critical) crises.push({ need: 'energy', value: agentNeeds.energy });
  // Same rule for company: only a crisis if there is someone to see. The target
  // used to be the nearest friend whatever they were doing, so a lonely agent
  // who woke at 2 a.m. walked across town to a sleeping friend's house and sat
  // "socializing" in it until morning, re-issuing the walk every 16 minutes (a
  // G10 night walker; 3 h of walking in one soak trace). Friends who are asleep
  // don't count; with nobody awake to see, a crisis inside the agent's own
  // sleeping hours is left to the schedule (bed), not sent to an empty square.
  let socialTarget: ScoredAction | null = null;
  if (agentNeeds.social < critical) {
    socialTarget = socialCrisisTarget(agent, allLocations, allRelationships, otherAgents, hour);
    if (socialTarget) crises.push({ need: 'social', value: agentNeeds.social });
  }

  // Mood is a weighted average of the other needs, so a critical mood almost always
  // means a critical hunger/energy too. Checking it FIRST sent starving agents home
  // to idle instead of eating — and the 120-minute idle duration below pinned them
  // there while hunger kept falling. Real need crises win; despair is the fallback.
  if (crises.length === 0) {
    if (agentNeeds.mood < CONFIG.NEEDS.MOOD_CRITICAL_THRESHOLD) {
      return {
        action: 'idle',
        score: 9999,
        targetLocationId: agent.home,
      };
    }
    return null;
  }

  crises.sort((a, b) => a.value - b.value);
  const worst = crises[0];

  switch (worst.need) {
    case 'hunger': {
      // Where a meal actually is (see chooseMealTarget); used to be "the shop
      // if you have $3, else home" whatever the shop's hours or stock.
      return { action: 'eating', score: 9999, targetLocationId: hungerMeal?.locationId };
    }
    case 'energy': {
      // Bed is wherever tonight's bed is: a guest at their lover's stays there (lib/intimacy/tryst.ts).
      return { action: 'sleeping', score: 9999, targetLocationId: sleepTargetFor(agent) };
    }
    case 'social': {
      return socialTarget;
    }
    default:
      return null;
  }
}

/** Where a lonely agent in a social crisis goes, or null if nobody is to be had. */
function socialCrisisTarget(
  agent: AgentRow,
  allLocations: LocationRow[],
  allRelationships: RelRow[],
  otherAgents: AgentRow[],
  hour: number | undefined,
): ScoredAction | null {
  let bestTarget: { agentId: number; locationId: number | null; dist: number } | null = null;
  for (const other of otherAgents) {
    if (other.id === agent.id || !other.is_active) continue;
    const otherAction = (other.current_action as { type?: string } | null)?.type;
    if (otherAction === 'sleeping' || otherAction === 'dead') continue;
    const rel = getRelationshipValues(allRelationships, agent.id, other.id);
    if (rel && rel.friendship > 20) {
      const d = distance(agent.position, other.position);
      if (!bestTarget || d < bestTarget.dist) {
        bestTarget = { agentId: other.id, locationId: other.current_location, dist: d };
      }
    }
  }
  if (bestTarget) {
    const targetLoc = bestTarget.locationId
      ? bestTarget.locationId
      : nearestLocation(agent.position, allLocations, 'town_square')?.id ?? undefined;
    return { action: 'socializing', score: 9999, targetLocationId: targetLoc, targetAgentId: bestTarget.agentId };
  }
  if (hour !== undefined) {
    const personality = getEffectivePersonality(agent.id) ?? agent.personality as PersonalityProfile | null;
    if (inSleepWindow(effectiveSleepWindow(agent.schedule, personality, agent.workplace != null), hour)) return null;
  }
  const venues = allLocations.filter((l) =>
    l.type === 'town_square' || (l.type === 'tavern' && (hour === undefined || isOpenAt(l.operating_hours, hour))));
  const social = nearestLocation(agent.position, venues, ['tavern', 'town_square']);
  return social ? { action: 'socializing', score: 9999, targetLocationId: social.id } : null;
}
