/**
 * Who goes to see someone, given what each candidate is to them.
 *
 * Pure (the DB half is ./ties.ts), with the rng injected so the tests can say
 * exactly who comes. The rule, the same for every kind:
 *
 *   - only candidates holding one of the kind's ties qualify (a spouse and a
 *     sister for a deathbed, any friend for a birthday, the neighbours for a
 *     newcomer); rivals and enemies never make a kind call, and nobody who is
 *     ill, jailed, gone or already on another call;
 *   - each is weighed by the closest tie they hold times their willingness,
 *     which is mostly warmth: a cold or busy person may simply not bother, and
 *     that asymmetry is the point. Who came and who didn't must be legible.
 *     Loyalty adds to it for the closest ties (a dutiful husband comes even if
 *     he is not a warm man);
 *   - a debt of gratitude (favours received from the target and not returned)
 *     raises that weight a little: kindness comes back;
 *   - candidates are taken closest first, each with a roll at that weight,
 *     until the kind's maximum: one rng draw per candidate considered.
 */

export type TieKind =
  | 'spouse' | 'partner' | 'fiance' | 'family' | 'housemate'
  | 'best_friend' | 'friend' | 'acquaintance' | 'coworker' | 'clique' | 'neighbour'
  /** Anyone in town: only the newcomer's welcome reaches this far. */
  | 'townsfolk';

/** How strongly each tie pulls someone to your door, before their character has its say. */
export const TIE_WEIGHT: Record<TieKind, number> = {
  spouse: 1,
  partner: 0.95,
  fiance: 0.95,
  family: 0.9,
  best_friend: 0.85,
  housemate: 0.6,
  friend: 0.6,
  // Someone they get on with but aren't close to: in a small town that still
  // brings a few to your door on a birthday or a sickbed, less readily.
  acquaintance: 0.4,
  clique: 0.4,
  coworker: 0.35,
  neighbour: 0.35,
  townsfolk: 0.2,
};

/** Ties that count as "close" for loyalty: duty brings these even when warmth would not. */
const DUTY_TIES: ReadonlySet<TieKind> = new Set(['spouse', 'partner', 'fiance', 'family']);

export interface CallerCandidate {
  id: number;
  ties: TieKind[];
  /** The candidate's friendship toward the target. */
  friendship: number;
  /** Rivals, enemies, estranged, or openly hostile (friendship below -10). */
  hostile: boolean;
  /** Ill, jailed, depressed, gone: in no state to go anywhere for anyone. */
  unavailable: boolean;
  /** Already promised another call (one at a time). */
  busy: boolean;
  warmth: number;
  loyalty: number;
  morality: number;
  curiosity: number;
  /** Their money, for the kinds that need a full purse (a loan). */
  money: number;
  age: number;
  /**
   * Favours the candidate owes the target (favorEngine `favorsOwed`): visits,
   * gifts, loans and rounds received and not yet returned. Optional so the
   * fixtures written before reciprocity need no change (missing = 0).
   */
  owes?: number;
}

/**
 * Owing the target this many favours makes the debt part of why someone comes
 * ("she sat with me when I was ill"): the call carries `payload.returning`, the
 * feed and the target's memory say so.
 */
export const RETURN_MIN = 2;

/**
 * 1 or more: a debt of gratitude makes someone readier to come, by 10% per
 * favour owed up to +40%. Below RETURN_MIN it is not a debt anyone feels.
 */
export function gratitude(owes: number | undefined): number {
  const o = owes ?? 0;
  return o >= RETURN_MIN ? 1 + Math.min(0.4, o * 0.1) : 1;
}

export interface PickSpec {
  ties: readonly TieKind[];
  /** Most callers to choose. */
  max: number;
  /** Scales every chance (a birthday is easier to forget than a deathbed). Default 1. */
  eagerness?: number;
  /** Personality pull besides warmth: curiosity brings people to meet a newcomer. */
  extraTrait?: 'curiosity' | 'loyalty';
  /** Candidates that must not be chosen (the mourners themselves, the patient's healer). */
  exclude?: ReadonlySet<number>;
  /** Callers younger than this are skipped (default 16: children don't make calls). */
  minAge?: number;
  /** Ceiling on any one candidate's chance (default 0.95: nobody is certain). */
  maxChance?: number;
}

/** 0..1: how readily this person goes out of their way, from their own character. */
export function willingness(c: Pick<CallerCandidate, 'warmth' | 'loyalty' | 'curiosity' | 'ties'>, extra?: PickSpec['extraTrait']): number {
  let w = 0.2 + 0.8 * (c.warmth / 100);
  if (c.ties.some((t) => DUTY_TIES.has(t))) w = Math.max(w, 0.3 + 0.6 * (c.loyalty / 100));
  if (extra === 'curiosity') w = Math.max(w, 0.2 + 0.7 * (c.curiosity / 100));
  if (extra === 'loyalty') w = Math.max(w, 0.2 + 0.7 * (c.loyalty / 100));
  return Math.max(0, Math.min(1, w));
}

/** The weight of the closest qualifying tie, or 0 when none qualifies. */
export function closestTie(c: Pick<CallerCandidate, 'ties'>, allowed: readonly TieKind[]): number {
  let best = 0;
  for (const t of c.ties) if (allowed.includes(t)) best = Math.max(best, TIE_WEIGHT[t]);
  return best;
}

/** Ids of the chosen callers, closest first. */
export function pickCallers(cands: readonly CallerCandidate[], spec: PickSpec, rng: () => number): number[] {
  const minAge = spec.minAge ?? 16;
  const eagerness = spec.eagerness ?? 1;
  const maxChance = spec.maxChance ?? 0.95;
  const scored = cands
    .filter((c) => !c.hostile && !c.unavailable && !c.busy && c.age >= minAge && !spec.exclude?.has(c.id))
    .map((c) => ({ c, tie: closestTie(c, spec.ties) }))
    .filter((x) => x.tie > 0)
    // Owing the target a kindness or two brings someone readier (reciprocity):
    // one more factor on the same score, so no extra draw and the order of the
    // draws only changes when someone actually owes.
    .map((x) => ({ id: x.c.id, score: x.tie * willingness(x.c, spec.extraTrait) * gratitude(x.c.owes), friendship: x.c.friendship }))
    // Closest first; equal ties go to the fonder one, then the lower id (stable for the tests).
    .sort((a, b) => b.score - a.score || b.friendship - a.friendship || a.id - b.id);

  const out: number[] = [];
  for (const s of scored) {
    if (out.length >= spec.max) break;
    if (rng() < Math.min(maxChance, s.score * eagerness)) out.push(s.id);
  }
  return out;
}

/**
 * Game-minute offsets for each chosen caller: the first after `firstMin`, the
 * rest `spacingMin` apart, each with up to `jitterMin` of slack. Visitors come
 * over hours or days, not all in one tick.
 */
export function staggerOffsets(count: number, firstMin: number, spacingMin: number, jitterMin: number, rng: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.round(firstMin + i * spacingMin + rng() * jitterMin));
  return out;
}
