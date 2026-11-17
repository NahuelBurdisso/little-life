/**
 * Phase 2 of a decision: the daily schedule (sleep, commute, meals, work), and the sleep and commute windows.
 */

import { db } from '../../../db';
import { eq, and } from 'drizzle-orm';
import { CONFIG } from '../../../lib/constants';
import { effectiveSleepWindow } from '../../../lib/sleepSchedule';
import { distance } from '../../../lib/utils';
import { PersonalityProfile } from '../../../lib/personality';
import { getEffectivePersonality, getAgentStates } from '../../../lib/states';
import { agentStates } from '../../../db/schema';
import { createFact } from '../../../lib/gossip';
import { healerInTown } from '../../../lib/careers';
import { sleepTargetFor } from '../../../lib/intimacy/tryst';
import type { AgentRow, LocationRow, WorldRow, ScoredAction } from './types';
import { workSkipCount } from './state';
import { nearestLocation } from './helpers';
import { DINNER_HOUR, DINNER_BELOW_HUNGER, LUNCH_BELOW_HUNGER } from './meals';

/**
 * The hours an agent sleeps (sleepSchedule.ts, shared with conversationPacing),
 * in the `{ sleep, wake }` shape this file uses.
 */
export function sleepWindow(
  agent: Pick<AgentRow, 'schedule' | 'workplace'>,
  personality: PersonalityProfile | null,
): { sleep: number; wake: number } {
  const w = effectiveSleepWindow(agent.schedule, personality, agent.workplace != null);
  return { sleep: w.sleepHour, wake: w.wakeHour };
}

/**
 * Game minutes to allow for the walk from home to work: straight-line door to
 * door at walking speed, plus 30% for streets that do not run straight and ten
 * minutes for the legs inside the two buildings. Capped at two hours so a
 * broken location can't send someone off in the middle of the night.
 */
export function commuteLeadMinutes(
  agent: Pick<AgentRow, 'home' | 'workplace'>,
  allLocations: Pick<LocationRow, 'id' | 'entry_point'>[],
): number {
  const home = allLocations.find((l) => l.id === agent.home);
  const work = allLocations.find((l) => l.id === agent.workplace);
  if (!home || !work) return 0;
  const walk = distance(home.entry_point, work.entry_point) / CONFIG.MOVEMENT.PIXELS_PER_GAME_MINUTE;
  return Math.min(120, Math.round(walk * 1.3 + 10));
}

/**
 * Is it time to set off for the shift? True in the `commuteLeadMinutes` before
 * `workStart`, measured on the clock face so a shift at 00:00 or 01:00 is left
 * for before midnight (`workStart * 60 - lead` went negative and never matched).
 * Only for a job away from home.
 */
export function isCommuteDue(
  agent: Pick<AgentRow, 'home' | 'workplace' | 'schedule'>,
  allLocations: Pick<LocationRow, 'id' | 'entry_point'>[],
  hour: number,
  minute: number,
): boolean {
  if (!agent.workplace || agent.workplace === agent.home) return false;
  const lead = commuteLeadMinutes(agent, allLocations);
  const untilStart = (agent.schedule.workStart * 60 - (hour * 60 + minute) + 1440) % 1440;
  return untilStart > 0 && untilStart <= lead;
}

// --- Schedule Check ---

