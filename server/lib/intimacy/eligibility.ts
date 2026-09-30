/**
 * The adults-only gate and the attraction check for everything intimate.
 *
 * Pure (no DB, no clock) so the client can import it and the tests can walk the
 * whole truth table. Every intimacy path (kiss, rendezvous, tryst, longing,
 * conception, flirt escalation) asks `isIntimacyEligible` and nothing else
 * decides who may be intimate with whom: weakening the age line here would
 * weaken it everywhere, which is why it is one function and a test enumerates it.
 */

/** Below this age nobody is ever a party to anything romantic-intimate. */
export const INTIMACY_MIN_AGE = 18;

/** `agents.orientation`. Stored as TEXT; `null` (a row from before the backfill) reads as straight. */
export type Orientation = 'straight' | 'gay' | 'bi';

export interface IntimacyParty {
  id: number;
  age: number;
  gender: string;
  orientation?: string | null;
  /** Missing reads as active: callers holding a partial row should not be punished for it. */
  is_active?: boolean;
}

/**
 * One-sided: would `self`, by orientation alone, be drawn to `other`'s gender?
 *
 * Used for the direction of a crush and for romance gain (a one-sided pull is
 * legitimate story: unrequited love). It is deliberately age-blind; the
 * adults-only rule is `isIntimacyEligible`'s, and romance gain adds its own age
 * check next to this call. An unknown orientation string reads as straight, the
 * same as null, so a hand-edited row can never widen who someone is drawn to.
 */
export function canBeAttractedTo(
  self: { gender: string; orientation?: string | null },
  other: { gender: string },
): boolean {
  if (self.orientation === 'bi') return true;
  if (self.orientation === 'gay') return self.gender === other.gender;
  return self.gender !== other.gender;
}

/**
 * Mutual: may these two be intimate at all? Both adults, both alive and in town,
 * two different people, and each drawn to the other's gender.
 */
export function isIntimacyEligible(a: IntimacyParty, b: IntimacyParty): boolean {
  if (a.id === b.id) return false;
  // Fail closed: a missing or non-numeric age (partial row, NULL column) is
  // never read as adult. `undefined < 18` is false and `"30" >= 18` is true, so
  // plain comparisons would let both through.
  if (!isAdultAge(a.age) || !isAdultAge(b.age)) return false;
  if (a.is_active === false || b.is_active === false) return false;
  return canBeAttractedTo(a, b) && canBeAttractedTo(b, a);
}

/**
 * A real, finite number of years at or above the line. Anything else is not an
 * adult. Exported so the romance-gain paths (attraction.ts, the relationship
 * tick's choke point) share this one fail-closed check instead of re-deriving
 * `age >= 18` and getting the missing-age case wrong.
 */
export function isAdultAge(age: unknown): boolean {
  return typeof age === 'number' && Number.isFinite(age) && age >= INTIMACY_MIN_AGE;
}
