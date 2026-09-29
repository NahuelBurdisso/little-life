import { db } from '../db';
import { worldState } from '../db/schema';

/**
 * The setup wizard's rules (src/components/setup/configRegistry.ts), as saved
 * with the world.
 *
 * `setup_config` is the durable copy: `setup.initialize` stores the whole
 * config there, and `restart` replays it. The copy it also wrote into the
 * clock JSON (`time.rules`) never survived the first tick — `advanceClock`
 * rebuilds `time` field by field — so nothing could read the rules and the
 * wizard's toggles did nothing (B20).
 *
 * Worlds without a saved config (the default seed, pre-wizard saves) and keys
 * a config predates read as the registry default.
 */
function worldRules(): Record<string, unknown> {
  const row = db.select({ setup_config: worldState.setup_config }).from(worldState).limit(1).get();
  const rules = row?.setup_config?.rules;
  return rules && typeof rules === 'object' ? (rules as Record<string, unknown>) : {};
}

/** "Death Enabled" (default on): whether agents can die of neglect, sickness, age or accidents. */
export function isDeathEnabled(): boolean {
  return worldRules().deathEnabled !== false;
}
