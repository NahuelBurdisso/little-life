/**
 * Phase 3 of a decision: scoring what to do with free time.
 */

import { db } from '../../../db';
import { agentStates } from '../../../db/schema';
import { cliqueSocialModifier } from '../../../lib/cliques';
import { eq, and } from 'drizzle-orm';
import { CONFIG } from '../../../lib/constants';
import { gameMinutes } from '../../../lib/gameClock';
import { distance } from '../../../lib/utils';
import { PersonalityProfile, loyaltyBonus, sensualityBonus, curiosityNoveltyBonus } from '../../../lib/personality';
import { getEffectivePersonality, getAgentStates } from '../../../lib/states';
import { getNegativeFactCount } from '../../../lib/gossip';
import { computeBehaviorModifiers, BehaviorContext, type BehaviorModifiers } from '../../../lib/personalityEngine';
import { getReputationSocialModifier } from '../../../lib/reputationEngine';
import { getSharedHobbies } from '../../../lib/hobbyEngine';
import { getFavorSocialModifier } from '../../../lib/favorEngine';
import { foodCount } from '../../../lib/economyEngine';
import { isAdultContent } from '../../../lib/worldRules';
import { isIntimacyEligible } from '../../../lib/intimacy/eligibility';
import { partnerPullBonus, wanderScoreBonus } from '../../../lib/intimacy/neglect';
import { getAgentIntimacy } from '../../../lib/intimacy/state';
import { currentWorldSeed } from '../../../lib/intimacy/worldSeed';
import { neglectedPartnerOf } from '../../../lib/intimacy/wandering';
import type { AgentRow, NeedsRow, EconRow, LocationRow, RelRow, WorldRow, ScoredAction } from './types';
import { nearestLocation, getRelationshipValues, addNoise, gatheringBonus, isEvening } from './helpers';
import { PANTRY_TARGET, GROCERY_BASE_SCORE, nearestGrocer, HUNGRY_EAT_BONUS } from './meals';

// --- Free Time Scoring ---

/**
 * What every free-time scoring section reads, built once per
 * `scoreFreeTimeActions` call. `scores` is the one list the sections push into
 * and adjust in place, so they run in the order they always have: a later
 * multiplier applies to every option an earlier section pushed, and each
 * `addNoise` is a `Math.random()` call the tests sequence.
 */
interface FreeTimeContext {
  agent: AgentRow;
  agentNeeds: NeedsRow;
  agentEcon: EconRow | null;
  allLocations: LocationRow[];
  allRelationships: RelRow[];
  otherAgents: AgentRow[];
  world: WorldRow;
  econMap: Map<number, EconRow> | undefined;
  /** This tick's negative-fact counts per agent (see `countNegativeFactsBySubject`); queried per target when absent. */
  negativeFactCounts: Map<number, number> | undefined;
  scores: ScoredAction[];
  evening: boolean;
  events: Set<string>;
  season: string;
  wx: string;
  personality: PersonalityProfile | null;
  mood: number;
  agentStateTypes: ReturnType<typeof getAgentStates>;
  mods: BehaviorModifiers | null;
}

/** The adult layer's terms for the per-candidate social score, worked out once per call. */
interface IntimacyPull {
  adultLayer: boolean;
  neglectedBy: number | null;
  ownLonging: number;
  intimacySeed: string | number;
}

export function scoreFreeTimeActions(
  agent: AgentRow,
  agentNeeds: NeedsRow,
  agentEcon: EconRow | null,
  allLocations: LocationRow[],
  allRelationships: RelRow[],
  otherAgents: AgentRow[],
  world: WorldRow,
  econMap?: Map<number, EconRow>,
  activeEventTypes?: Set<string>,
  weather?: string,
  /** This tick's negative-fact counts per agent (see `countNegativeFactsBySubject`); queried per target when absent. */
  negativeFactCounts?: Map<number, number>,
): ScoredAction[] {
  const scores: ScoredAction[] = [];
  const evening = isEvening(world.time.hour);
  const events = activeEventTypes ?? new Set<string>();
  const season = world.time.season;
  const wx = weather ?? 'sunny';
  const personality = getEffectivePersonality(agent.id) ?? agent.personality as PersonalityProfile | null;
  const mood = agentNeeds.mood;
  const agentStateTypes = getAgentStates(agent.id);

  // Compute all personality-driven modifiers in one place
  const behaviorCtx: BehaviorContext = {
    mood,
    social: agentNeeds.social,
    energy: agentNeeds.energy,
    hunger: agentNeeds.hunger,
    isEvening: evening,
    activeStates: agentStateTypes as string[],
  };
  const mods = personality ? computeBehaviorModifiers(personality, behaviorCtx) : null;

  const f: FreeTimeContext = {
    agent, agentNeeds, agentEcon, allLocations, allRelationships, otherAgents, world, econMap,
    negativeFactCounts, scores, evening, events, season, wx, personality, mood, agentStateTypes, mods,
  };

  scoreEating(f);
  scoreGroceryRun(f);
  const socialCandidates = socialCandidatesFor(f);
  const pull = intimacyPullFor(f);
  scoreSocializing(f, socialCandidates, pull);
  const forced = infatuationOverride(f);
  if (forced) return forced;
  applyJealousy(f);
  const crowdPull = crowdPullFor(f);
  const tavern = scoreTavern(f, crowdPull);
  scoreGoHome(f);
  const square = scoreSquareStroll(f, crowdPull);

  // ── Zone-driven activities ─────────────────────────────────────────────────
  // Personality and state-driven activities at specific zones
  if (personality) {
    const { park, farm } = scoreZoneActivities(f, personality, square);
    applySeasonalModifiers(f, personality, park, tavern);
    scoreFarmHelp(f, personality, farm);
  }

  scoreWorkEthic(f);
  applyImpulsiveIdle(f);
  applyPersonalityModifiers(f, tavern);
  applyEconomyModifiers(f, tavern);
  scoreOpportunisticCrime(f);
  applyDistancePenalty(f);
  applyWorldEventModifiers(f);

  return scores;
}

