/**
 * Personality Behavior Engine
 *
 * Single source of truth for how personality axes affect agent behavior.
 * All personality-driven modifiers are computed here — consumers just
 * apply the returned multipliers/bonuses without knowing about axes.
 *
 * To add a new personality effect: modify this file only.
 * To change how vanity works: change it here, everything updates.
 */

import { PersonalityProfile } from './personality';

// --- Context passed to the engine ---

export interface BehaviorContext {
  mood: number;               // 0-100
  social: number;             // 0-100
  energy: number;             // 0-100
  hunger: number;             // 0-100
  isEvening: boolean;
  activeStates: string[];     // current life states
}

// --- Output: all behavioral modifiers ---

export interface BehaviorModifiers {
  // Social scoring
  socialBaseMultiplier: number;       // global multiplier on all social scores
  socialTargetStatusBonus: number;    // bonus for socializing with high-status agents
  socialAvoidanceThreshold: number;   // friendship below this → avoid
  socialSeekRomance: boolean;         // actively seek romantic targets

  // Location preferences
  tavernAttraction: number;           // bonus/penalty for tavern visits
  homePreference: number;             // multiplier for staying home/idle
  workEthic: number;                  // multiplier for voluntary work outside hours

  // Action modifiers
  eatImpulsiveness: number;           // multiplier on eat scoring
  riskTolerance: number;              // affects theft/gambling thresholds

  // Conversation behavior (used by conversation tier/topic selection)
  gossipProneness: number;            // likelihood of gossip topics
  conflictTendency: number;           // likelihood of negative interactions
  flirtTendency: number;             // likelihood of romantic topics
  confessionLikelihood: number;       // likelihood of confessing sins

  // Economy behavior
  spendingTendency: number;           // affects purchase decisions
  generosity: number;                 // affects gift-giving, helping
}

// --- Engine ---

export function computeBehaviorModifiers(
  personality: PersonalityProfile,
  context: BehaviorContext,
): BehaviorModifiers {
  const {
    honesty, aggression, warmth, impulsiveness,
    vanity, curiosity, loyalty, morality,
    sensuality, neuroticism,
  } = personality;

  const { mood, social, isEvening, activeStates } = context;

  // --- Social ---

  // Warmth is the primary social driver
  let socialBaseMultiplier = 0.7 + (warmth / 100) * 0.6; // 0.7-1.3

  // Neuroticism dampens socializing when mood is low
  if (neuroticism > 60 && mood < 40) {
    socialBaseMultiplier *= 0.7;
  }

  // Vanity boosts socializing (crave attention and validation)
  if (vanity > 60) {
    socialBaseMultiplier *= 1.2;
  }

  // Lonely agents are more social regardless of personality
  if (social < 25) {
    socialBaseMultiplier *= 1.3;
  }

  // Vain agents seek out important/high-status people
  const socialTargetStatusBonus = vanity > 60 ? 10 + (vanity - 60) * 0.25 : 0;

  // Low warmth agents avoid people they don't like
  const socialAvoidanceThreshold = warmth < 35 ? -10 : -30;

  // Sensuality drives romance-seeking
  const socialSeekRomance = sensuality > 50;

  // --- Location preferences ---

  // Tavern: impulsiveness draws you in, honesty keeps you away (secrets flow there)
  let tavernAttraction = 0;
  if (impulsiveness > 50) tavernAttraction += (impulsiveness - 50) * 0.3;
  if (isEvening) tavernAttraction += 15;
  if (morality < 30) tavernAttraction += 10; // low morality = drawn to vice
  if (honesty > 70) tavernAttraction -= 10; // honest people avoid rumor mills
  if (activeStates.includes('alcoholic')) tavernAttraction += 40;
  if (activeStates.includes('hungover')) tavernAttraction = -50;

  // Home: neuroticism = comfort in familiar spaces
  let homePreference = 1.0;
  if (neuroticism > 65) homePreference = 1.3;
  if (neuroticism > 80) homePreference = 1.5;
  if (vanity > 60) homePreference *= 0.7; // vain people don't want to be alone

  // Work ethic: low impulsiveness + high loyalty = workaholic
  let workEthic = 0;
  if (impulsiveness < 25) workEthic = 30 * (1 - impulsiveness / 100);
  if (loyalty > 70) workEthic *= 1.3;

  // --- Action modifiers ---

  const eatImpulsiveness = 1 + impulsiveness / 200; // 1.0-1.5

  // Risk tolerance affects theft/gambling thresholds
  const riskTolerance = (impulsiveness * 0.4 + (100 - morality) * 0.4 + aggression * 0.2) / 100;

  // --- Conversation behavior ---

  // Gossip: curiosity + dishonesty = gossip machine
  const gossipProneness = Math.max(0, (curiosity - 40) * 0.5 + (100 - honesty - 40) * 0.5) / 60;

  // Conflict: aggression + low warmth = combative
  const conflictTendency = Math.max(0, (aggression - 30) * 0.6 + (100 - warmth - 30) * 0.4) / 70;

  // Flirting: sensuality is the primary driver
  const flirtTendency = Math.max(0, sensuality - 30) / 70;

  // Confession: honesty + guilt
  const confessionLikelihood = Math.max(0, honesty - 40) / 60;

  // --- Economy ---

  // Spending: impulsiveness + vanity = spendy
  const spendingTendency = (impulsiveness * 0.6 + vanity * 0.4) / 100;

  // Generosity: warmth + morality - vanity
  const generosity = Math.max(0, (warmth * 0.5 + morality * 0.3 - vanity * 0.2)) / 80;

  return {
    socialBaseMultiplier,
    socialTargetStatusBonus,
    socialAvoidanceThreshold,
    socialSeekRomance,
    tavernAttraction,
    homePreference,
    workEthic,
    eatImpulsiveness,
    riskTolerance,
    gossipProneness,
    conflictTendency,
    flirtTendency,
    confessionLikelihood,
    spendingTendency,
    generosity,
  };
}