export function checkSchedule(
  agent: AgentRow,
  world: WorldRow,
  allLocations: LocationRow[],
  hunger?: number,
): ScoredAction | null {
  const personality = getEffectivePersonality(agent.id) ?? agent.personality as PersonalityProfile | null;
  const { hour, minute } = world.time;
  const sched = agent.schedule;
  const duringWorkHours = !!agent.workplace && hour >= sched.workStart && hour < sched.workEnd;

  if (personality && Math.random() < personality.impulsiveness / 200) {
    // Impulsive agent skips schedule this tick; track work skips
    if (duringWorkHours) {
      const count = (workSkipCount.get(agent.id) ?? 0) + 1;
      workSkipCount.set(agent.id, count);
      if (count === 3) {
        createFact('work_issue', agent.id, null, 1, [agent.id], 'observed');
      }
    }
    return null;
  }

  // Sick → seek medical attention or rest at home
  const agentStateTypes = getAgentStates(agent.id);
  if (agentStateTypes.includes('sick')) {
    // Try to go to the clinic if severity is high enough
    const sickState = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, 'sick')))
      .get();
    // Only while someone alive can treat them: with the doctor and assistant
    // dead, the clinic is an empty room, and bed at home is where they get
    // better (states/effects.ts HOME_REST_RECOVERY).
    if (sickState && sickState.severity > 0.4 && healerInTown()) {
      const clinic = nearestLocation(agent.position, allLocations, 'clinic');
      if (clinic) {
        return { action: 'idle', score: 9999, targetLocationId: clinic.id };
      }
    }
    return { action: 'idle', score: 9999, targetLocationId: agent.home };
  }

  // Depressed → skip work
  if (agentStateTypes.includes('depressed') && agent.workplace) {
    if (hour >= sched.workStart && hour < sched.workEnd) {
      const count = (workSkipCount.get(agent.id) ?? 0) + 1;
      workSkipCount.set(agent.id, count);
      if (count === 3) {
        createFact('work_issue', agent.id, null, 1, [agent.id], 'observed');
      }
      return null; // skip scheduled work
    }
  }

  const { sleep: effectiveSleepTime, wake: effectiveWakeTime } = sleepWindow(agent, personality);

  if (effectiveSleepTime > effectiveWakeTime) {
    // Normal case: sleep 22 → wake 7 → sleeping when hour >= 22 OR hour < 7
    if (hour >= effectiveSleepTime || hour < effectiveWakeTime) {
      return { action: 'sleeping', score: 5000, targetLocationId: sleepTargetFor(agent) };
    }
  } else {
    // Inverted case: sleep 2 → wake 10 → sleeping when hour >= 2 AND hour < 10
    if (hour >= effectiveSleepTime && hour < effectiveWakeTime) {
      return { action: 'sleeping', score: 5000, targetLocationId: sleepTargetFor(agent) };
    }
  }

  const morning = hour >= effectiveWakeTime && !!agent.workplace && hour < sched.workStart;

  // Breakfast first when the night left them hungry: a worker's next meal is
  // lunch, and the jog/coffee/contemplate branches below used to take the wake
  // hour, so most of the town started its shift on an empty stomach. Above the
  // commute: a hungry worker eats and is late rather than working a morning
  // shift on nothing.
  if (morning && hunger !== undefined && hunger < LUNCH_BELOW_HUNGER) {
    return { action: 'eating', score: 3500, targetLocationId: agent.home };
  }

  // Set off for work in time to be there when the shift starts. The work branch
  // below only fires from `workStart`, so the whole commute — 67 minutes on
  // average door to door in the soak town — came out of the shift every day
  // (the soak's biggest "away from work" item, ~1.4 h per worker). Above the
  // rest of the morning routine, which would otherwise hold the window with a
  // jog or a coffee; below the sleep check, so nobody is got out of bed for it.
  if (isCommuteDue(agent, allLocations, hour, minute)) {
    return { action: 'working', score: 4000, targetLocationId: agent.workplace! };
  }

  // Morning routine: personality-driven activities between wake and work
  if (morning) {
    if (personality) {
      // Athletic / impulsive agents: morning jog
      if (personality.impulsiveness > 55 && hour === effectiveWakeTime) {
        const park = nearestLocation(agent.position, allLocations, 'park');
        if (park) return { action: 'idle', score: 3500, targetLocationId: park.id, source: 'jog' };
      }
      // Social agents: visit a cafe/tavern for morning coffee
      if (personality.warmth > 55 && hour === effectiveWakeTime + 1) {
        const cafe = nearestLocation(agent.position, allLocations, ['tavern', 'bakery', 'shop']);
        if (cafe) return { action: 'eating', score: 3500, targetLocationId: cafe.id };
      }
      // Neurotic agents: need quiet time at home first
      if (personality.neuroticism > 60 && hour === effectiveWakeTime) {
        return { action: 'idle', score: 3500, targetLocationId: agent.home, source: 'contemplate' };
      }
    }
    // Default: eat breakfast at home
    if (hour === effectiveWakeTime) {
      return { action: 'eating', score: 3500, targetLocationId: agent.home };
    }
  }

  // Lunch time — a break in the shift. It sat below the work-time return, so
  // it only ever fed people with no job: every worker's lunchTime is inside
  // their shift. Skipped when already fed (a 60-minute meal that starts at the
  // window's opening edge would otherwise be followed by a second one).
  const lunchMinutes = sched.lunchTime * 60;
  const currentMinutes = hour * 60 + minute;
  if (Math.abs(currentMinutes - lunchMinutes) <= 30 && (hunger === undefined || hunger < LUNCH_BELOW_HUNGER)) {
    const foodLoc = nearestLocation(agent.position, allLocations, ['shop', 'tavern', 'bakery']);
    if (foodLoc) {
      return { action: 'eating', score: 3000, targetLocationId: foodLoc.id };
    }
    return { action: 'eating', score: 3000, targetLocationId: agent.home };
  }

  // Dinner: the evening meal the schedule never had. Soaks put the town at 1.3
  // meals a person a day once meals cost food — breakfast and lunch at best,
  // then an evening out that a hunger of 40 rarely beat — against ~106 hunger
  // a day of decay. From the end of the shift (18:00 without one) until bed.
  const dinnerFrom = agent.workplace ? sched.workEnd : DINNER_HOUR;
  if (hour >= dinnerFrom && hour >= DINNER_HOUR - 1 && hunger !== undefined && hunger < DINNER_BELOW_HUNGER) {
    return { action: 'eating', score: 3000, targetLocationId: agent.home };
  }

  // Work time
  if (agent.workplace && hour >= sched.workStart && hour < sched.workEnd) {
    workSkipCount.set(agent.id, 0); // agent actually went to work — reset counter
    return { action: 'working', score: 4000, targetLocationId: agent.workplace };
  }

  return null;
}