/** Eating out: hunger, mood and impulsiveness, with a push below the "low" hunger line. */
function scoreEating(f: FreeTimeContext): void {
  const { agent, agentNeeds, allLocations, scores, mood, mods } = f;
  // Eat
  let eatScore = (100 - agentNeeds.hunger) * 1.5 + (mood < 40 ? 10 : 0);
  if (mods) {
    eatScore *= mods.eatImpulsiveness;
  }
  // Below the "low" line, eat before an evening out rather than after the
  // emergency: a crowded tavern (gatheringBonus) outscored a hunger of 30, and
  // once meals cost food the town spent its evenings hungry and its nights
  // under the critical line.
  const low = agentNeeds.thresholds?.low ?? CONFIG.NEEDS.THRESHOLDS.low;
  if (agentNeeds.hunger < low) eatScore += HUNGRY_EAT_BONUS;
  const foodLoc = nearestLocation(agent.position, allLocations, ['shop', 'tavern', 'bakery']);
  scores.push({
    action: 'eating',
    score: addNoise(eatScore),
    targetLocationId: foodLoc?.id ?? agent.home,
  });
}

/** A trip to the nearest open grocer when the pantry is low. */
function scoreGroceryRun(f: FreeTimeContext): void {
  const { agent, agentNeeds, agentEcon, allLocations, world, econMap, scores } = f;
  // Grocery run: an empty pantry means the next meal at home is no meal (G2).
  // Scored below eating at the same hunger so a hungry agent eats out first;
  // a peckish one restocks while the shops are open — food in hand is what
  // feeds a worker's breakfast and dinner, when the shop and bakery are shut.
  // The trip's list comes from groceryList.
  if (agentEcon && foodCount(agentEcon.inventory) < PANTRY_TARGET) {
    const grocer = nearestGrocer(agent, agentEcon.money, allLocations, econMap, world.time.hour);
    if (grocer) {
      scores.push({
        action: 'shopping',
        score: addNoise(GROCERY_BASE_SCORE + (100 - agentNeeds.hunger) * 0.5),
        targetLocationId: grocer.id,
      });
    }
  }
}

/**
 * Who this agent might go and socialize with: the co-located, the people they
 * already know, and (for the curious) a few random strangers. The strangers'
 * shuffle draws `Math.random()`, so this runs where it always did.
 */
function socialCandidatesFor(f: FreeTimeContext): AgentRow[] {
  const { agent, allRelationships, otherAgents, personality } = f;
  // Pre-filter social candidates to avoid scoring all 100 agents per agent.
  // Include: same-location agents, agents with existing relationship, + a few strangers for curious agents.
  const relationshipMap = new Map<string, RelRow>();
  for (const r of allRelationships) {
    const key = `${Math.min(r.agent_a, r.agent_b)}_${Math.max(r.agent_a, r.agent_b)}`;
    relationshipMap.set(key, r);
  }

  const socialCandidates = otherAgents.filter((other) => {
    if (other.id === agent.id || !other.is_active) return false;
    // Always include co-located agents
    if (
      other.current_location !== null &&
      other.current_location === agent.current_location
    ) return true;
    // Include agents with a meaningful existing relationship
    const key = `${Math.min(agent.id, other.id)}_${Math.max(agent.id, other.id)}`;
    const rel = relationshipMap.get(key);
    if (
      rel &&
      (rel.friendship_ab > 10 ||
        rel.friendship_ba > 10 ||
        rel.romance_ab > 5 ||
        rel.romance_ba > 5)
    ) return true;
    return false;
  });

  // Curious agents get a small random sample of strangers too
  if (personality && personality.curiosity > 60) {
    const strangers = otherAgents.filter(
      (a) => a.id !== agent.id && a.is_active && !socialCandidates.includes(a),
    );
    const sample = strangers.sort(() => Math.random() - 0.5).slice(0, 3);
    socialCandidates.push(...sample);
  }
  return socialCandidates;
}

