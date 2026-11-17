/**
 * Choosing an agent's next action: the ordered decision phases and the corrections after them.
 */

import { CONFIG } from '../../../lib/constants';
import { chancePerTick, isOpenAt } from '../../../lib/gameClock';
import { getAgentStates } from '../../../lib/states';
import { planExecutor } from '../../../lib/planning/instance';
import { withFamilies } from '../../../data/worldEventCatalog';
import { getComfortVisit, completeComfortVisit } from '../../../lib/lonelinessEngine';
import { parseWeddingTrigger } from '../../../lib/marriage';
import { parentsOfChild, parseChristeningTrigger } from '../../../lib/familyState';
import { pendingProposalPartner, queuePendingProposalNow } from '../../../lib/milestonesEngine';
import { pendingRendezvousPartner, queuePendingRendezvousNow } from '../../../lib/intimacy/rendezvous';
import { sleepTargetFor } from '../../../lib/intimacy/tryst';
import { isAdultContent } from '../../../lib/worldRules';
import type { AgentRow, LocationRow, ScoredAction } from './types';
import { nearestLocation, addNoise } from './helpers';
import { withMeal, SUPPER_MIN_ENERGY } from './meals';
import { checkEmergency } from './emergency';
import { socialCallPhase, URGENT_SOCIAL_CALL_SCORE } from './socialCall';
import { gatheringPhase, hasMustGathering } from './gathering';
import { proposalSeekDecision, trystDecision, rendezvousSeekDecision } from './seek';
import { isCommuteDue, checkSchedule } from './schedule';
import { scoreFreeTimeActions } from './freeTime';
import type { DecisionTickContext, AgentTurn } from './context';

/**
 * The agent's next action: the first phase that has an answer wins, in
 * priority order (each phase only runs while no earlier one decided), and an
 * idle at home when none does.
 */
export function chooseDecision(t: AgentTurn, d: DecisionTickContext): ScoredAction {
  const { agent, agentNeeds, mealPlan } = t;
  const { world, activeAgents, allLocations, allRelationships, activeEventTypes, nowMinutes } = d;
  let decision: ScoredAction | null = null;

  // Phase 1: Emergency
  if (CONFIG.DECISIONS.EMERGENCY_OVERRIDE) {
    decision = checkEmergency(
      agent,
      agentNeeds,
      allLocations,
      allRelationships,
      activeAgents,
      activeEventTypes,
      () => mealPlan(agent.home ?? undefined),
      world.time.hour,
    );
  }

  if (!decision) {
    decision = comfortVisitPhase(agent, d);
  }

  // Phase 1a (calls): a promised social call (lib/socialCalls, score 6700, 6900
  // urgent). Before the agent's own wedding in this order, so an ordinary call
  // yields to it explicitly: nobody leaves their own ceremony to wish a friend
  // happy birthday, but a spouse still goes to a deathbed.
  if (!decision) {
    const call = socialCallPhase(agent, d);
    // A `must` gathering (their husband's funeral, their own house on fire) is
    // the same: a birthday wish can wait.
    decision = call && call.score < URGENT_SOCIAL_CALL_SCORE
      && (ownWeddingPhase(agent, d) || ownChristeningPhase(agent, d) || hasMustGathering(agent, d))
      ? null
      : call;
  }

  if (!decision) {
    decision = ownWeddingPhase(agent, d);
  }

  if (!decision) {
    decision = ownChristeningPhase(agent, d);
  }

  // Phase 1a'' (gatherings, lib/gatherings): a gathering that is the agent's own
  // (score 6550: the widow at the funeral, the owner at the fire). Off a shift;
  // out of bed only for a kind that wakes people. decisions/gathering.ts.
  if (!decision) {
    decision = gatheringPhase(agent, d, 'must');
  }

  if (!decision) {
    decision = pendingProposalPhase(agent, d);
  }

  // Phase 1a'''-: an agreed tryst, and the night and dawn after it (adult layer,
  // score 6350: above the rendezvous seek below, since an evening already agreed
  // outranks asking for one; below the proposal above). Walks to the venue, holds a
  // guest at the house through the evening, sends them to bed there, and at dawn
  // home again, quietly. Once both are at the venue the periodic pass starts the
  // evening itself (lib/intimacy/tryst.ts).
  if (!decision) {
    decision = trystDecision(agent, world.time.hour, nowMinutes, getAgentStates(agent.id));
  }

  if (!decision && isAdultContent()) {
    decision = rendezvousPhase(agent, d);
  }

  if (!decision && !isCommuteDue(agent, allLocations, world.time.hour, world.time.minute)) {
    // A gathering of close ties (score 6100), or one they are already at, ahead
    // of the day plan: a friend's funeral beats "browse the market". Never off a
    // shift unless the kind says (a fire).
    decision = gatheringPhase(agent, d, 'should') ?? planPhase(t, d);
  }

  // Phase 2: Schedule
  if (!decision) {
    const scheduled = checkSchedule(agent, world, allLocations, agentNeeds.hunger);
    decision = scheduled && withMeal(scheduled, mealPlan);
  }

  // Phase 2a (gatherings): anyone else's pull to a gathering, as a crowd pull
  // (score 3850), rolled per tick with the gathering's own seeded dice.
  if (!decision) {
    decision = gatheringPhase(agent, d, 'may');
  }

  if (!decision && activeEventTypes.size > 0) {
    decision = eventCrowdPhase(agent, d);
  }

  if (!decision) {
    decision = freeTimePhase(t, d);
  }

  // Fallback
  if (!decision) {
    decision = { action: 'idle', score: 0, targetLocationId: agent.home };
  }
  return decision;
}

