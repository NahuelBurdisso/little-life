/**
 * The world rules a running town reads, and the Storyteller presets that set
 * them. Pure data: the client imports it (the wizard's configRegistry, the
 * Autoplay panel) and the server resolves it (server/lib/worldRules.ts), so the
 * option lists and the numbers behind them cannot drift apart.
 *
 * Every default below maps to a multiplier of exactly 1: the rates the systems
 * already use (0.12 random events an hour, 0.0001 sickness a game minute, ...)
 * were tuned on the defaults, so a world set up without touching the wizard —
 * or saved before these rules did anything — plays exactly as it did.
 */

import { MAX_AGENTS } from '../lib/worldgen/config';

export const SICKNESS_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export type SicknessLevel = (typeof SICKNESS_LEVELS)[number];

export const DRAMA_LEVELS = ['low', 'medium', 'high', 'chaos'] as const;
export type DramaLevel = (typeof DRAMA_LEVELS)[number];

/**
 * The rules a system reads while the town runs. `tickSpeed` and
 * `startingMoney` are wizard rules too, but they are applied once when the
 * world is built (setup.ts) and then live in their own columns, so they are
 * not here.
 */
export interface LiveRules {
  /** Agents can die of neglect, sickness, age or accidents. */
  deathEnabled: boolean;
  /** Scales how often an agent falls ill on their own (weather, season, exhaustion). */
  sicknessRate: SicknessLevel;
  /** Scales how easily an ill agent passes it on to someone in the same room. */
  contagionRate: SicknessLevel;
  /** Scales random world events, the dark cascade rules and how soon tension snaps. */
  dramaIntensity: DramaLevel;
  /**
   * The town's population changes on its own (lib/populationFlow.ts): unhappy
   * residents move away, newcomers take empty houses.
   */
  populationFlow: boolean;
  /**
   * How many residents newcomers fill the town back up to. Null = the size
   * the town started at.
   */
  populationTarget: number | null;
  /**
   * Opt-in, 18+: the adult layer of romance (lib/intimacy/). It unlocks
   * longing, private rendezvous, lovers spending the night together (always
   * implied and off-screen), the scandal of an unwed pregnancy and a franker
   * adult tone in dialogue. Only adults are ever involved. Kisses and chaste
   * courting work without it, so a town with this off still has romance.
   */
  adultContent: boolean;
}

/** Bounds of `populationTarget`: a town of fewer than four is not a town; the top is the world cap. */
export const POPULATION_TARGET_MIN = 4;
export const POPULATION_TARGET_MAX = MAX_AGENTS;

export const DEFAULT_LIVE_RULES: Readonly<LiveRules> = {
  deathEnabled: true,
  sicknessRate: 'low',
  contagionRate: 'low',
  dramaIntensity: 'medium',
  populationFlow: true,
  populationTarget: null,
  adultContent: false,
};

/**
 * Multiplier on the per-minute chance of catching something from the
 * environment (states.ts). 'low' is the tuned base (~14% a day for a rested
 * agent in fair weather); 'high' is roughly one agent in two a day, which is
 * an epidemic town on purpose.
 */
export const SICKNESS_MULTIPLIER: Readonly<Record<SicknessLevel, number>> = {
  off: 0, low: 1, medium: 2, high: 3.5,
};

/** Multiplier on person-to-person spread: the states.ts roll and the `sick_contagion` ripple rule. */
export const CONTAGION_MULTIPLIER: Readonly<Record<SicknessLevel, number>> = {
  off: 0, low: 1, medium: 2, high: 3.5,
};

/**
 * Multiplier on the hourly random-event roll and on the probability of every
 * dark cascade rule (grudges, jealousy, theft, drinking — see
 * `rippleProbabilityScale`). Warm rules (bonding, apologies, forgiveness) are
 * left alone: "low drama" should mean fewer fights, not fewer friendships.
 */