/** The adult layer's wandering eye and partner pull inputs, read once for every candidate. */
function intimacyPullFor(f: FreeTimeContext): IntimacyPull {
  const { agent, world } = f;
  // The wandering eye and the partner pull (intimacy/neglect.ts). Adult layer only:
  // with the rule off none of these terms exists, and `neglectedPartnerOf` is one
  // cheap in-memory check for anybody who is not already aching.
  const adultLayer = isAdultContent();
  const neglectedBy = adultLayer ? neglectedPartnerOf(agent, gameMinutes(world.time)) : null;
  const ownLonging = adultLayer ? (getAgentIntimacy(agent.id)?.longing ?? 0) : 0;
  const intimacySeed = neglectedBy != null ? currentWorldSeed() : 0;
  return { adultLayer, neglectedBy, ownLonging, intimacySeed };
}

/** One socializing option per candidate, scored by `socialScoreFor`. */
function scoreSocializing(f: FreeTimeContext, socialCandidates: AgentRow[], pull: IntimacyPull): void {
  const { agent, scores } = f;
  // Socialize per agent
  for (const other of socialCandidates) {
    if (other.id === agent.id || !other.is_active) continue;
    scores.push({
      action: 'socializing',
      score: socialScoreFor(f, other, pull),
      targetAgentId: other.id,
      targetLocationId: other.current_location ?? undefined,
    });
  }
}

/**
 * How much this agent wants to spend their free time with `other`: needs,
 * the relationship, personality, reputation, shared grudges and hobbies,
 * favors, cliques and the workplace, times a personality-scaled noise draw
 * (the last `Math.random()` of the candidate).
 */
function socialScoreFor(f: FreeTimeContext, other: AgentRow, pull: IntimacyPull): number {
  const { agent, agentNeeds, allRelationships, world, econMap, negativeFactCounts, evening, personality, mood, agentStateTypes, mods } = f;
  const { adultLayer, neglectedBy, ownLonging, intimacySeed } = pull;
  const rel = getRelationshipValues(allRelationships, agent.id, other.id);
  const friendship = rel?.friendship ?? 0;
  const romance = rel?.romance ?? 0;
  const trust = rel?.trust ?? 0;

  // Look up the full rel row for interaction_count
  const relRow = allRelationships.find(
    r => (r.agent_a === agent.id && r.agent_b === other.id) ||
         (r.agent_b === agent.id && r.agent_a === other.id),
  );
  const interactionCount = relRow?.interaction_count ?? 0;

  let socScore = (100 - agentNeeds.social) * 1.2;
  if (friendship > 50) socScore += 15;
  if (romance > 30) socScore += 20;

  // Romantic date boost: evening + high romance = strong date urge
  const isDateTime = evening || world.time.hour >= 20;
  if (romance > 30 && isDateTime) {
    const dateBonus = Math.min(40, (romance - 30) * 0.6); // up to +40 score
    socScore += dateBonus;
    // Prefer romantic locations for dates
    if (personality && personality.sensuality > 45) {
      socScore += 10; // sensual agents love dates
    }
  }
  if (adultLayer) {
    // A neglected, weakly loyal agent looks at attractive adults who are not their
    // partner; anyone who aches (60+) is drawn home to their own partner or lover
    // in the evening. Both live behind the adults-only line.
    socScore += wanderScoreBonus({
      neglected: neglectedBy != null, loyalty: personality?.loyalty, self: agent, other,
      worldSeed: intimacySeed, isPartner: other.id === neglectedBy,
    });
    socScore += partnerPullBonus({
      adultContent: true, evening, longing: ownLonging,
      tags: relRow?.tags ?? [], status: relRow?.status ?? '', adults: isIntimacyEligible(agent, other),
    });
  }
  // Lonely → remove negative-friendship penalty
  if (friendship < -30 && !agentStateTypes.includes('lonely')) socScore -= 25;
  if (mood < 30 && trust > 50) socScore += 20;

  if (mods) {
    // Engine-driven social modifiers (replaces scattered personality checks)
    socScore *= mods.socialBaseMultiplier;
    // Keep individual axis bonuses that need per-target context
    socScore += loyaltyBonus(personality!.loyalty, friendship);
    socScore += sensualityBonus(personality!.sensuality, romance);
    socScore += curiosityNoveltyBonus(personality!.curiosity, interactionCount);
    // Vanity: prefer high-status targets
    if (mods.socialTargetStatusBonus > 0) {
      const otherEcon = econMap?.get(other.id) ?? null;
      if (otherEcon && ['mayor', 'shopkeeper', 'doctor', 'constable'].includes(otherEcon.job)) {
        socScore += mods.socialTargetStatusBonus;
      }
    }
  } else {
    if (agent.traits.includes('introverted')) socScore *= 0.7;
    if (agent.traits.includes('extroverted')) socScore *= 1.3;
  }

  // Reputation: community opinion affects willingness to socialize
  socScore *= getReputationSocialModifier(other.id);

  // Escalation: reduce social score toward agents with many negative facts
  const targetNegFacts = negativeFactCounts ? (negativeFactCounts.get(other.id) ?? 0) : getNegativeFactCount(other.id);
  if (targetNegFacts >= 10) {
    socScore *= 0.1; // Pariah
  } else if (targetNegFacts >= 3) {
    socScore *= Math.max(0.3, 1 - targetNegFacts * 0.08);
  }

  // Mutual-enemy bonding: shared grudges create alliances
  const agentGrudgeTargets = allRelationships
    .filter(r => (r.agent_a === agent.id || r.agent_b === agent.id) && (r.tags as string[]).includes('grudge'))
    .map(r => r.agent_a === agent.id ? r.agent_b : r.agent_a);
  const otherGrudgeTargets = allRelationships
    .filter(r => (r.agent_a === other.id || r.agent_b === other.id) && (r.tags as string[]).includes('grudge'))
    .map(r => r.agent_a === other.id ? r.agent_b : r.agent_a);
  const sharedEnemies = agentGrudgeTargets.filter(t => otherGrudgeTargets.includes(t));
  if (sharedEnemies.length > 0) {
    socScore += 5 * sharedEnemies.length;
  }

  // Shared hobby bonding: agents who share hobbies enjoy each other's company more
  const sharedHobbies = getSharedHobbies(agent.id, other.id);
  if (sharedHobbies.length > 0) {
    socScore += 8 * sharedHobbies.length;
  }

  // Favor obligation: agents who owe favors seek out their benefactors
  socScore += getFavorSocialModifier(agent.id, other.id);

  // Clique pull: people spend their free time inside their own circle and
  // drift away from other circles. This is what turns an evenly warm
  // friendship graph into visibly separate groups.
  socScore += cliqueSocialModifier(agent.id, other.id);

  // Coworker bonding: agents at same workplace socialize more
  if (agent.workplace && agent.workplace === other.workplace) {
    socScore += 12; // base coworker bonus
    // During work hours, coworkers chat more
    const sched = agent.schedule;
    if (world.time.hour >= sched.workStart && world.time.hour < sched.workEnd) {
      socScore += 15; // work break socializing
    }
    // Coworker rivalry: if both have high vanity, they compete
    if (personality && personality.vanity > 55) {
      const otherPersonality = getEffectivePersonality(other.id);
      if (otherPersonality && otherPersonality.vanity > 55) {
        socScore -= 8; // friction between vain coworkers
      }
    }
  }

  const noiseMultiplier = personality
    ? 0.1 + (personality.impulsiveness / 500)
    : CONFIG.DECISIONS.NOISE_FACTOR;
  const noise = 1 + (Math.random() * 2 - 1) * noiseMultiplier;

  return socScore * noise;
}