/** Phase 1a: a promised comfort visit to a lonely friend. */
function comfortVisitPhase(agent: AgentRow, d: DecisionTickContext): ScoredAction | null {
  const { activeAgents, allLocations, nowMinutes } = d;
  let decision: ScoredAction | null = null;
  // Phase 1a: Comfort visit (score 7000 — above the day plan, below emergency).
  // A warm friend promised to look in on a lonely neighbour (lonelinessEngine).
  // Walk to wherever they are; the social-queue block below opens the
  // conversation once the two are together.
  const visit = getComfortVisit(agent.id, nowMinutes);
  if (visit) {
    const lonely = activeAgents.find((a) => a.id === visit.lonelyAgentId);
    const lonelyAction = (lonely?.current_action as { type?: string } | null)?.type;
    if (!lonely || lonelyAction === 'dead') {
      completeComfortVisit(agent.id);
    } else if (lonelyAction !== 'sleeping') {
      // Asleep: leave the visit pending; it keeps until its window closes.
      decision = {
        action: 'socializing',
        score: 7000,
        targetLocationId:
          lonely.current_location ?? nearestLocation(lonely.position, allLocations, 'town_square')?.id,
        targetAgentId: lonely.id,
        topic: 'checking in on how they have been doing lately',
        source: 'comfort_visit',
      };
    }
  }
  return decision;
}

/** Phase 1a': the agent's own wedding. */
function ownWeddingPhase(agent: AgentRow, d: DecisionTickContext): ScoredAction | null {
  const { activeWorldEvents, allLocations } = d;
  let decision: ScoredAction | null = null;
  // Phase 1a': their own wedding (score 6500 — above the day plan, below a
  // comfort visit's promise and emergencies). The ceremony is on the square
  // (lib/milestonesEngine.ts) and runs for the event's six hours; a bride
  // who stays at the counter because her plan said "work" left the town
  // celebrating two empty chairs. Guests are pulled in by Phase 2b below.
  const ownWedding = activeWorldEvents.find((e) => {
    if (e.type !== 'wedding') return false;
    const couple = parseWeddingTrigger(e.triggered_by);
    return couple !== null && couple.includes(agent.id);
  });
  const venue = ownWedding
    ? (ownWedding.location_id ?? nearestLocation(agent.position, allLocations, 'town_square')?.id)
    : undefined;
  if (venue != null) {
    decision = { action: 'socializing', score: 6500, targetLocationId: venue };
  }
  return decision;
}

