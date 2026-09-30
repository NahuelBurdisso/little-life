import { chemistry, mayRomanceGrow, type RomanceParty } from './attraction';
import { isAdultAge } from './eligibility';

/**
 * The wandering eye: what neglect does to someone who is spoken for.
 *
 * Pure (no DB, no clock) so every input can be injected by a test; the readers
 * that feed it live in wandering.ts. Three small, independent effects, all of the
 * adult layer (nothing here does anything while `adultContent` is off) and all
 * behind the same adults-only line as the rest of intimacy:
 *
 *  - `isNeglected`: a committed adult who has gone more than four game days
 *    without a night with their own partner and aches for one (longing >= 70).
 *  - a romance-gain multiplier (`WANDER_ROMANCE_MULTIPLIER`) toward everybody
 *    except that partner, only for the weakly loyal (loyalty < 50); applied in
 *    relationshipImpact.ts after the attraction gate, so a minor or someone the
 *    agent is not drawn to still gains 0.
 *  - two social-decision terms: `wanderScoreBonus` toward attractive others and
 *    `partnerPullBonus` toward the partner or lover in the evening.
 *
 * A faithful agent (loyalty 50 or more) is never touched by the first two: neglect
 * hurts them (longing keeps building, the partner pull grows) but does not make them
 * look elsewhere.
 */

/** Longer than this without a night together (or since the relationship began) is neglect. */
export const NEGLECT_DAYS = 4;
/** ... once longing has built to this. */
export const NEGLECT_LONGING_MIN = 70;
/** Loyalty under this lets the eye wander. */
export const WANDER_LOYALTY_BELOW = 50;
/** Positive romance gain toward others, for a neglected agent below the loyalty line. */
export const WANDER_ROMANCE_MULTIPLIER = 1.5;
/** Added to the social score toward an attractive other. */
export const WANDER_SCORE_BONUS = 20;
/** "Attractive" for the decision term: chemistry (0.6..1.4) at least this. */
export const WANDER_CHEMISTRY_MIN = 1.1;
/** From this much longing the evening pulls toward the partner or lover. */
export const PARTNER_PULL_LONGING_MIN = 60;

const MINUTES_PER_DAY = 24 * 60;

export interface NeglectCtx {
  adultContent: boolean;
  /** Committed to somebody (`committedTo`): partner, engaged or married. */
  spokenFor: boolean;
  longing: number;
  /** Game minutes now. */
  now: number;
  /**
   * The later of the couple's last night together and the start of the relationship
   * (`status_since_minute`); null when neither is known, which reads as "cannot tell"
   * and so as not neglected.
   */
  lastIntimateAt: number | null;
}

export function isNeglected(agent: { age: number }, ctx: NeglectCtx): boolean {
  if (!ctx.adultContent || !isAdultAge(agent.age) || !ctx.spokenFor) return false;
  if (!(ctx.longing >= NEGLECT_LONGING_MIN)) return false;
  if (ctx.lastIntimateAt == null || !Number.isFinite(ctx.lastIntimateAt)) return false;
  return ctx.now - ctx.lastIntimateAt > NEGLECT_DAYS * MINUTES_PER_DAY;
}

/** Whether neglect actually loosens this agent's eye (the weakly loyal). */
export function isWayward(loyalty: number | null | undefined): boolean {
  return typeof loyalty === 'number' && loyalty < WANDER_LOYALTY_BELOW;
}

export interface WanderScoreCtx {
  /** The deciding agent is neglected (`isNeglected`). */
  neglected: boolean;
  loyalty: number | null | undefined;
  self: RomanceParty;
  other: RomanceParty;
  worldSeed: string | number;
  /** `other` is the deciding agent's own partner/spouse/fiance(e): the pull toward them is `partnerPullBonus`'s. */
  isPartner: boolean;
}

/**
 * +20 on the social score toward somebody a neglected, weakly loyal agent finds
 * attractive: an adult they are drawn to, with real chemistry between them.
 */
export function wanderScoreBonus(ctx: WanderScoreCtx): number {
  if (!ctx.neglected || ctx.isPartner || !isWayward(ctx.loyalty)) return 0;
  if (!mayRomanceGrow(ctx.self, ctx.other)) return 0;
  if (chemistry(ctx.self.id, ctx.other.id, ctx.worldSeed) < WANDER_CHEMISTRY_MIN) return 0;
  return WANDER_SCORE_BONUS;
}

export interface PartnerPullCtx {
  adultContent: boolean;
  evening: boolean;
  longing: number;
  /** The relationship row's tags and status with the candidate. */
  tags: readonly string[];
  status: string;
  /** Both are adults (`isIntimacyEligible`). */
  adults: boolean;
}

const PULL_TAGS: readonly string[] = ['partner', 'married', 'engaged', 'lovers'];

/**
 * `longing / 3` on the evening social score toward the person they are together
 * with (partner, spouse, fiance(e) or lover), from 60 longing up.
 */
export function partnerPullBonus(ctx: PartnerPullCtx): number {
  if (!ctx.adultContent || !ctx.evening || !ctx.adults) return 0;
  if (!(ctx.longing >= PARTNER_PULL_LONGING_MIN)) return 0;
  const together = ctx.status === 'partners' || ctx.tags.some((t) => PULL_TAGS.includes(t));
  return together ? ctx.longing / 3 : 0;
}