/**
 * The infatuated agent's forced choice: half the time the whole free-time list
 * is replaced by one walk to the object of their infatuation. Null when it
 * does not apply, and the caller carries on scoring.
 */
function infatuationOverride(f: FreeTimeContext): ScoredAction[] | null {
  const { agent, otherAgents, agentStateTypes } = f;
  // Infatuated → 50% chance to force the infatuation target as the socializing target
  if (agentStateTypes.includes('infatuated')) {
    const infatuatedState = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, 'infatuated')))
      .get();
    if (infatuatedState?.target_agent_id && Math.random() < 0.5) {
      const targetAgent = otherAgents.find(a => a.id === infatuatedState.target_agent_id);
      if (targetAgent && targetAgent.is_active) {
        return [
          {
            action: 'socializing',
            score: 9000,
            targetAgentId: targetAgent.id,
            targetLocationId: targetAgent.current_location ?? undefined,
          },
        ];
      }
    }
  }
  return null;
}

/** The jealous agent steers away from the rival and toward the love interest. */
function applyJealousy(f: FreeTimeContext): void {
  const { agent, scores, agentStateTypes } = f;
  // Jealous: avoid rival, seek love interest obsessively
  if (agentStateTypes.includes('jealous')) {
    const jealousState = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, 'jealous'))).get();
    if (jealousState) {
      const meta = jealousState.metadata ?? {};
      const rivalId = meta.rivalId as number | undefined;
      const loveInterestId = meta.loveInterestId as number | undefined;
      for (const s of scores) {
        if (s.targetAgentId === rivalId) {
          s.score = Math.max(0, s.score - 50);
        }
        if (s.targetAgentId === loveInterestId) {
          s.score += 50;
        }
      }
    }
  }
}

/** The crowd pull of a venue for this agent (see `gatheringBonus`), from where everyone else is now. */
function crowdPullFor(f: FreeTimeContext): (locationId: number) => number {
  const { agent, otherAgents, personality } = f;
  // Who is already where — the raw material for the crowd pull below.
  const occupancy = new Map<number, number>();
  for (const other of otherAgents) {
    if (other.id === agent.id || !other.is_active || other.current_location == null) continue;
    occupancy.set(other.current_location, (occupancy.get(other.current_location) ?? 0) + 1);
  }
  const crowdPull = (locationId: number) =>
    gatheringBonus(occupancy.get(locationId) ?? 0, personality?.warmth ?? 50);
  return crowdPull;
}

/** An evening at the nearest tavern; returns that tavern, which later modifiers single out. */
function scoreTavern(f: FreeTimeContext, crowdPull: (locationId: number) => number): LocationRow | null {
  const { agent, agentNeeds, allLocations, scores, evening, mods } = f;
  // Tavern — attraction driven by personality engine
  const tavern = nearestLocation(agent.position, allLocations, 'tavern');
  if (tavern) {
    let tavernScore = (100 - agentNeeds.fun) * 0.8 + (100 - agentNeeds.social) * 0.6;
    tavernScore += mods?.tavernAttraction ?? (evening ? 15 : 0);
    tavernScore += crowdPull(tavern.id);
    scores.push({ action: 'socializing', score: addNoise(tavernScore), targetLocationId: tavern.id });
  }
  return tavern;
}

