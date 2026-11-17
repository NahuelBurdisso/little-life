/**
 * The decision phase: what every agent does next. tick() is the entry point; the
 * steps live in ./decisions/ and the helpers other modules and tests use from
 * here are re-exported below.
 */

import { db } from '../../db';
import { agents, needs, conversationQueue } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { emitter } from '../emitter';
import { getAgentStates } from '../../lib/states';
import { planGenerator } from '../../lib/planning/instance';
import type { AgentRow, WorldRow } from './decisions/types';
import { chooseMealTarget } from './decisions/meals';
import { type DecisionTickContext, type AgentTurn, loadDecisionContext } from './decisions/context';
import { chooseDecision, eatBeforeBed, validateAtTarget } from './decisions/phases';
import { resolveDestination, startDecision, logZoneActivity } from './decisions/action';
import { executeCrime, constableArrests } from './decisions/crime';
import { queueSocialConversation } from './decisions/social';
import { queueLocationEncounters } from './decisions/encounters';
import { queueGatheringEncounters } from './decisions/gathering';

export { clearWorkSkipCounts, DATE_ANNOUNCE_REPEAT_MINUTES, shouldAnnounceDate, clearDateAnnouncements } from './decisions/state';
export { gatheringBonus } from './decisions/helpers';
export { type MealPlan, chooseMealTarget, groceryList } from './decisions/meals';
export { HUNGER_INTERRUPTS_WORK, checkEmergency } from './decisions/emergency';
export { proposalSeekDecision, trystDecision, rendezvousSeekDecision } from './decisions/seek';
export { sleepWindow, commuteLeadMinutes, isCommuteDue } from './decisions/schedule';
export { zoneVerbOf, buildAction } from './decisions/action';

/** Whether a conversation queue entry still includes this agent. */
function isQueuedToTalk(agentId: number): boolean {
  return db.select({ participants: conversationQueue.participants }).from(conversationQueue).all()
    .some((q) => (q.participants as number[]).includes(agentId));
}

/**
 * CLOCK: GAME MINUTES. `agents.action_started` is stamped with
 * `gameMinutes(world.time)` and `action_duration` (ACTION_MIN_DURATIONS, jail
 * sentences, ...) is in game minutes. It used to be `totalTicks` on both sides
 * of the subtraction, which is fine at tick_speed 1 but at 4x turned a 360-minute
 * night into 360 ticks = 24 game hours: the whole town slept round the clock.
 */
export function isActionComplete(agent: AgentRow, nowMinutes: number): boolean {
  if (agent.current_action == null) return true;

  const actionType =
    typeof agent.current_action === 'object' ? agent.current_action.type : agent.current_action;

  // Walking agents are handled by the movement system — BUT if destination is null
  // (e.g. a stale or malformed walking action), treat as complete so the decision
  // system can assign a new action and unblock the agent.
  if (actionType === 'walking') {
    return agent.current_destination === null;
  }

  // Talking agents wait for conversation system to end — UNLESS needs are critical.
  // An agent with hunger or energy below the emergency threshold should bail out
  // of a conversation so the decision system can trigger an emergency override.
  if (actionType === 'talking') {
    const agentNeeds = db.select().from(needs).where(eq(needs.agent_id, agent.id)).get();
    if (agentNeeds) {
      const critical = CONFIG.NEEDS.THRESHOLDS.critical;
      if (agentNeeds.hunger < critical || agentNeeds.energy < critical) {
        return true; // interrupt conversation for emergency
      }
    }
    // A placeholder with no conversation behind it: the "talk to X" a player
    // nudge (suggest_talk / force_confront) queues after the walk to the
    // meeting point. It holds only while that queue entry is alive; once the
    // entry opens a conversation the action is replaced, and once it is dropped
    // or times out nothing would ever end the placeholder — both agents stood
    // frozen at the meeting point until hunger or energy went critical.
    if ((agent.current_action as { conversationId?: unknown }).conversationId == null) {
      return !isQueuedToTalk(agent.id);
    }
    return false;
  }

  // Idle with no duration = needs reassignment
  if (actionType === 'idle' && agent.action_duration === null) return true;

  // Check duration-based completion
  if (agent.action_duration !== null) {
    return (nowMinutes - agent.action_started) >= agent.action_duration;
  }

  // No duration set for non-walking action — treat as complete
  return true;
}

// --- Main Tick ---

/**
 * The decision phase: every active agent whose action is done picks the next
 * one, then co-located agents may strike up a chat and a constable may make an
 * arrest. Runs inside the phase's transaction, so the order of the steps (and
 * of their DB writes and `Math.random()` draws) is part of the behaviour.
 */
export function tick(world: WorldRow): void {
  const d = loadDecisionContext(world);

  for (const agent of d.activeAgents) {
    decideForAgent(agent, d);
  }

  queueLocationEncounters(d);
  // Chats at gatherings (lib/gatherings), after the chance meetings so a pair the
  // tavern already queued is not queued twice; seeded dice, not Math.random.
  queueGatheringEncounters(d);
  constableArrests(d);

  emitter.markDirty('agents.all');
}