/** Phase 1a' (family): the christening of the agent's own child. */
function ownChristeningPhase(agent: AgentRow, d: DecisionTickContext): ScoredAction | null {
  const { activeWorldEvents, allLocations } = d;
  let decision: ScoredAction | null = null;
  // Phase 1a' (family): their own child's christening, same score and for the
  // same reason as their wedding — the town gathering to welcome a baby whose
  // parents stayed at work would be welcoming nobody (lib/family.ts).
  const ownChristening = activeWorldEvents.find((e) => {
    if (e.type !== 'christening') return false;
    const childId = parseChristeningTrigger(e.triggered_by);
    return childId !== null && parentsOfChild(childId).includes(agent.id);
  });
  const venue = ownChristening
    ? (ownChristening.location_id ?? nearestLocation(agent.position, allLocations, 'town_square')?.id)
    : undefined;
  if (venue != null) {
    decision = { action: 'socializing', score: 6500, targetLocationId: venue };
  }
  return decision;
}

/** Phase 1a'': going to find the partner a pending proposal is for. */
function pendingProposalPhase(agent: AgentRow, d: DecisionTickContext): ScoredAction | null {
  const { world, activeAgents, allLocations } = d;
  let decision: ScoredAction | null = null;
  // Phase 1a'': a pending proposal (score 6400 — above the day plan, below their
  // own wedding). The proposer used to wait for the partner to wander into range;
  // now they go and find them when both are free to be found (proposalSeekDecision
  // holds the sleep/shift rules). Once together the question is seated on the
  // spot, and the social-queue block below leaves this decision alone so an
  // ordinary chat doesn't take the place of the proposal.
  const partnerId = pendingProposalPartner(agent.id);
  const partner = partnerId != null ? activeAgents.find((a) => a.id === partnerId) : undefined;
  if (partner) {
    decision = proposalSeekDecision(agent, partner, allLocations, world.time.hour, getAgentStates(agent.id), getAgentStates(partner.id));
    if (decision && queuePendingProposalNow(agent.id)) {
      // Together already: stay put with them while the conversation starts.
      decision = { ...decision, targetLocationId: agent.current_location ?? decision.targetLocationId };
    }
  }
  return decision;
}

/** Phase 1a''': going to find the lover a pending rendezvous invitation is for (adult layer). */
function rendezvousPhase(agent: AgentRow, d: DecisionTickContext): ScoredAction | null {
  const { world, activeAgents, allLocations } = d;
  let decision: ScoredAction | null = null;
  // Phase 1a''': a pending rendezvous invitation (adult layer, score 6300, right
  // below the proposal block above, same guards). The asker goes to find the one
  // they want to ask, and the invitation is seated the moment they are together.
  // The social-queue block below leaves this decision alone (source 'rendezvous_seek').
  const askedId = pendingRendezvousPartner(agent.id);
  const asked = askedId != null ? activeAgents.find((a) => a.id === askedId) : undefined;
  if (asked) {
    decision = rendezvousSeekDecision(agent, asked, allLocations, world.time.hour, getAgentStates(agent.id), getAgentStates(asked.id));
    if (decision && queuePendingRendezvousNow(agent.id)) {
      // Together already: stay put with them while the conversation starts.
      decision = { ...decision, targetLocationId: agent.current_location ?? decision.targetLocationId };
    }
  }
  return decision;
}

/** Phase 1b: the step of the day plan for this hour (the caller skips it while the commute is due). */
function planPhase(t: AgentTurn, d: DecisionTickContext): ScoredAction | null {
  const { agent, mealPlan } = t;
  const { world } = d;
  let decision: ScoredAction | null = null;
  // Phase 1b: Plan layer (score 6000 — above free-time, below emergency).
  // Not while the commute is due: plan blocks are whole hours and an LLM plan
  // (like the fallback one) puts "work" at `workStart`, so the block before it
  // would hold the agent at home and the commute would come out of the shift
  // again. The schedule sends them off (checkSchedule, isCommuteDue).
  const planned = planExecutor.getPlannedAction(agent.id, world.time.hour, world.time.totalTicks, world.time.day, world.time.minute);
  // A planned meal with no meal to be had falls through to the schedule.
  if (planned) {
    decision = withMeal(planned, mealPlan);
  }
  return decision;
}

/**
 * Phase 2b: the pull of active world events on an otherwise undecided agent.
 * Later rules override earlier ones, as they always have (a storm sends home
 * someone a festival had just sent to the square).
 */