/** Going home to rest. */
function scoreGoHome(f: FreeTimeContext): void {
  const { agent, agentNeeds, scores, mods } = f;
  // Go home — preference driven by personality engine
  let homeScore = (100 - agentNeeds.energy) * 1.0;
  if (agentNeeds.comfort < 40) homeScore += 15;
  homeScore *= mods?.homePreference ?? 1.0;
  scores.push({ action: 'idle', score: addNoise(homeScore), targetLocationId: agent.home });
}

/** A stroll on the nearest square; returns that square, where some zone activities happen. */
function scoreSquareStroll(f: FreeTimeContext, crowdPull: (locationId: number) => number): LocationRow | null {
  const { agent, agentNeeds, allLocations, world, scores } = f;
  // Stroll in the town square — the social heart of town should actually draw people
  const square = nearestLocation(agent.position, allLocations, 'town_square');
  if (square) {
    let walkScore = 35 + (agentNeeds.fun < 60 ? 10 : 0);
    // Afternoon promenade: agents low on social gravitate to the square
    if (world.time.hour >= 14 && world.time.hour < 17 && agentNeeds.social < 70) walkScore += 15;
    walkScore += crowdPull(square.id);
    scores.push({ action: 'socializing', score: addNoise(walkScore), targetLocationId: square.id });
  }
  return square;
}

/**
 * The personality and state-driven zone activities (contemplate, fish, garden,
 * forage, perform, jog, comfort, browse), behind the weather gates. Returns
 * the park and farm the seasonal modifiers and farm help use.
 */
function scoreZoneActivities(
  f: FreeTimeContext,
  personality: PersonalityProfile,
  square: LocationRow | null,
): { park: LocationRow | null; farm: LocationRow | null } {
  const { agent, agentNeeds, agentEcon, allLocations, scores, season, wx, agentStateTypes } = f;
  const park = nearestLocation(agent.position, allLocations, 'park');
  const farm = nearestLocation(agent.position, allLocations, 'farm');

  // Contemplate at riverside — lonely/stressed/neurotic agents seek solitude
  if (park && (agentStateTypes.includes('stressed') || agentStateTypes.includes('lonely') ||
      agentStateTypes.includes('heartbroken') || personality.neuroticism > 55)) {
    let contemplateScore = 25;
    if (agentStateTypes.includes('stressed')) contemplateScore += 20;
    if (agentStateTypes.includes('heartbroken')) contemplateScore += 25;
    if (agentStateTypes.includes('lonely')) contemplateScore += 15;
    contemplateScore += (personality.neuroticism - 50) * 0.3;
    scores.push({ action: 'idle', score: addNoise(contemplateScore), targetLocationId: park.id, source: 'contemplate' });
  }

  // Weather gates for outdoor activities
  const canFish = !['stormy', 'snowy'].includes(wx); // can't fish in storms or snow
  const canJog = !['stormy', 'snowy', 'hot'].includes(wx); // can't jog in extreme weather
  const canGarden = !['stormy', 'snowy'].includes(wx) && season !== 'winter';
  const canPerformOutdoors = !['stormy', 'rainy', 'snowy'].includes(wx);
  const canForage = !['stormy'].includes(wx);

  // Fish at riverside — relaxing activity for low fun/comfort
  if (park && agentNeeds.fun < 65 && canFish) {
    let fishScore = 25 + (65 - agentNeeds.fun) * 0.3 + (personality.curiosity > 50 ? 10 : 0);
    if (wx === 'rainy') fishScore *= 1.5; // fish bite more in rain!
    scores.push({ action: 'idle', score: addNoise(fishScore), targetLocationId: park.id, source: 'fish' });
  }

  // Garden at park — open to anyone needing fun/comfort; warmth adds affinity
  if (park && (agentNeeds.fun < 70 || agentNeeds.comfort < 65) && canGarden) {
    let gardenScore = 22 + Math.max(0, (personality.warmth - 40) * 0.2);
    if (agentNeeds.fun < 60) gardenScore += 10;
    scores.push({ action: 'idle', score: addNoise(gardenScore), targetLocationId: park.id, source: 'garden' });
  }

  // Forage in groves — curious or poor agents forage
  if (park && (personality.curiosity > 50 || (agentEcon && agentEcon.money < 15)) && canForage) {
    let forageScore = 10 + (personality.curiosity - 40) * 0.2;
    if (agentEcon && agentEcon.money < 15) forageScore += 20;
    scores.push({ action: 'idle', score: addNoise(forageScore), targetLocationId: park.id, source: 'forage' });
  }

  // Perform at town square fountain — vain/sensual agents perform
  if (square && personality.vanity > 45 && personality.sensuality > 40 && canPerformOutdoors) {
    const performScore = 15 + (personality.vanity - 40) * 0.3 + (agentNeeds.social < 50 ? 10 : 0);
    scores.push({ action: 'idle', score: addNoise(performScore), targetLocationId: square.id, source: 'perform' });
  }

  // Jog around town — energetic agents with high comfort needs
  if (agentNeeds.comfort < 50 && personality.impulsiveness > 40 && canJog) {
    const jogScore = 10 + (50 - agentNeeds.comfort) * 0.3;
    const jogTarget = park ?? square;
    if (jogTarget) {
      scores.push({ action: 'idle', score: addNoise(jogScore), targetLocationId: jogTarget.id, source: 'jog' });
    }
  }

  // Comfort outlet: low-comfort agents seek park bench rest
  // Threshold 35 keeps this optional (not urgent like hunger/energy emergencies).
  if (park && agentNeeds.comfort < 35) {
    const comfortScore = 20 + (35 - agentNeeds.comfort) * 0.6;
    scores.push({ action: 'comfort', score: addNoise(comfortScore), targetLocationId: park.id });
  }

  // Browse market stalls — curious shoppers or bored agents
  if (square && agentNeeds.fun < 50 && personality.curiosity > 40) {
    const browseScore = 12 + (personality.curiosity - 40) * 0.2 + (50 - agentNeeds.fun) * 0.2;
    scores.push({ action: 'idle', score: addNoise(browseScore), targetLocationId: square.id, source: 'browse' });
  }
  return { park, farm };
}

