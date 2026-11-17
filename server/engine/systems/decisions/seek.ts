/**
 * Walks to a partner: a pending proposal, an agreed tryst, a rendezvous invitation.
 */

import { effectiveSleepWindow, inSleepWindow } from '../../../lib/sleepSchedule';
import { PersonalityProfile } from '../../../lib/personality';
import { getEffectivePersonality } from '../../../lib/states';
import { PROPOSAL_SEEK_SCORE, canSeekPartner, inNoProposalState, type SeekParty } from '../../../lib/milestonesEngine';
import { RENDEZVOUS_SEEK_SCORE } from '../../../lib/intimacy/rendezvous';
import { TRYST_SEEK_SCORE, startSneakHome, trystStepFor } from '../../../lib/intimacy/tryst';
import { isAdultContent } from '../../../lib/worldRules';
import type { AgentRow, LocationRow, ScoredAction } from './types';
import { nearestLocation } from './helpers';

/**
 * The walk to the partner a pending proposal calls for, or null while it should
 * wait (someone asleep, on shift, or in a state that rules it out — see
 * canSeekPartner). Same shape as a comfort visit: to wherever the partner is,
 * or the square when they are out in the open.
 */
export function proposalSeekDecision(
  proposer: AgentRow,
  partner: AgentRow,
  allLocations: LocationRow[],
  hour: number,
  proposerStates: readonly string[],
  partnerStates: readonly string[],
): ScoredAction | null {
  if (!canSeekPartner(seekParty(proposer, hour, proposerStates), seekParty(partner, hour, partnerStates))) return null;
  return {
    action: 'socializing',
    score: PROPOSAL_SEEK_SCORE,
    targetLocationId: partner.current_location ?? nearestLocation(partner.position, allLocations, 'town_square')?.id,
    targetAgentId: partner.id,
    source: 'proposal_seek',
  };
}

/**
 * What an agreed tryst, or the night after one, asks of this agent (adult layer,
 * score 6350), or null while it asks nothing. The rules are lib/intimacy/tryst.ts's
 * (`trystStepFor`); this turns a step into a decision:
 *  - `meet` / `stay`: idle at the venue (a 10-minute idle, re-decided until the
 *    pair are both there and the pass starts the evening);
 *  - `sleep`: bed where they are (the sleeping validation below accepts it: the
 *    guest's `sleepTargetFor` is that house tonight);
 *  - `sneak_home`: walk home with `zoneActivity: 'sneak_home'` (the zone verb rides
 *    on `source`, see `zoneVerbOf`); at dawn this also starts the witness watch.
 * Always null with the `adultContent` rule off. Someone in no state for romance
 * (sick, grieving...) or on shift does not go to the venue.
 */
export function trystDecision(
  agent: AgentRow,
  hour: number,
  nowMinutes: number,
  states: readonly string[],
): ScoredAction | null {
  if (!isAdultContent()) return null;
  const personality = getEffectivePersonality(agent.id) ?? agent.personality as PersonalityProfile | null;
  const awake = !inSleepWindow(effectiveSleepWindow(agent.schedule, personality, agent.workplace != null), hour);
  const step = trystStepFor(agent, { awake });
  if (!step) return null;
  switch (step.kind) {
    case 'meet': {
      const onShift = !!agent.workplace && hour >= agent.schedule.workStart && hour < agent.schedule.workEnd;
      if (onShift || inNoProposalState(states)) return null;
      return { action: 'idle', score: TRYST_SEEK_SCORE, targetLocationId: step.locationId };
    }
    case 'stay':
      return { action: 'idle', score: TRYST_SEEK_SCORE, targetLocationId: step.locationId };
    case 'sleep':
      return { action: 'sleeping', score: TRYST_SEEK_SCORE, targetLocationId: step.locationId };
    case 'sneak_home':
      if (step.dawn) startSneakHome(agent.id, nowMinutes);
      return { action: 'idle', score: TRYST_SEEK_SCORE, targetLocationId: step.locationId, source: 'sneak_home' };
  }
}

/** What `canSeekPartner` needs to know about one of the two (shared by the proposal and rendezvous walks). */
function seekParty(a: AgentRow, hour: number, states: readonly string[]): SeekParty {
  const personality = getEffectivePersonality(a.id) ?? a.personality as PersonalityProfile | null;
  return {
    action: (a.current_action as { type?: string } | null)?.type ?? 'idle',
    inSleepWindow: inSleepWindow(effectiveSleepWindow(a.schedule, personality, a.workplace != null), hour),
    onShift: !!a.workplace && hour >= a.schedule.workStart && hour < a.schedule.workEnd,
    notNow: inNoProposalState(states),
  };
}

/**
 * The walk to the lover a pending rendezvous invitation calls for (adult layer,
 * score 6300: above the day plan, below a pending proposal), or null while it
 * should wait: the same guards as a proposal (canSeekPartner: nobody asleep, on
 * shift, or in a state that rules it out). Always null with the `adultContent`
 * rule off. Same shape as `proposalSeekDecision`.
 */
export function rendezvousSeekDecision(
  asker: AgentRow,
  partner: AgentRow,
  allLocations: LocationRow[],
  hour: number,
  askerStates: readonly string[],
  partnerStates: readonly string[],
): ScoredAction | null {
  if (!isAdultContent()) return null;
  if (!canSeekPartner(seekParty(asker, hour, askerStates), seekParty(partner, hour, partnerStates))) return null;
  return {
    action: 'socializing',
    score: RENDEZVOUS_SEEK_SCORE,
    targetLocationId: partner.current_location ?? nearestLocation(partner.position, allLocations, 'town_square')?.id,
    targetAgentId: partner.id,
    source: 'rendezvous_seek',
  };
}
