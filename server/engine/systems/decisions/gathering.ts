/**
 * Gatherings (lib/gatherings) in the decision pass: the pull to the venue, the
 * hold once there, and the chats between people at it.
 *
 * The existing crowd pull (phases.ts `eventCrowdPhase`) sits below the day plan
 * (6000), work (4000 in the schedule) and sleep, so with the LLM planning every
 * hour residents ignored events altogether. A gathering's invitations come in
 * three strengths (lib/gatherings/types.ts `InviteLevel`), each placed in
 * chooseDecision where its score belongs:
 *
 *   must   — 6550, right after the resident's own wedding/christening: leaves a
 *            work shift, never sleep unless the kind wakes people (a fire);
 *   should — 6100, just above the day plan: never off a shift (unless the kind
 *            says, as a fire does), never out of bed;
 *   may    — 3850, beside the event crowd pull, rolled per tick through
 *            chancePerTick so the pull is the same in game time at any speed.
 *
 * Once at the venue a resident is held there (the same decision, re-issued at the
 * `should` tier, or `must`) until the window ends or their stay is up — no bouncing
 * in and out every ten minutes. Emergencies run before all of this, so a starving
 * mourner still goes to eat.
 *
 * Dice: seeded per gathering, agent and minute (lib/gatherings/common.ts): tests
 * sequence the Math.random() draws of freeTime.ts and social.ts, and these
 * phases run in between.
 */

import { db } from '../../../db';
import { conversationQueue } from '../../../db/schema';
import { chancePerTick } from '../../../lib/gameClock';
import { getAgentStates } from '../../../lib/states';
import { chooseTier, hasDramaticState } from '../../../lib/conversationTier';
import { isAnyWatched } from '../../../lib/spotlight';
import { queueMaxWait } from '../../../lib/conversationPacing';
import {
  allGatherings, gatheringFor, gatheringKind, leadOf, markPresent, NEAR_VENUE_PX,
} from '../../../lib/gatherings/engine';
import { rngFor } from '../../../lib/gatherings/common';
import { gatheringTrigger } from '../../../lib/gatherings/topics';
import { opposedInTownFeud } from '../../../lib/factions/store';
import type { Gathering, InviteLevel } from '../../../lib/gatherings/types';
import type { AgentRow, ScoredAction } from './types';
import { seekParty } from './seek';
import { isCommuteDue } from './schedule';
import { getRelationshipValues } from './helpers';
import type { DecisionTickContext } from './context';

export const GATHERING_MUST_SCORE = 6550;
export const GATHERING_SHOULD_SCORE = 6100;
export const GATHERING_MAY_SCORE = 3850;

/** In no state to go: ill, jailed, too low to leave the house. */
const NOT_NOW = new Set(['sick', 'arrested', 'depressed']);

export type GatheringTier = 'must' | 'should' | 'may';

function actionOf(a: Pick<AgentRow, 'current_action'>): string {
  return (a.current_action as { type?: string } | null)?.type ?? 'idle';
}

function atVenue(agent: AgentRow, g: Gathering, d: DecisionTickContext): boolean {
  if (agent.current_location === g.venueLocationId) return true;
  const venue = d.allLocations.find((l) => l.id === g.venueLocationId);
  return venue != null && Math.hypot(agent.position.x - venue.entry_point.x, agent.position.y - venue.entry_point.y) <= NEAR_VENUE_PX;
}

/**
 * The walk to (or the stay at) the gathering this agent is asked to, at this
 * tier of chooseDecision, or null. An arrival is held at the `should` tier (a
 * `must` at its own), so the plan doesn't pull them straight out again.
 */
export function gatheringPhase(agent: AgentRow, d: DecisionTickContext, tier: GatheringTier): ScoredAction | null {
  const { nowMinutes, world, allLocations } = d;
  const found = gatheringFor(agent.id, nowMinutes);
  if (!found) return null;
  const { g, inv } = found;
  const def = gatheringKind(g.kind);
  if (!def) return null;
  if (nowMinutes < Math.max(g.startMin - leadOf(def), inv.notBeforeMin) || nowMinutes >= g.endMin) return null;

  const here = atVenue(agent, g, d);
  if (here && nowMinutes >= g.startMin) markPresent(g, [agent.id], nowMinutes);
  const arrived = inv.arrivedAtMin != null;
  const stay = def.stayMin?.[inv.level];
  if (arrived && stay != null && nowMinutes >= inv.arrivedAtMin! + stay) {
    inv.doneAtMin = nowMinutes;
    return null;
  }

  // Which tier this invitation answers at: its own level, except that anyone
  // already there is held above the day plan.
  const level: InviteLevel = inv.level === 'must' ? 'must' : arrived ? 'should' : inv.level;
  if (level !== tier) return null;

  const states = getAgentStates(agent.id) as string[];
  if (states.some((s) => NOT_NOW.has(s))) return null;
  const me = seekParty(agent, world.time.hour, states);
  if (me.inSleepWindow && !def.wakes) return null;
  const leavesShift = (def.leavesShift ?? ['must']).includes(inv.level);
  if (!leavesShift && (me.onShift || actionOf(agent) === 'working')) return null;
  if (!leavesShift && tier === 'should' && isCommuteDue(agent, allLocations, world.time.hour, world.time.minute)) return null;

  if (tier === 'may') {
    const p = def.mayChancePerMin ?? 0;
    if (!(p > 0) || rngFor(`may|${g.id}|${agent.id}|${nowMinutes}`)() >= chancePerTick(p, world.tick_speed)) return null;
  }

  const venue = allLocations.find((l) => l.id === g.venueLocationId);
  const label = def.label(g, venue?.name ?? 'the square');
  const score = level === 'must' ? GATHERING_MUST_SCORE : level === 'should' ? GATHERING_SHOULD_SCORE : GATHERING_MAY_SCORE;
  // A kind's errand for this person at the venue (a pickpocket working the market crowd):
  // the existing crime path resolves it as the action starts (crime.ts executeCrime).
  const errand = here ? def.errandFor?.(g, agent.id, nowMinutes) ?? null : null;
  if (errand) {
    return {
      action: 'idle', score, targetLocationId: g.venueLocationId, source: errand.source,
      ...(errand.targetAgentId != null ? { targetAgentId: errand.targetAgentId } : {}),
      description: label.there,
    };
  }
  return {
    action: 'socializing',
    score,
    targetLocationId: g.venueLocationId,
    source: 'gathering',
    description: label.there,
    walkDescription: label.walking,
  };
}