/** The season reweights the options so far and adds its own (flower walk, swim, cozy rest). */
function applySeasonalModifiers(
  f: FreeTimeContext,
  personality: PersonalityProfile,
  park: LocationRow | null,
  tavern: LocationRow | null,
): void {
  const { agent, agentNeeds, scores, season } = f;
  // ── Seasonal activity modifiers ──────────────────────────────────────────
  // Spring: gardening and foraging are more appealing, walking is pleasant
  if (season === 'spring') {
    for (const s of scores) {
      if (s.source === 'garden') s.score *= 1.5;
      if (s.source === 'forage') s.score *= 1.3;
      if (s.source === 'jog') s.score *= 1.3;
    }
    // Spring flower walk — any agent with warmth or curiosity
    if (park && personality.warmth > 35) {
      const flowerScore = 15 + (personality.warmth - 30) * 0.2 + (agentNeeds.fun < 60 ? 8 : 0);
      scores.push({ action: 'idle', score: addNoise(flowerScore), targetLocationId: park.id, source: 'garden' });
    }
  }

  // Summer: fishing peaks, outdoor socializing is great, swimming
  if (season === 'summer') {
    for (const s of scores) {
      if (s.source === 'fish') s.score *= 1.8;
      if (s.action === 'socializing' && s.targetLocationId !== tavern?.id) s.score *= 1.2;
    }
    // Summer swimming/relaxing at the riverside
    if (park && agentNeeds.comfort < 60) {
      const swimScore = 20 + (60 - agentNeeds.comfort) * 0.3 + (personality.impulsiveness - 40) * 0.2;
      scores.push({ action: 'idle', score: addNoise(swimScore), targetLocationId: park.id, source: 'contemplate' });
    }
  }

  // Autumn: foraging peaks, contemplation is stronger, cozy indoor preference
  if (season === 'autumn') {
    for (const s of scores) {
      if (s.source === 'forage') s.score *= 2.0;
      if (s.source === 'contemplate') s.score *= 1.5;
      if (s.targetLocationId === agent.home) s.score *= 1.2;
    }
  }

  // Winter: strong indoor preference, tavern is cozy, outdoor activities penalized
  if (season === 'winter') {
    for (const s of scores) {
      if (s.source === 'fish' || s.source === 'jog' || s.source === 'garden') s.score *= 0.4;
      if (s.source === 'forage') s.score *= 0.3;
      if (s.targetLocationId === agent.home) s.score *= 1.5;
      if (tavern && s.targetLocationId === tavern.id) s.score *= 1.6; // warm tavern
    }
    // Winter: reading/resting at home is cozy
    if (agentNeeds.comfort < 70 || personality.neuroticism > 40) {
      const cozyScore = 20 + (70 - agentNeeds.comfort) * 0.3;
      scores.push({ action: 'idle', score: addNoise(cozyScore), targetLocationId: agent.home, source: 'rest' });
    }
  }
}

/** Helping at the farm: warm agents, and anyone during a harvest. */
function scoreFarmHelp(f: FreeTimeContext, personality: PersonalityProfile, farm: LocationRow | null): void {
  const { agentNeeds, scores, events } = f;
  // Help at farm — warm agents or during harvest events
  if (farm && (personality.warmth > 55 || events.has('harvest') || events.has('bountiful_catch'))) {
    let farmScore = 10 + (personality.warmth - 40) * 0.2;
    if (events.has('harvest')) farmScore += 20;
    if (agentNeeds.fun < 50) farmScore += 5;
    scores.push({ action: 'idle', score: addNoise(farmScore), targetLocationId: farm.id, source: 'garden' });
  }
}

