/**
 * How much a conversation's romance actually lands, per direction.
 *
 * Pure (no DB, no clock). Two independent layers sit on top of the raw
 * sensuality/sentiment maths in relationshipImpact.ts:
 *
 *  - A hard gate, `mayRomanceGrow`: adults only, and the feeler must be drawn to
 *    the target's gender. This is the authoritative guarantee; the relationship
 *    tick applies the same gate to every queued romance event (see
 *    engine/systems/relationships.ts) so gifts, seduction, ripple rules and the
 *    rest cannot route around it.
 *  - A soft shape, chemistry x age gap, that only scales a gain that is already
 *    allowed: some pairs simply click, and a very wide age gap cools things.
 */

import { stringToSeed, makeRng } from '../worldgen/rng';
import { canBeAttractedTo, isAdultAge } from './eligibility';

/** The bits of an agent row the romance maths needs. */
export interface RomanceParty {
  id: number;
  age: number;
  gender: string;
  orientation?: string | null;
}

/** Chemistry range: the coldest pair gains 0.6x, the warmest 1.4x. */
const CHEMISTRY_MIN = 0.6;
const CHEMISTRY_MAX = 1.4;

/** Up to this many years apart costs nothing; from there the factor falls linearly. */
const AGE_GAP_FREE_YEARS = 10;
/** At this gap (and beyond) the factor bottoms out at AGE_GAP_FLOOR. */
const AGE_GAP_FLOOR_YEARS = 30;
const AGE_GAP_FLOOR = 0.5;

/**
 * Deterministic 0.6..1.4 for a pair in a world ("some pairs just click").
 * Symmetric (sorted pair) so both directions share the same spark, and keyed
 * by the world seed so a Restart with a new seed reshuffles who clicks. Hashed
 * rather than stored: no state to lose on restart or to register as a cache.
 */
export function chemistry(aId: number, bId: number, worldSeed: string | number): number {
  const lo = Math.min(aId, bId);
  const hi = Math.max(aId, bId);
  const unit = makeRng(stringToSeed(`chemistry:${worldSeed}:${lo}:${hi}`)).next();
  return CHEMISTRY_MIN + unit * (CHEMISTRY_MAX - CHEMISTRY_MIN);
}

/** 1 up to a ten-year gap, linearly down to 0.5 at thirty years or more. */
export function ageGapFactor(ageA: number, ageB: number): number {
  const gap = Math.abs(ageA - ageB);
  if (gap <= AGE_GAP_FREE_YEARS) return 1;
  if (gap >= AGE_GAP_FLOOR_YEARS) return AGE_GAP_FLOOR;
  const t = (gap - AGE_GAP_FREE_YEARS) / (AGE_GAP_FLOOR_YEARS - AGE_GAP_FREE_YEARS);
  return 1 - t * (1 - AGE_GAP_FLOOR);
}

/**
 * May `self`'s romance toward `other` grow at all? Both adults (fail-closed on
 * a missing or non-numeric age) and `self` drawn to `other`'s gender. One-sided
 * on purpose: unrequited love is legitimate story, but a minor on either side
 * is never one.
 */
export function mayRomanceGrow(
  self: Pick<RomanceParty, 'age' | 'gender' | 'orientation'>,
  other: Pick<RomanceParty, 'age' | 'gender'>,
): boolean {
  return isAdultAge(self.age) && isAdultAge(other.age) && canBeAttractedTo(self, other);
}

/**
 * The factor applied to a POSITIVE romance gain of `self` toward `other`:
 * 0 when the gate says no, otherwise chemistry x age gap. Negative deltas are
 * never scaled by callers (a bad chat still cools a crush).
 */
export function romanceGainMultiplier(
  self: RomanceParty,
  other: RomanceParty,
  worldSeed: string | number,
): number {
  if (!mayRomanceGrow(self, other)) return 0;
  return chemistry(self.id, other.id, worldSeed) * ageGapFactor(self.age, other.age);
}