function eventCrowdPhase(agent: AgentRow, d: DecisionTickContext): ScoredAction | null {
  const { world, allLocations, activeWorldEvents, activeEventTypes } = d;
  let decision: ScoredAction | null = null;
  // Phase 2b: Event crowd behavior — idle agents gravitate toward active events.
  // The pull chances below are authored per GAME MINUTE and rolled through
  // chancePerTick, so a festival fills the square in the same game time at 4x
  // (per tick, an idle agent set off after 1/4 of the game minutes) as at 1x.
  // Festival/wedding/competition: head to town square to join the fun.
  // A couple's wedding names its venue; go there rather than to whichever
  // square is nearest (a town can have more than one open area).
  // A christening (lib/family.ts) gathers the town the same way, and the
  // calendar's festivals name their venue too (Midsummer is in the park).
  if (activeEventTypes.has('festival') || activeEventTypes.has('wedding') || activeEventTypes.has('competition')
    || activeEventTypes.has('christening')) {
    const namedVenue = activeWorldEvents.find((e) =>
      e.location_id != null
      && (e.type === 'wedding' || e.type === 'christening' || withFamilies([e.type]).has('festival')))?.location_id;
    const venue = namedVenue != null
      ? allLocations.find((l) => l.id === namedVenue)
      : nearestLocation(agent.position, allLocations, 'town_square');
    if (venue && agent.current_location !== venue.id && Math.random() < chancePerTick(0.4, world.tick_speed)) {
      decision = { action: 'socializing', score: 3800, targetLocationId: venue.id };
    }
  }
  // Storm: rush home if outdoors
  if (activeEventTypes.has('storm') && agent.current_location === null) {
    decision = { action: 'idle', score: 3800, targetLocationId: agent.home };
  }
  // Town meeting: head to town square
  if (activeEventTypes.has('town_meeting')) {
    const square = nearestLocation(agent.position, allLocations, 'town_square');
    if (square && agent.current_location !== square.id && Math.random() < chancePerTick(0.6, world.tick_speed)) {
      decision = { action: 'socializing', score: 3900, targetLocationId: square.id };
    }
  }
  // Traveling merchant: browse the market
  if (activeEventTypes.has('traveling_merchant') && Math.random() < chancePerTick(0.25, world.tick_speed)) {
    const square = nearestLocation(agent.position, allLocations, 'town_square');
    if (square) {
      decision = { action: 'idle', score: 3500, targetLocationId: square.id, source: 'browse' };
    }
  }
  return decision;
}

/**
 * Phase 3: the best-scored free-time option (scoreFreeTimeActions), after
 * goals and a campaign have weighed in and eating options have been sent to
 * where a meal is. Null when nothing is left to choose from.
 */
function freeTimePhase(t: AgentTurn, d: DecisionTickContext): ScoredAction | null {
  const { agent, agentNeeds, agentEcon, mealPlan } = t;
  const {
    world, activeAgents, allLocations, allRelationships, econMap, activeEventTypes, currentWeather, negativeFactCounts,
  } = d;
  let decision: ScoredAction | null = null;
  // Phase 3: Free time scoring
  const scored = scoreFreeTimeActions(
    agent,
    agentNeeds,
    agentEcon,
    allLocations,
    allRelationships,
    activeAgents,
    world,
    econMap,
    activeEventTypes,
    currentWeather,
    negativeFactCounts,
  );
  if (scored.length > 0) {
    applyGoalAlignment(agent, scored, d);
    applyCampaigning(agent, scored, d);
    addSafetyNetWalk(scored, allLocations);

    // Eating options go where the meal is; with none to be had they are
    // dropped and the next-best action wins (it used to be a 10-minute
    // idle at home, re-decided into the same empty table).
    const viable = scored
      .map((s) => withMeal(s, mealPlan))
      .filter((s): s is ScoredAction => s != null);
    viable.sort((a, b) => b.score - a.score);
    decision = viable[0] ?? null;
  }
  return decision;
}

