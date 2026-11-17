import { EventEmitter } from 'events';

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
}
