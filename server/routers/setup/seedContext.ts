/**
 * The state every seeding step shares. `seedWorld` (routers/setup.ts) builds
 * one `SeedContext` and hands it to the steps in the sibling modules, in order.
 *
 * The two config types are imported back from routers/setup.ts as types only
 * (erased at runtime, so no import cycle) and re-exported, so the step modules
 * never import the router file.
 */
import { gameMinutes } from '../../lib/gameClock';
import type { generateWorld } from '../../lib/worldgen';
import type { SetupConfig, Scenario } from '../setup';

export type { SetupConfig, Scenario };

type GeneratedWorld = ReturnType<typeof generateWorld>;

/**
 * What the seeding steps share. Built once by `seedWorld`; the two maps start
 * empty and are filled by `insertLocations` and `insertAgents`, and every later
 * step resolves names through them, so the steps must run in `seedWorld`'s order.
 */
export interface SeedContext {
  config: SetupConfig;
  genResult: GeneratedWorld;
  /** The `scenario` parameter of `seedWorld` (null when no sliders were posted). */
  scenario: Scenario | null;
  /** One wall-clock stamp for every `Date.now()` column the seed writes. */
  now: number;
  /** The world's starting game minute: the clock for starting mood modifiers and the hook goal. */
  startMinute: number;
  /** Location name → id, filled by `insertLocations`. */
  locationMap: Map<string, number>;
  /** Agent name → id, filled by `insertAgents`. */
  agentMap: Map<string, number>;
}

/**
 * The shared state for one seed. `startMinute` is computed here rather than at
 * step 4 where it is first read: `gameMinutes` is pure, so the value is the same,
 * and the hook history at step 10b reads it too.
 */
export function createSeedContext(
  config: SetupConfig,
  genResult: GeneratedWorld,
  scenario: Scenario | null,
): SeedContext {
  return {
    config,
    genResult,
    scenario,
    now: Date.now(),
    startMinute: gameMinutes({ day: config.world.startDay, hour: config.world.startHour, minute: 0 }),
    locationMap: new Map<string, number>(),
    agentMap: new Map<string, number>(),
  };
}
