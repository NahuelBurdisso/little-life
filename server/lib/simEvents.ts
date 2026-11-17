import { EventEmitter } from 'events';
import type { DepartureReason } from './populationFlow';

const simEvents = new EventEmitter();
simEvents.setMaxListeners(30);

export { simEvents };

/**
 * Payloads of the newer sim events, by name. Emit sites type their payload as
 * `SimEventPayloads['name']` so the shape a listener reads is written down in
 * one place. Older events (most of them) predate this map and are not in it.
 */
export interface SimEventPayloads {
  /** A sentence ran out (engine/systems/states.ts). `locationId`: the prison they walk out of. */
  'crime:released': { agentId: number; locationId: number | null };
  /**
   * An untreated illness has just turned grave (engine/systems/states/effects.ts):
   * once per illness, when `metadata.grave` is first set. `severity` is the new one.
   */
  'health:grave': { agentId: number; severity: number };
  /**
   * A resident has started to think about leaving town (lib/populationFlow.ts);
   * they decide the next day. `reason` is the first of `reasons`.
   */
  'life:thinking_of_leaving': { agentId: number; reason: DepartureReason; reasons: DepartureReason[] };
  /** A resident who was thinking of leaving has decided to stay (lib/populationFlow.ts). */
  'life:decided_to_stay': { agentId: number };
  /** A baby was born (lib/family.ts): the parents still in town. Friends come to congratulate (lib/socialCalls). */
  'family:birth': { childId: number; childName: string; parentIds: number[] };
  /** A proposal was accepted (lib/milestonesEngine.ts). The news is public at once. */
  'life:engaged': { proposerId: number; answererId: number };
  /** The election count (lib/townCalendar.ts): the winner and the candidates who lost. */
  'civic:election': { winnerId: number; loserIds: number[] };
  /**
   * A resident has made up their mind to leave town (lib/populationFlow.ts): they set off at
   * `leaveAtMin` (game minutes). The town's chance to see them off (lib/gatherings send-off).
   */
  'life:leaving_decided': { agentId: number; leaveAtMin: number };
  /**
   * A world event has just started (engine/systems/events.ts `startWorldEvent`, the one entry
   * point): lib/gatherings wraps the ones people gather for (a wedding, market day, a fire).
   * `startedAtMin` is game minutes, `durationHours` game hours.
   */
  'world:event_started': {
    eventId: number; type: string; triggeredBy: string; locationId: number | null; startedAtMin: number; durationHours: number; name: string;
  };
}