/** Whether this agent's strongest gathering is a `must` that is on now (social calls yield to it). */
export function hasMustGathering(agent: AgentRow, d: DecisionTickContext): boolean {
  const found = gatheringFor(agent.id, d.nowMinutes);
  if (!found || found.inv.level !== 'must') return false;
  const def = gatheringKind(found.g.kind);
  return def != null && d.nowMinutes >= found.g.startMin - leadOf(def) && d.nowMinutes < found.g.endMin;
}

/**
 * Chats at gatherings: per open gathering, at most one new pair per tick among
 * the free people at the venue, at the kind's rate (default 6% per game
 * minute — a funeral is chattier than a tavern evening, where it's 15% for the
 * whole room). Queued with `trigger_reason: 'gathering:<kind>'` and the
 * gathering's topic, so the template tier plays the gathering's scripts and the
 * LLM opener talks about the occasion. Strictly two people, like every chat.
 */
export function queueGatheringEncounters(d: DecisionTickContext): void {
  const { world, activeAgents, allRelationships, needsMap, allQueuedConvos, allActiveConvos, pairOnCooldown, tierBudget, nowMinutes } = d;
  for (const g of allGatherings()) {
    if (g.status !== 'open' || nowMinutes < g.startMin || nowMinutes >= g.endMin) continue;
    const def = gatheringKind(g.kind);
    if (!def) continue;
    const busy = new Set<number>();
    for (const q of allQueuedConvos) for (const id of q.participants as number[]) busy.add(id);
    for (const c of allActiveConvos) for (const id of c.participants as number[]) busy.add(id);
    const free = activeAgents.filter((a) => {
      const act = actionOf(a);
      if (act === 'talking' || act === 'sleeping' || act === 'working' || act === 'walking') return false;
      if ((a.current_action as { zoneActivity?: string } | null)?.zoneActivity === 'tryst') return false;
      return !busy.has(a.id) && atVenue(a, g, d);
    });
    if (free.length < 2) continue;
    const rng = rngFor(`talk|${g.id}|${nowMinutes}`);
    if (rng() >= chancePerTick(def.encounterPerMin ?? 0.06, world.tick_speed)) continue;
    const i = Math.floor(rng() * free.length);
    let j = Math.floor(rng() * (free.length - 1));
    if (j >= i) j++;
    const [a, b] = [free[i], free[j]];
    // Opposite camps of a town feud don't sit down together (lib/factions). Checked
    // after the draws, so the dice sequence is the same whoever is feuding.
    if (pairOnCooldown(a.id, b.id) || opposedInTownFeud(a.id, b.id)) continue;
    const aStates = getAgentStates(a.id);
    const bStates = getAgentStates(b.id);
    if ((aStates as string[]).includes('depressed') || (bStates as string[]).includes('depressed')) continue;
    const rel = getRelationshipValues(allRelationships, a.id, b.id);
    const { tier, priority, maxWaitGameMin } = chooseTier({
      ...tierBudget,
      source: 'encounter',
      friendship: rel?.friendship ?? 0,
      romance: rel?.romance ?? 0,
      mood: needsMap.get(a.id)?.mood ?? 50,
      dramaticState: hasDramaticState(aStates, bStates),
      watched: isAnyWatched([a.id, b.id]),
      basePriority: 55,
    });
    allQueuedConvos.push(db.insert(conversationQueue).values({
      participants: [a.id, b.id],
      tier,
      priority,
      trigger_reason: gatheringTrigger(g.kind),
      topic: def.topic(g),
      queued_at: Date.now(),
      max_wait: queueMaxWait(maxWaitGameMin),
    }).returning().get());
  }
}