/** Going to work in free time, for the diligent (or the trait-only workaholic). */
function scoreWorkEthic(f: FreeTimeContext): void {
  const { agent, scores, personality, mods } = f;
  // Work ethic — driven by personality engine
  if (mods && mods.workEthic > 0 && agent.workplace) {
    scores.push({ action: 'working', score: addNoise(mods.workEthic), targetLocationId: agent.workplace });
  } else if (!personality && agent.traits.includes('workaholic') && agent.workplace) {
    scores.push({ action: 'working', score: addNoise(30), targetLocationId: agent.workplace });
  }
}

/** Very impulsive agents lean toward idling. */
function applyImpulsiveIdle(f: FreeTimeContext): void {
  const { scores, personality } = f;
  // Impulsiveness-driven idle preference (lazy agents)
  if (personality && personality.impulsiveness > 70) {
    for (const s of scores) {
      if (s.action === 'idle') s.score *= 1.3;
    }
  }
}

/** Vanity, neuroticism, honesty and low morality reweight the options so far. */
function applyPersonalityModifiers(f: FreeTimeContext, tavern: LocationRow | null): void {
  const { agent, scores, personality } = f;
  // --- Personality-driven behavioral modifiers ---
  if (personality) {
    // Vanity: vain agents seek social validation — boost socializing in busy locations
    if (personality.vanity > 60) {
      for (const s of scores) {
        if (s.action === 'socializing') s.score *= 1.3; // crave attention
      }
      // Avoid being alone — penalize idle at home
      for (const s of scores) {
        if (s.action === 'idle') s.score *= 0.7;
      }
    }

    // Neuroticism: anxious agents avoid unfamiliar situations, prefer safe spaces
    if (personality.neuroticism > 65) {
      for (const s of scores) {
        if (s.action === 'idle' && s.targetLocationId === agent.home) s.score *= 1.3; // prefer home
      }
    }

    // Honesty: honest agents are less likely to seek tavern (where secrets flow)
    if (personality.honesty > 70) {
      if (tavern) {
        for (const s of scores) {
          if (s.targetLocationId === tavern.id && s.action === 'socializing') s.score *= 0.7;
        }
      }
    }

    // Low morality: drawn to places where they can exploit (shop for theft, tavern for scheming)
    if (personality.morality < 30) {
      if (tavern) {
        for (const s of scores) {
          if (s.targetLocationId === tavern.id) s.score *= 1.2;
        }
      }
    }
  }
}

/** Money (and debt) reweight the options so far: the broke stay in, the flush go out. */
function applyEconomyModifiers(f: FreeTimeContext, tavern: LocationRow | null): void {
  const { agent, agentEcon, scores, agentStateTypes } = f;
  // Economic behavior modifiers
  if (agentEcon) {
    if (agentEcon.money < 15) {
      for (const s of scores) {
        if (s.action === 'eating' && s.targetLocationId !== agent.home) s.score *= 0.5;
        if (s.action === 'shopping') s.score *= 0.3;
        if (tavern && s.targetLocationId === tavern.id) s.score *= 0.4;
      }
    }
    // In-debt agents are desperate: boost work, suppress leisure
    if (agentStateTypes.includes('in_debt')) {
      for (const s of scores) {
        if (s.action === 'working') s.score *= 1.8; // desperate to earn
        if (s.action === 'idle' && s.source !== 'forage') s.score *= 0.5; // no time for leisure
        if (s.action === 'socializing') s.score *= 0.7; // less chatty
      }
    }
    if (agentEcon.money > 80) {
      for (const s of scores) {
        if (tavern && s.targetLocationId === tavern.id) s.score *= 1.2;
        if (s.action === 'shopping') s.score *= 1.3;
      }
    }
  }
}

/** Shoplifting and pickpocketing options for the broke and unscrupulous. */
function scoreOpportunisticCrime(f: FreeTimeContext): void {
  const { agent, agentEcon, allLocations, otherAgents, econMap, scores, personality } = f;
  // --- Opportunistic crime ---
  // Broke agents with low morality may attempt theft at shops or from nearby agents
  if (personality && agentEcon && agentEcon.money < 10 && personality.morality < 45) {
    // Not your own shop, and not one nobody owns: shoplifting takes from a
    // shopkeeper's till (shopliftFrom), never from the town's.
    const nearestShop = nearestLocation(agent.position, allLocations, 'shop');
    const shop = nearestShop && nearestShop.owner != null && nearestShop.owner !== agent.id ? nearestShop : null;
    const desperation = Math.max(0, 10 - agentEcon.money) * 2; // 0-20
    const moralityFactor = (45 - personality.morality) * 0.4; // 0-18
    const impulseFactor = personality.impulsiveness > 50 ? (personality.impulsiveness - 50) * 0.2 : 0;
    const crimeScore = desperation + moralityFactor + impulseFactor;

    // Shoplifting
    if (shop && crimeScore > 15) {
      scores.push({ action: 'idle', score: addNoise(crimeScore), targetLocationId: shop.id, source: 'shoplifting' });
    }

    // Pickpocket nearby wealthy agent
    if (crimeScore > 20) {
      for (const other of otherAgents) {
        if (other.id === agent.id || !other.is_active) continue;
        const otherEcon = econMap?.get(other.id) ?? null;
        if (!otherEcon || otherEcon.money < 30) continue;
        const d = distance(agent.position, other.position);
        if (d < 128) { // Within 4 tiles
          scores.push({
            action: 'idle',
            score: addNoise(crimeScore * 0.8),
            targetLocationId: other.current_location ?? undefined,
            targetAgentId: other.id,
            source: 'pickpocket',
          });
          break; // Only target one agent
        }
      }
    }
  }
}

