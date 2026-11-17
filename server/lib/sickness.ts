/**
 * An illness nobody treats can take a turn for the worse, and a grave one can kill.
 *
 * Why this exists: `sick` lasts 6-24 game hours and the only death rule was "sick for
 * more than 5 days", which no state ever reached, so sickness was a slow walk and a
 * day in bed and never a stake. Now an untreated illness has a small chance per game
 * minute to worsen: severity up a step and half a day added. That alone sends the
 * patient to the clinic (decisions/schedule.ts goes there above severity 0.4), so in a town
 * with a doctor it is a scare and a reason to be grateful. Two turns for the worse
 * with nobody treating it is grave, and only then is there a death hazard, and only
 * while still untreated. The doctor dying, or sitting in jail, is what makes a fever
 * dangerous: the player can see it coming and can act.
 *
 * Pure: the callers (engine/systems/states/effects.ts, lib/lifeEventsEngine.ts) own the DB.
 * All rates are per GAME MINUTE; roll them through `chancePerTick`.
 */

export const SICKNESS_TURN = {
  /** Untreated, ~2% per game hour: about one episode in five worsens once. */
  WORSEN_PER_MINUTE: 0.00035,
  /** The old (65+) worsen twice as readily. */
  FRAIL_AGE: 65,
  FRAIL_MULTIPLIER: 2,
  SEVERITY_STEP: 0.2,
  /** Game minutes added to the illness by each turn for the worse. */
  EXTEND_MINUTES: 720,
  /** Turns for the worse after which the illness is grave. */
  GRAVE_TURNS: 2,
  GRAVE_SEVERITY: 0.75,
  /** Grave and untreated: ~2.4% per game hour, about a quarter over a 12 h extension. */
  GRAVE_DEATH_PER_MINUTE: 0.0004,
  /** A healer's visit counts as treatment for this long (game minutes). */
  TREATED_GRACE_MINUTES: 180,
} as const;

export interface SickStateLike {
  severity: number;
  duration: number;
  metadata: unknown;
}

function metaOf(state: Pick<SickStateLike, 'metadata'>): Record<string, unknown> {
  return state.metadata && typeof state.metadata === 'object' ? (state.metadata as Record<string, unknown>) : {};
}

/** How many times this illness has turned for the worse. */
export function turnsForTheWorse(state: Pick<SickStateLike, 'metadata'>): number {
  const n = metaOf(state).worsened;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Was a healer with the patient within the grace window? */
export function recentlyTreated(state: Pick<SickStateLike, 'metadata'>, nowMinutes: number): boolean {
  const at = metaOf(state).treatedAt;
  return typeof at === 'number' && nowMinutes - at <= SICKNESS_TURN.TREATED_GRACE_MINUTES;
}

/**
 * Chance per game minute that the illness worsens. 0 while treated;
 * `rateMultiplier` is the world's Sickness Rate rule (0 turns it off).
 */
export function worsenChancePerMinute(input: { treated: boolean; age: number; rateMultiplier: number }): number {
  if (input.treated) return 0;
  const frail = input.age >= SICKNESS_TURN.FRAIL_AGE ? SICKNESS_TURN.FRAIL_MULTIPLIER : 1;
  return SICKNESS_TURN.WORSEN_PER_MINUTE * frail * Math.max(0, input.rateMultiplier);
}

/** The illness after one turn for the worse. */
export function worsen(state: SickStateLike): { severity: number; duration: number; metadata: Record<string, unknown> } {
  return {
    severity: Math.min(1, state.severity + SICKNESS_TURN.SEVERITY_STEP),
    duration: state.duration + SICKNESS_TURN.EXTEND_MINUTES,
    metadata: { ...metaOf(state), worsened: turnsForTheWorse(state) + 1 },
  };
}

export function isGravelyIll(state: Pick<SickStateLike, 'severity' | 'metadata'>): boolean {
  return turnsForTheWorse(state) >= SICKNESS_TURN.GRAVE_TURNS && state.severity >= SICKNESS_TURN.GRAVE_SEVERITY;
}

/** Death hazard per game minute: only a grave illness nobody is treating. */
export function graveDeathChancePerMinute(state: Pick<SickStateLike, 'severity' | 'metadata'>, nowMinutes: number): number {
  if (!isGravelyIll(state) || recentlyTreated(state, nowMinutes)) return 0;
  return SICKNESS_TURN.GRAVE_DEATH_PER_MINUTE;
}
