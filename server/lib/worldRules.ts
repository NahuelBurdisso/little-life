import { z } from 'zod';
import { db } from '../db';
import { worldState } from '../db/schema';
import {
  CONTAGION_MULTIPLIER,
  DEFAULT_LIVE_RULES,
  DRAMA_LEVELS,
  DRAMA_MULTIPLIER,
  DRAMA_SNAP_THRESHOLD_SCALE,
  POPULATION_TARGET_MAX,
  POPULATION_TARGET_MIN,
  SICKNESS_LEVELS,
  SICKNESS_MULTIPLIER,
  type LiveRules,
} from '../data/rulesCatalog';

export type { LiveRules } from '../data/rulesCatalog';

/**
 * The world's rules as the running sim reads them: the wizard's choices
 * (src/components/setup/configRegistry.ts), then any live overrides the
 * player set since (the Storyteller, `world.setRules`).
 *
 * `setup_config` is the durable copy of the wizard: `setup.initialize` stores
 * the whole config there, and `restart` replays it. The copy it also wrote into
 * the clock JSON (`time.rules`) never survived the first tick — `advanceClock`
 * rebuilds `time` field by field — so nothing could read the rules and the
 * wizard's toggles did nothing (B20).
 *
 * Overrides live in their own column, `world_state.rule_overrides`, rather than
 * being written back into `setup_config`: that one is the scenario, and a
 * Restart replays it — a Storyteller click made mid-run should not become part
 * of the scenario, and Restart should give back the town the wizard built.
 * (The Storyteller's autoplay settings ride in the same column under
 * `autoplay`; see lib/autoplaySettings.ts. The rules reader ignores them.)
 * Both columns belong to the world row, so a world replace drops them together.
 *
 * Worlds without a saved config (the default seed, pre-wizard saves), keys a
 * config predates and values that are not one of the known options all read as
 * the default, never as a throw: a hand-edited or old config must not stop the
 * tick loop.
 *
 * Cached: several phases read the rules every tick. The cache is dropped by
 * `setRuleOverrides` and on every world replace (`clearPerWorldCaches`), the
 * only two ways either column changes while the server runs.
 */

let cached: LiveRules | null = null;

/** Keep only keys that are a valid value for their rule. */
function pickValid(raw: unknown): Partial<LiveRules> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<LiveRules> = {};
  if (typeof r.deathEnabled === 'boolean') out.deathEnabled = r.deathEnabled;
  if ((SICKNESS_LEVELS as readonly unknown[]).includes(r.sicknessRate)) out.sicknessRate = r.sicknessRate as LiveRules['sicknessRate'];
  if ((SICKNESS_LEVELS as readonly unknown[]).includes(r.contagionRate)) out.contagionRate = r.contagionRate as LiveRules['contagionRate'];
  if ((DRAMA_LEVELS as readonly unknown[]).includes(r.dramaIntensity)) out.dramaIntensity = r.dramaIntensity as LiveRules['dramaIntensity'];
  if (typeof r.populationFlow === 'boolean') out.populationFlow = r.populationFlow;
  if (r.populationTarget === null) out.populationTarget = null;
  else if (
    typeof r.populationTarget === 'number' && Number.isInteger(r.populationTarget)
    && r.populationTarget >= POPULATION_TARGET_MIN && r.populationTarget <= POPULATION_TARGET_MAX
  ) out.populationTarget = r.populationTarget;
  return out;
}

/** The current world's rules: defaults ← wizard ← live overrides. */
export function getRules(): LiveRules {
  if (cached) return cached;
  const row = db
    .select({ setup_config: worldState.setup_config, rule_overrides: worldState.rule_overrides })
    .from(worldState)
    .limit(1)
    .get();
  cached = {
    ...DEFAULT_LIVE_RULES,
    ...pickValid(row?.setup_config?.rules),
    ...pickValid(row?.rule_overrides),
  };
  return cached;
}

/** Drop the cached rules. Called on world replace; tests call it after writing the columns directly. */
export function clearRulesCache(): void {
  cached = null;
}

/**
 * What `world.setRules` accepts: any subset of the live rules, each checked
 * against its option list. Strict, so a typo'd key is an error instead of a
 * silent no-op.
 */
export const RuleOverridesSchema = z
  .object({
    deathEnabled: z.boolean(),
    sicknessRate: z.enum(SICKNESS_LEVELS),
    contagionRate: z.enum(SICKNESS_LEVELS),
    dramaIntensity: z.enum(DRAMA_LEVELS),
    populationFlow: z.boolean(),
    populationTarget: z.number().int().min(POPULATION_TARGET_MIN).max(POPULATION_TARGET_MAX).nullable(),
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Set at least one rule' });

export type RuleOverrides = z.infer<typeof RuleOverridesSchema>;

/**
 * Merge `patch` into the world's live overrides and return the resolved rules.
 * Throws when there is no world yet — there is nothing to apply rules to.
 */
export function setRuleOverrides(patch: RuleOverrides): LiveRules {
  const row = db
    .select({ id: worldState.id, rule_overrides: worldState.rule_overrides })
    .from(worldState)
    .limit(1)
    .get();
  if (!row) throw new Error('No world to set rules on');
  // `autoplay` (lib/autoplaySettings.ts) shares the column; carry it through.
  const autoplay = row.rule_overrides?.autoplay;
  const next = {
    ...(autoplay !== undefined ? { autoplay } : {}),
    ...pickValid(row.rule_overrides),
    ...RuleOverridesSchema.parse(patch),
  };
  db.update(worldState).set({ rule_overrides: next }).run();
  cached = null;
  return getRules();
}

// ─── What each rule means to the systems ─────────────────────────────────────

/** "Death Enabled" (default on): whether agents can die of neglect, sickness, age or accidents. */
export function isDeathEnabled(): boolean {
  return getRules().deathEnabled;
}

/** Scale on the hourly random-event roll and the dark cascade rules. */
export function dramaMultiplier(rules: LiveRules = getRules()): number {
  return DRAMA_MULTIPLIER[rules.dramaIntensity];
}

/** Scale on every agent's snap threshold (lower = snaps sooner). */
export function snapThresholdScale(rules: LiveRules = getRules()): number {
  return DRAMA_SNAP_THRESHOLD_SCALE[rules.dramaIntensity];
}

/** Scale on falling ill from the environment. 0 = never. */
export function sicknessMultiplier(rules: LiveRules = getRules()): number {
  return SICKNESS_MULTIPLIER[rules.sicknessRate];
}

/** Scale on catching it from someone nearby. 0 = never. */
export function contagionMultiplier(rules: LiveRules = getRules()): number {
  return CONTAGION_MULTIPLIER[rules.contagionRate];
}