/** Far-off places score less; home and work are exempt. */
function applyDistancePenalty(f: FreeTimeContext): void {
  const { agent, allLocations, scores } = f;
  // --- Distance penalty ---
  // Agents prefer nearby locations. Score decays with distance so that a location
  // 20 tiles away scores ~50% of an identical location right next to the agent.
  // Home and workplace are exempt (agents commit to the commute).
  const DISTANCE_HALF_LIFE_PX = 20 * 32; // 20 tiles in pixels
  for (const s of scores) {
    if (s.targetLocationId === agent.home || s.targetLocationId === agent.workplace) continue;
    const targetLoc = allLocations.find((l) => l.id === s.targetLocationId);
    if (!targetLoc) continue;
    const d = distance(agent.position, targetLoc.entry_point);
    s.score *= DISTANCE_HALF_LIFE_PX / (DISTANCE_HALF_LIFE_PX + d);
  }
}

/** Active world events reweight every option (storms indoors, festivals social...). */
function applyWorldEventModifiers(f: FreeTimeContext): void {
  const { agent, allLocations, allRelationships, scores, events } = f;
  // --- World Event Modifiers ---
  // Active events shape agent behavior: storms drive indoors, festivals boost socializing, etc.
  if (events.size > 0) {
    for (const s of scores) {
      const targetLoc = allLocations.find((l) => l.id === s.targetLocationId);
      const targetIsIndoors = targetLoc ? !['park', 'town_square', 'farm'].includes(targetLoc.type) : false;

      // Storm: strongly prefer indoor locations, avoid outdoor activities
      if (events.has('storm')) {
        if (!targetIsIndoors && s.targetLocationId !== agent.home) {
          s.score *= 0.2; // heavily penalize going outdoors
        }
        if (targetIsIndoors || s.targetLocationId === agent.home) {
          s.score *= 1.4; // boost indoor activities
        }
      }

      // Festival: boost socializing, eating at taverns, performing
      if (events.has('festival')) {
        if (s.action === 'socializing') s.score *= 1.6;
        if (s.action === 'eating') s.score *= 1.3;
        if (s.source === 'perform') s.score *= 2.0;
        if (s.source === 'browse') s.score *= 1.5;
      }

      // Market Day: boost shopping and browsing
      if (events.has('market_day')) {
        if (s.action === 'shopping') s.score *= 2.0;
        if (s.source === 'browse') s.score *= 2.5;
        if (s.action === 'eating') s.score *= 1.2; // food stalls
      }

      // Sickness/Flu: prefer staying home, avoid crowded places
      if (events.has('sickness')) {
        if (s.action === 'socializing') s.score *= 0.6; // avoid crowds
        if (s.targetLocationId === agent.home) s.score *= 1.5; // stay home
      }

      // Harvest: boost farm work and foraging
      if (events.has('harvest') || events.has('bountiful_catch')) {
        if (s.source === 'forage') s.score *= 2.0;
        if (s.source === 'garden') s.score *= 1.8;
        if (s.source === 'fish') s.score *= 2.5;
        if (s.action === 'working') s.score *= 1.3;
      }

      // Full Moon / Wedding / Starry Night: boost romantic socializing
      if (events.has('full_moon') || events.has('wedding') || events.has('starry_night')) {
        if (s.action === 'socializing' && s.targetAgentId) {
          const rel = getRelationshipValues(allRelationships, agent.id, s.targetAgentId);
          if (rel && rel.romance > 10) {
            s.score *= 1.8; // romantic encounters are magnetic
          }
        }
        if (s.source === 'contemplate') s.score *= 1.3; // stargazing
      }

      // Competition: boost fun-seeking activities
      if (events.has('competition')) {
        if (s.source === 'fish') s.score *= 2.0;
        if (s.source === 'perform') s.score *= 2.0;
        if (s.action === 'socializing') s.score *= 1.3;
      }

      // Heatwave: prefer indoors and tavern (cool drinks)
      if (events.has('heatwave')) {
        if (!targetIsIndoors && s.targetLocationId !== agent.home) {
          s.score *= 0.5;
        }
        if (targetLoc && targetLoc.type === 'tavern') s.score *= 1.8; // cool drinks
      }

      // Traveling Merchant: boost shopping and browsing
      if (events.has('traveling_merchant')) {
        if (s.action === 'shopping') s.score *= 1.8;
        if (s.source === 'browse') s.score *= 2.0;
      }

      // Town Meeting: boost town square socializing
      if (events.has('town_meeting')) {
        if (targetLoc && targetLoc.type === 'town_square') s.score *= 2.0;
        if (s.action === 'socializing') s.score *= 1.3;
      }
    }
  }
}