/**
 * One agent's turn of the decision pass. Every early `return` here is a
 * `continue` of the per-agent loop this used to be the body of: the steps
 * after it are skipped for this agent only.
 */
function decideForAgent(agent: AgentRow, d: DecisionTickContext): void {
  const { world, allLocations, needsMap, econMap, nowMinutes } = d;
  // Skip agents whose current action is still in progress
  if (!isActionComplete(agent, nowMinutes)) return;

  if (holdJailed(agent, d)) return;

  requestPlanIfDue(agent, world);

  // Fetch per-agent data from pre-loaded Maps
  const agentNeeds = needsMap.get(agent.id);
  if (!agentNeeds) return;

  const agentEcon = econMap.get(agent.id) ?? null;
  const critical = agentNeeds.thresholds?.critical ?? CONFIG.NEEDS.THRESHOLDS.critical;
  const mealPlan = (requested: number | undefined) => chooseMealTarget(
    agent, agentEcon, requested, allLocations, econMap, world.time, agentNeeds.hunger, critical,
  );
  const t: AgentTurn = { agent, agentNeeds, agentEcon, critical, mealPlan };

  let decision = chooseDecision(t, d);
  decision = eatBeforeBed(t, decision, nowMinutes);
  decision = validateAtTarget(agent, decision, d);

  const destination = resolveDestination(agent, decision, allLocations);
  startDecision(t, decision, destination, d);
  logZoneActivity(agent, decision);
  executeCrime(t, decision, d);
  queueSocialConversation(t, decision, d);
}

/**
 * Hold a jailed agent in the prison for this turn. True when the agent is
 * under arrest, and their turn ends there (with or without a prison to hold
 * them in).
 */
function holdJailed(agent: AgentRow, d: DecisionTickContext): boolean {
  const { allLocations, needsMap, nowMinutes } = d;
  // Jailed agents serve the sentence. This sits above every scoring tier on
  // purpose — the emergency override scores 9999 and would otherwise send a
  // starving prisoner walking out of the cell to find food.
  if (getAgentStates(agent.id).includes('arrested')) {
    const prisonLoc = allLocations.find(l => l.type === 'prison');
    if (prisonLoc) {
      // The jail feeds its prisoners (economy.ts serveMeal: 'ration'); a
      // sentence runs up to 48 game hours of the 72-hour starvation clock.
      const prisonerHunger = needsMap.get(agent.id)?.hunger ?? 100;
      const mealtime = prisonerHunger < CONFIG.NEEDS.THRESHOLDS.low;
      db.update(agents).set({
        current_action: mealtime ? { type: 'eating', locationId: prisonLoc.id } : { type: 'idle' },
        position: { x: prisonLoc.entry_point.x, y: prisonLoc.entry_point.y },
        current_destination: null,
        current_location: prisonLoc.id,
        action_started: nowMinutes,
        action_duration: 60,
        action_queue: [],
        current_path: null,
      }).where(eq(agents.id, agent.id)).run();
    }
    return true;
  }
  return false;
}

/** Ask for a day plan on waking, or when the plan is missing, stale or a fallback in the daytime. */
function requestPlanIfDue(agent: AgentRow, world: WorldRow): void {
  // Plan generation: trigger when waking up OR when plan is stale during daytime.
  // The wake-up path catches the normal case; the stale-plan path catches agents
  // who missed a sleep→wake cycle (e.g., sick, depressed, or stuck agents).
  const completedActionType = agent.current_action?.type;
  const sched = agent.schedule as { wakeTime?: number; sleepTime?: number } | null;
  const wakeTime = sched?.wakeTime ?? 7;
  const sleepTime = sched?.sleepTime ?? 22;
  const effSleepTime = sleepTime === 0 ? 24 : sleepTime;
  const isDaytime = effSleepTime > wakeTime
    ? (world.time.hour >= wakeTime && world.time.hour < effSleepTime)
    : !(world.time.hour >= effSleepTime && world.time.hour < wakeTime);
  const currentPlan = agent.daily_plan;
  const planIsStale = !currentPlan || currentPlan.day < (world.time.day ?? 1);
  // A fallback plan (the LLM failed) is re-requested like a missing one so it
  // gets upgraded once the LLM recovers. That makes this call fire on most
  // passes for such agents, which is fine: queueGeneration is a no-op while a
  // request is in flight or the agent's retry backoff is running.
  const planIsFallback = currentPlan?.source === 'fallback';
  const planClock = { day: world.time.day ?? 1, hour: world.time.hour, minute: world.time.minute };

  if (completedActionType === 'sleeping' && world.time.hour >= wakeTime) {
    planGenerator.queueGeneration(agent.id, planClock);
  } else if (isDaytime && (planIsStale || planIsFallback) && completedActionType !== 'dead') {
    // Catch-all: agent has no plan for today but it's daytime — generate one now
    planGenerator.queueGeneration(agent.id, planClock);
  }
}