export const DRAMA_MULTIPLIER: Readonly<Record<DramaLevel, number>> = {
  low: 0.5, medium: 1, high: 1.5, chaos: 2.5,
};

/**
 * Scale on each agent's snap threshold (TensionTracker, 55-125 by
 * personality). Gentler than DRAMA_MULTIPLIER on purpose: tension already
 * builds faster under high drama because the dark rules that add it fire more
 * often, so a steep threshold cut on top would double-count and turn 'chaos'
 * into a snap every game hour.
 */
export const DRAMA_SNAP_THRESHOLD_SCALE: Readonly<Record<DramaLevel, number>> = {
  low: 1.15, medium: 1, high: 0.9, chaos: 0.8,
};

// ─── Storyteller presets ─────────────────────────────────────────────────────

export type StorytellerId = 'calm' | 'balanced' | 'chaos';

/** The storyteller-relevant subset of the autoplay config (server/lib/constants.ts AUTOPLAY_CONFIG). */
export interface StorytellerAutoplay {
  enabled: boolean;
  /** Boredom score above which the nudger pokes the town (0-100; higher = more patient). */
  boredThreshold: number;
}

export interface StorytellerPreset {
  id: StorytellerId;
  label: string;
  icon: string;
  blurb: string;
  rules: Pick<LiveRules, 'dramaIntensity' | 'sicknessRate' | 'contagionRate'>;
  autoplay: StorytellerAutoplay;
}

/**
 * Three one-click moods for a running town. Death is deliberately not part of
 * any preset: it is a moral choice the player made in the wizard, and a
 * "Chaos" click should not quietly start killing people off.
 *
 * Balanced is the wizard defaults with autoplay on at the shipped threshold
 * (AUTOPLAY_CONFIG), so a fresh world reads as Balanced: the storyteller pokes
 * a lull that stays boring for an hour, never a town that is busy on its own.
 * Calm keeps illness but stops it spreading, and leaves the town alone. Chaos
 * shortens the fuse, so a quiet hour gets poked instead of waited out.
 */
export const STORYTELLERS: readonly StorytellerPreset[] = [
  {
    id: 'calm',
    label: 'Calm',
    icon: '🌿',
    blurb: 'Few events, rare quarrels, colds that stay put. The town is left alone.',
    rules: { dramaIntensity: 'low', sicknessRate: 'low', contagionRate: 'off' },
    autoplay: { enabled: false, boredThreshold: 75 },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    icon: '⚖️',
    blurb: 'The town as tuned: the odd event, grudges when earned, a cold now and then — and a nudge when it goes quiet.',
    rules: { dramaIntensity: 'medium', sicknessRate: 'low', contagionRate: 'low' },
    autoplay: { enabled: true, boredThreshold: 55 },
  },
  {
    id: 'chaos',
    label: 'Chaos',
    icon: '🔥',
    blurb: 'Events every few hours, tempers on a hair trigger, fevers that spread — and a storyteller that pokes any lull.',
    rules: { dramaIntensity: 'chaos', sicknessRate: 'medium', contagionRate: 'high' },
    autoplay: { enabled: true, boredThreshold: 35 },
  },
];

/**
 * Which preset the town is running, or null for a hand-tuned mix. The
 * threshold only counts while autoplay is on: switched off it does nothing, so
 * Calm must not stop matching because it was left elsewhere.
 */
export function matchStoryteller(
  rules: Pick<LiveRules, 'dramaIntensity' | 'sicknessRate' | 'contagionRate'>,
  autoplay: StorytellerAutoplay,
): StorytellerId | null {
  const hit = STORYTELLERS.find((p) =>
    p.rules.dramaIntensity === rules.dramaIntensity
    && p.rules.sicknessRate === rules.sicknessRate
    && p.rules.contagionRate === rules.contagionRate
    && p.autoplay.enabled === autoplay.enabled
    && (!autoplay.enabled || p.autoplay.boredThreshold === autoplay.boredThreshold));
  return hit?.id ?? null;
}