/** Goals with a target pull the agent toward that person: a boost if together, a seek option if not. */
function applyGoalAlignment(agent: AgentRow, scored: ScoredAction[], d: DecisionTickContext): void {
  const { activeAgents, goalsMap } = d;
  // Goal alignment bonus — boost social actions toward goal targets
  const agentGoals = goalsMap.get(agent.id) ?? [];
  for (const goal of agentGoals) {
    if (!goal.target_id) continue;
    const target = activeAgents.find(a => a.id === goal.target_id);
    if (!target || !target.is_active) continue;

    // Co-located: massive score boost for socializing with target
    if (agent.current_location === target.current_location) {
      for (const s of scored) {
        if (s.action === 'socializing' && s.targetAgentId === goal.target_id) {
          s.score += Math.round(2500 * goal.priority);
        }
      }
    } else {
      // NOT co-located: add a "go find target" socializing option
      // Goal-driven agents seek out their targets
      const seekScore = Math.round(800 * goal.priority);
      scored.push({
        action: 'socializing',
        score: addNoise(seekScore),
        targetAgentId: target.id,
        targetLocationId: target.current_location ?? undefined,
        source: `goal:seek_target`,
      });
    }
  }
}

/** A candidate in the mayoral campaign spends free time canvassing. */
function applyCampaigning(agent: AgentRow, scored: ScoredAction[], d: DecisionTickContext): void {
  const { campaigners } = d;
  // Campaigning: a candidate's free time goes to meeting people. Every
  // socializing option is worth more, and one to a voter they haven't
  // yet canvassed more still — the support score counts heads.
  if (campaigners.has(agent.id)) {
    for (const s of scored) {
      if (s.action !== 'socializing') continue;
      s.score *= s.targetAgentId != null && !campaigners.has(s.targetAgentId) ? 1.8 : 1.4;
    }
  }
}

/** With every option suppressed to almost nothing, a walk to the square. */
function addSafetyNetWalk(scored: ScoredAction[], allLocations: LocationRow[]): void {
  // Safety net: if all scores suppressed to near-zero, add a minimum walk
  if (scored.every(s => s.score < 5)) {
    const square = allLocations.find(l => l.type === 'town_square');
    if (square) {
      scored.push({ action: 'socializing', score: 10, targetLocationId: square.id });
    }
  }
}

/** A hungry agent about to go to bed eats first, if there is a meal to be had. */
export function eatBeforeBed(t: AgentTurn, decision: ScoredAction, nowMinutes: number): ScoredAction {
  const { agent, agentNeeds, mealPlan } = t;
  // Don't go to bed hungry. Sleep is 6 game hours (and an energy emergency
  // outranks a hunger one whenever energy is lower), so a hungry agent who
  // went to bed woke up under the critical line: in the soaks most of the
  // town's time below hunger 35 was spent asleep. An hour's meal first, if
  // there is one to be had; bed on the next pass.
  if (decision.action === 'sleeping') {
    const low = agentNeeds.thresholds?.low ?? CONFIG.NEEDS.THRESHOLDS.low;
    const supper = agentNeeds.hunger < low && agentNeeds.energy >= SUPPER_MIN_ENERGY
      ? mealPlan(sleepTargetFor(agent, nowMinutes))
      : null;
    if (supper) decision = { action: 'eating', score: decision.score, targetLocationId: supper.locationId };
  }
  return decision;
}

/** Correct a decision the target location cannot host: not their workplace, not their bed, closed. */
export function validateAtTarget(agent: AgentRow, decision: ScoredAction, d: DecisionTickContext): ScoredAction {
  const { world, allLocations, nowMinutes } = d;
  // --- Validate action makes sense at target location ---
  if (decision.targetLocationId != null) {
    const targetLoc = allLocations.find((l) => l.id === decision!.targetLocationId);
    if (targetLoc) {
      // Can't work at a location that isn't your workplace
      if (decision.action === 'working' && decision.targetLocationId !== agent.workplace) {
        decision = { action: 'idle', score: 0, targetLocationId: agent.home };
      }
      // Can't sleep anywhere except in tonight's bed: home, or a lover's house for a guest
      // whose night there is on (sleepTargetFor, lib/intimacy/tryst.ts).
      if (decision!.action === 'sleeping') {
        const bed = sleepTargetFor(agent, nowMinutes);
        if (decision!.targetLocationId !== bed) {
          decision = { action: 'sleeping', score: decision!.score, targetLocationId: bed };
        }
      }
      // Check operating hours for commercial locations
      if (['eating', 'shopping'].includes(decision!.action)) {
        if (!isOpenAt(targetLoc.operating_hours, world.time.hour)) {
          decision = { action: 'idle', score: 0, targetLocationId: agent.home };
        }
      }
    }
  }
  return decision;
}
