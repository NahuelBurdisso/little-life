/**
 * How one person close to a falling-out decides where they stand.
 *
 * Pure, with the rng injected, so the tests can walk the rule. One draw per
 * decision. The rule:
 *
 *   - each side pulls by the tie the decider holds to that principal (a wife
 *     sides with her husband), their regard and trust toward them, all scaled by
 *     loyalty (a loyal friend backs their own; a fickle one shrugs);
 *   - a moral person who KNOWS who was in the wrong (the decider holds the fact:
 *     the unpaid debt, the betrayal, the funeral skipped) holds it against them,
 *     however close they are — which is how a man can side against his brother;
 *   - someone close to BOTH is torn: that is a story whatever they choose. A
 *     peaceable one (warm, not aggressive) refuses to pick and may try to make
 *     peace (a `mediate` call); anyone else picks only when one side clearly
 *     outweighs the other;
 *   - a peaceable person stays out of it unless the gap is wide; for everyone
 *     else the chance of picking grows with the gap, so a lukewarm acquaintance
 *     of both mostly stays neutral.
 */
import type { TieKind } from '../socialCalls/pickCallers';
import { TIE_WEIGHT } from '../socialCalls/pickCallers';

export type Side = 'a' | 'b';
export type Stance = Side | 'neutral' | 'mediator';

/** What the decider is to one principal. */
export interface Leaning {
  /** Their closest tie to them (0 none, up to 1 a spouse): `TIE_WEIGHT`. */
  tie: number;
  /** Their own friendship toward that principal. */
  friendship: number;
  /** Their own trust toward that principal. */
  trust: number;
}

export interface DeciderInput {
  towardA: Leaning;
  towardB: Leaning;
  warmth: number;
  aggression: number;
  loyalty: number;
  morality: number;
  /** The principal the decider knows to be in the wrong, or null (not known, or nobody was). */
  knownCulprit: Side | null;
}

export interface Decision {
  stance: Stance;
  /** Close to both: torn between them (stress and a feed line). */
  torn: boolean;
}

/** A tie this close (a friend, or closer) to both principals makes someone torn. */
export const TORN_TIE = TIE_WEIGHT.friend;
/** ...as does this much regard for both. */
export const TORN_REGARD = 40;

/** Warm and not given to fights: would rather not pick a side at all. */
export function isPeaceable(p: Pick<DeciderInput, 'warmth' | 'aggression'>): boolean {
  return p.warmth >= 60 && p.aggression <= 40;
}

/** How hard one principal pulls the decider (before the moral judgement). */
export function pull(l: Leaning, loyalty: number): number {
  const raw = l.tie * 50 + Math.max(-60, Math.min(100, l.friendship)) * 0.5 + Math.max(-60, Math.min(100, l.trust)) * 0.2;
  return raw * (0.6 + loyalty / 125);
}

export function isTorn(i: Pick<DeciderInput, 'towardA' | 'towardB'>): boolean {
  return (i.towardA.tie >= TORN_TIE && i.towardB.tie >= TORN_TIE)
    || (i.towardA.friendship >= TORN_REGARD && i.towardB.friendship >= TORN_REGARD);
}

export function decideSide(i: DeciderInput, rng: () => number): Decision {
  let pa = pull(i.towardA, i.loyalty);
  let pb = pull(i.towardB, i.loyalty);
  // Who was in the wrong weighs on a moral person as much as a close tie does.
  const blame = (i.morality / 100) * 45;
  if (i.knownCulprit === 'a') pa -= blame;
  if (i.knownCulprit === 'b') pb -= blame;
  const diff = pa - pb;
  const gap = Math.abs(diff);
  const lean: Side = diff >= 0 ? 'a' : 'b';
  const torn = isTorn(i);
  const peaceable = isPeaceable(i);
  const roll = rng();

  if (torn && peaceable) {
    // Loves them both and hates a quarrel: tries to mend it, or keeps out of it.
    return { stance: roll < 0.4 + (i.warmth - 60) / 100 ? 'mediator' : 'neutral', torn };
  }
  if (peaceable) {
    // A friend of one who still wishes the other well may go between them.
    if (Math.min(i.towardA.friendship, i.towardB.friendship) >= 10 && Math.max(i.towardA.tie, i.towardB.tie) >= TORN_TIE && roll < 0.25) {
      return { stance: 'mediator', torn };
    }
    if (gap < 40) return { stance: 'neutral', torn };
  }
  if (torn && gap < 25) return { stance: 'neutral', torn };
  const chance = Math.max(0, Math.min(0.9, (gap - 10) / 50)) * (0.5 + i.loyalty / 200);
  return { stance: roll < chance ? lean : 'neutral', torn };
}

/** The tie weight of the closest of `ties` (0 when none of them matters here). */
export function tieWeightOf(ties: readonly TieKind[], allowed: readonly TieKind[]): number {
  let best = 0;
  for (const t of ties) if (allowed.includes(t)) best = Math.max(best, TIE_WEIGHT[t]);
  return best;
}
