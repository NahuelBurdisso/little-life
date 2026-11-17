/**
 * Row types and the per-phase read cache shared by the states phase
 * (../states.ts) and its trigger and effect handlers.
 */

import { db, getTableWriteVersion } from '../../../db';
import {
  agents,
  needs as needsTable,
  locations,
  economy as economyTable,
} from '../../../db/schema';
import { AgentStateRowsSnapshot } from '../../../lib/states';
import { RowsByAgentSnapshot } from '../../../lib/rowsByAgentSnapshot';

export type AgentRow = typeof agents.$inferSelect;
export type NeedsRow = typeof needsTable.$inferSelect;
export type EconomyRow = typeof economyTable.$inferSelect;

/**
 * Reads the states phase used to repeat per agent (and per step), answered from
 * one query each. Built fresh by every `statesTick()` call, so nothing in it
 * outlives the phase's transaction.
 */
export interface StatesTickContext {
  /** agent_states rows; re-read only after a write (AgentStateRowsSnapshot). */
  states: AgentStateRowsSnapshot;
  /**
   * The agent's needs row, from a snapshot re-read only after a write to
   * `needs`. Read per agent twice a tick (conditional exits, death check); the
   * snapshot still sees a mood a cascade rule or a side effect just changed.
   */
  needsOf(agentId: number): NeedsRow | undefined;
  /**
   * The agent's economy row, from a snapshot re-read only after a write to
   * `economy`. The debt trigger read money and pantry per agent every tick;
   * gifts, gambling and theft write it mid-phase, and the snapshot sees them.
   */
  economyOf(agentId: number): EconomyRow | undefined;
  /**
   * economy.job per agent. No tick code changes a job (the setup wizard and
   * nudges create economy rows; nothing updates `job`), so one read serves the
   * whole phase. It was read per agent twice a tick (death check, clinic) plus
   * once per bystander whenever someone sick shared a room.
   */
  jobOf(agentId: number): string | undefined;
  /** locations.type, fixed at worldgen. */
  locationType(locationId: number): string | undefined;
}

export function createStatesTickContext(): StatesTickContext {
  let jobs: Map<number, string> | null = null;
  let locationTypes: Map<number, string> | null = null;
  // idx_needs_agent_id is UNIQUE: one row per agent, so `[0]` is the `.get()`.
  const needs = new RowsByAgentSnapshot<NeedsRow>(
    () => getTableWriteVersion('needs'),
    () => db.select().from(needsTable).all(),
    (row) => row.agent_id,
  );
  // idx_economy_agent_id is UNIQUE too.
  const economy = new RowsByAgentSnapshot<EconomyRow>(
    () => getTableWriteVersion('economy'),
    () => db.select().from(economyTable).all(),
    (row) => row.agent_id,
  );
  return {
    states: new AgentStateRowsSnapshot(),
    needsOf: (agentId) => needs.forAgent(agentId)[0],
    economyOf: (agentId) => economy.forAgent(agentId)[0],
    jobOf(agentId) {
      jobs ??= new Map(
        db.select({ agent_id: economyTable.agent_id, job: economyTable.job }).from(economyTable).all()
          .map((e) => [e.agent_id, e.job]),
      );
      return jobs.get(agentId);
    },
    locationType(locationId) {
      locationTypes ??= new Map(
        db.select({ id: locations.id, type: locations.type }).from(locations).all().map((l) => [l.id, l.type]),
      );
      return locationTypes.get(locationId);
    },
  };
}
