import { db } from '../../db';
import {
  agents,
  needs,
  economy,
  relationships,
  locations,
  conversationQueue,
  conversations,
  relationshipEvents,
  shared_knowledge,
  goals,
} from '../../db/schema';
import { logActivity } from '../../lib/activityLogger';
import { findAvailableZone } from '../../lib/interiorGrid';
import { eq, and } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { distance } from '../../lib/utils';
import { emitter } from '../emitter';
import {
  PersonalityProfile,
  loyaltyBonus,
  sensualityBonus,
  curiosityNoveltyBonus,
  selectPersonalityTopic,
} from '../../lib/personality';
import { getEffectivePersonality, getAgentStates } from '../../lib/states';
import { agentStates } from '../../db/schema';
import { createFact, getShareableFacts, getAgentName, getNegativeFactCount } from '../../lib/gossip';
import { computeBehaviorModifiers, BehaviorContext } from '../../lib/personalityEngine';
import { getCheapestFoodPrice } from '../../lib/economyEngine';
import { simEvents } from '../../lib/simEvents';
import { planExecutor, planGenerator } from '../../lib/planning/instance';

// --- Types ---

type AgentRow = typeof agents.$inferSelect;
type NeedsRow = typeof needs.$inferSelect;
type EconRow = typeof economy.$inferSelect;
type LocationRow = typeof locations.$inferSelect;
type RelRow = typeof relationships.$inferSelect;
type WorldRow = {
  time: { day: number; hour: number; minute: number; totalTicks: number; seasonDay: number; season: string };
  tick_speed: number;
};

interface ScoredAction {
  action: string;
  score: number;
  targetLocationId?: number;
  targetAgentId?: number;
  topic?: string;
  source?: string;
}

// Tracks consecutive work skips per agent to detect work_issue pattern
const workSkipCount = new Map<number, number>();

// --- Helpers ---

function isActionComplete(agent: AgentRow, totalTicks: number): boolean {
  if (agent.current_action == null) return true;

  const actionType =
    typeof agent.current_action === 'object' ? (agent.current_action as any).type : agent.current_action;

  // Walking agents are handled by the movement system — BUT if destination is null
  // (e.g. a stale or malformed walking action), treat as complete so the decision
  // system can assign a new action and unblock the agent.
  if (actionType === 'walking') {
    return agent.current_destination === null;
  }

  // Talking agents wait for conversation system to end — UNLESS needs are critical.
  // An agent with hunger or energy below the emergency threshold should bail out
  // of a conversation so the decision system can trigger an emergency override.
  if (actionType === 'talking') {
    const agentNeeds = db.select().from(needs).where(eq(needs.agent_id, agent.id)).get();
    if (agentNeeds) {
      const critical = CONFIG.NEEDS.THRESHOLDS.critical;
      if (agentNeeds.hunger < critical || agentNeeds.energy < critical) {
        return true; // interrupt conversation for emergency
      }
    }
    return false;
  }

  // Idle with no duration = needs reassignment
  if (actionType === 'idle' && agent.action_duration === null) return true;

  // Check duration-based completion
  if (agent.action_duration !== null) {
    return (totalTicks - agent.action_started) >= agent.action_duration;
  }

  // No duration set for non-walking action — treat as complete
  return true;
}

function nearestLocation(
  agentPos: { x: number; y: number },
  locs: LocationRow[],
  typeFilter: string | string[],
): LocationRow | null {
  const types = Array.isArray(typeFilter) ? typeFilter : [typeFilter];
  const candidates = locs.filter((l) => types.includes(l.type));
  if (candidates.length === 0) return null;

  let best: LocationRow | null = null;
  let bestDist = Infinity;
  for (const loc of candidates) {
    const d = distance(agentPos, loc.entry_point);
    if (d < bestDist) {
      bestDist = d;
      best = loc;
    }
  }
  return best;
}

function getRelationshipValues(
  rels: RelRow[],
  agentId: number,
  otherId: number,
): { friendship: number; romance: number; trust: number } | null {
  for (const r of rels) {
    if (r.agent_a === agentId && r.agent_b === otherId) {
      return { friendship: r.friendship_ab, romance: r.romance_ab, trust: r.trust_ab };
    }
    if (r.agent_b === agentId && r.agent_a === otherId) {
      return { friendship: r.friendship_ba, romance: r.romance_ba, trust: r.trust_ba };
    }
  }
  return null;
}

function addNoise(score: number): number {
  const noise = 1 + (Math.random() * 2 - 1) * CONFIG.DECISIONS.NOISE_FACTOR;
  return score * noise;
}

function isEvening(hour: number): boolean {
  return hour >= 17 && hour < 22;
}

// Reads from item registry — no hardcoded prices
function cheapestFoodPrice(): number {
  return getCheapestFoodPrice();
}

// --- Emergency Check ---

function checkEmergency(
  agent: AgentRow,
  agentNeeds: NeedsRow,
  agentEcon: EconRow | null,
  allLocations: LocationRow[],
  allRelationships: RelRow[],
  otherAgents: AgentRow[],
): ScoredAction | null {
  const critical = agentNeeds.thresholds?.critical ?? CONFIG.NEEDS.THRESHOLDS.critical;

  const crises: { need: string; value: number }[] = [];
  if (agentNeeds.hunger < critical) crises.push({ need: 'hunger', value: agentNeeds.hunger });
  if (agentNeeds.energy < critical) crises.push({ need: 'energy', value: agentNeeds.energy });
  if (agentNeeds.social < critical) crises.push({ need: 'social', value: agentNeeds.social });

  if (agentNeeds.mood < CONFIG.NEEDS.MOOD_CRITICAL_THRESHOLD) {
    return {
      action: 'idle',
      score: 9999,
      targetLocationId: agent.home,
    };
  }

  if (crises.length === 0) return null;

  crises.sort((a, b) => a.value - b.value);
  const worst = crises[0];

  switch (worst.need) {
    case 'hunger': {
      const money = agentEcon?.money ?? 0;
      if (money >= cheapestFoodPrice()) {
        const shop = nearestLocation(agent.position, allLocations, 'shop');
        if (shop) {
          return { action: 'eating', score: 9999, targetLocationId: shop.id };
        }
      }
      return { action: 'eating', score: 9999, targetLocationId: agent.home };
    }
    case 'energy': {
      return { action: 'sleeping', score: 9999, targetLocationId: agent.home };
    }
    case 'social': {
      let bestTarget: { agentId: number; locationId: number | null; dist: number } | null = null;
      for (const other of otherAgents) {
        if (other.id === agent.id || !other.is_active) continue;
        const rel = getRelationshipValues(allRelationships, agent.id, other.id);
        if (rel && rel.friendship > 20) {
          const d = distance(agent.position, other.position);
          if (!bestTarget || d < bestTarget.dist) {
            bestTarget = { agentId: other.id, locationId: other.current_location, dist: d };
          }
        }
      }
      if (bestTarget) {
        const targetLoc = bestTarget.locationId
          ? bestTarget.locationId
          : nearestLocation(agent.position, allLocations, 'town_square')?.id ?? undefined;
        return { action: 'socializing', score: 9999, targetLocationId: targetLoc, targetAgentId: bestTarget.agentId };
      }
      const social = nearestLocation(agent.position, allLocations, ['tavern', 'town_square']);
      if (social) {
        return { action: 'socializing', score: 9999, targetLocationId: social.id };
      }
      return null;
    }
    default:
      return null;
  }
}

// --- Schedule Check ---

function checkSchedule(
  agent: AgentRow,
  world: WorldRow,
  allLocations: LocationRow[],
): ScoredAction | null {
  const personality = getEffectivePersonality(agent.id) ?? agent.personality as PersonalityProfile | null;
  const { hour, minute } = world.time;
  const sched = agent.schedule;
  const duringWorkHours = !!agent.workplace && hour >= sched.workStart && hour < sched.workEnd;

  if (personality && Math.random() < personality.impulsiveness / 200) {
    // Impulsive agent skips schedule this tick; track work skips
    if (duringWorkHours) {
      const count = (workSkipCount.get(agent.id) ?? 0) + 1;
      workSkipCount.set(agent.id, count);
      if (count === 3) {
        createFact('work_issue', agent.id, null, 1, [agent.id], 'observed');
      }
    }
    return null;
  }

  // Sick → seek medical attention or rest at home
  const agentStateTypes = getAgentStates(agent.id);
  if (agentStateTypes.includes('sick')) {
    // Try to go to the clinic if severity is high enough
    const sickState = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, 'sick')))
      .get();
    if (sickState && sickState.severity > 0.4) {
      const clinic = nearestLocation(agent.position, allLocations, 'clinic');
      if (clinic) {
        return { action: 'idle', score: 9999, targetLocationId: clinic.id };
      }
    }
    return { action: 'idle', score: 9999, targetLocationId: agent.home };
  }

  // Depressed → skip work
  if (agentStateTypes.includes('depressed') && agent.workplace) {
    if (hour >= sched.workStart && hour < sched.workEnd) {
      const count = (workSkipCount.get(agent.id) ?? 0) + 1;
      workSkipCount.set(agent.id, count);
      if (count === 3) {
        createFact('work_issue', agent.id, null, 1, [agent.id], 'observed');
      }
      return null; // skip scheduled work
    }
  }

  // Sleep time: handle wrap-around (sleepTime=0 means midnight=24)
  const effectiveSleepTime = sched.sleepTime === 0 ? 24 : sched.sleepTime;
  if (effectiveSleepTime > sched.wakeTime) {
    // Normal case: sleep 22 → wake 7 → sleeping when hour >= 22 OR hour < 7
    if (hour >= effectiveSleepTime || hour < sched.wakeTime) {
      return { action: 'sleeping', score: 5000, targetLocationId: agent.home };
    }
  } else {
    // Inverted case: sleep 2 → wake 10 → sleeping when hour >= 2 AND hour < 10
    if (hour >= effectiveSleepTime && hour < sched.wakeTime) {
      return { action: 'sleeping', score: 5000, targetLocationId: agent.home };
    }
  }

  // Work time
  if (agent.workplace && hour >= sched.workStart && hour < sched.workEnd) {
    workSkipCount.set(agent.id, 0); // agent actually went to work — reset counter
    return { action: 'working', score: 4000, targetLocationId: agent.workplace };
  }

  // Lunch time
  const lunchMinutes = sched.lunchTime * 60;
  const currentMinutes = hour * 60 + minute;
  if (Math.abs(currentMinutes - lunchMinutes) <= 30) {
    const foodLoc = nearestLocation(agent.position, allLocations, ['shop', 'tavern', 'bakery']);
    if (foodLoc) {
      return { action: 'eating', score: 3000, targetLocationId: foodLoc.id };
    }
    return { action: 'eating', score: 3000, targetLocationId: agent.home };
  }

  return null;
}

// --- Free Time Scoring ---

function scoreFreeTimeActions(
  agent: AgentRow,
  agentNeeds: NeedsRow,
  agentEcon: EconRow | null,
  allLocations: LocationRow[],
  allRelationships: RelRow[],
  otherAgents: AgentRow[],
  world: WorldRow,
  econMap?: Map<number, EconRow>,
): ScoredAction[] {
  const scores: ScoredAction[] = [];
  const evening = isEvening(world.time.hour);
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

  // Eat
  let eatScore = (100 - agentNeeds.hunger) * 1.5 + (mood < 40 ? 10 : 0);
  if (mods) {
    eatScore *= mods.eatImpulsiveness;
  }
  const foodLoc = nearestLocation(agent.position, allLocations, ['shop', 'tavern', 'bakery']);
  scores.push({
    action: 'eating',
    score: addNoise(eatScore),
    targetLocationId: foodLoc?.id ?? agent.home,
  });

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

  // Socialize per agent
  for (const other of socialCandidates) {
    if (other.id === agent.id || !other.is_active) continue;
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

    // Escalation: reduce social score toward agents with many negative facts
    const targetNegFacts = getNegativeFactCount(other.id);
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

    const noiseMultiplier = personality
      ? 0.1 + (personality.impulsiveness / 500)
      : CONFIG.DECISIONS.NOISE_FACTOR;
    const noise = 1 + (Math.random() * 2 - 1) * noiseMultiplier;

    scores.push({
      action: 'socializing',
      score: socScore * noise,
      targetAgentId: other.id,
      targetLocationId: other.current_location ?? undefined,
    });
  }

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

  // Jealous: avoid rival, seek love interest obsessively
  if (agentStateTypes.includes('jealous')) {
    const jealousState = db.select().from(agentStates)
      .where(and(eq(agentStates.agent_id, agent.id), eq(agentStates.type, 'jealous'))).get();
    if (jealousState) {
      const meta = (jealousState.metadata as Record<string, any> | null) ?? {};
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

  // Tavern — attraction driven by personality engine
  const tavern = nearestLocation(agent.position, allLocations, 'tavern');
  if (tavern) {
    let tavernScore = (100 - agentNeeds.fun) * 0.8 + (100 - agentNeeds.social) * 0.6;
    tavernScore += mods?.tavernAttraction ?? (evening ? 15 : 0);
    scores.push({ action: 'socializing', score: addNoise(tavernScore), targetLocationId: tavern.id });
  }

  // Go home — preference driven by personality engine
  let homeScore = (100 - agentNeeds.energy) * 1.0;
  if (agentNeeds.comfort < 40) homeScore += 15;
  homeScore *= mods?.homePreference ?? 1.0;
  scores.push({ action: 'idle', score: addNoise(homeScore), targetLocationId: agent.home });

  // Stroll in the town square
  const square = nearestLocation(agent.position, allLocations, 'town_square');
  if (square) {
    const walkScore = 20 + (agentNeeds.fun < 60 ? 10 : 0);
    scores.push({ action: 'socializing', score: addNoise(walkScore), targetLocationId: square.id });
  }

  // ── Zone-driven activities ─────────────────────────────────────────────────
  // Personality and state-driven activities at specific zones
  if (personality) {
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

    // Fish at riverside — relaxing activity for low fun/comfort
    if (park && agentNeeds.fun < 50) {
      const fishScore = 15 + (50 - agentNeeds.fun) * 0.3 + (personality.curiosity > 50 ? 10 : 0);
      scores.push({ action: 'idle', score: addNoise(fishScore), targetLocationId: park.id, source: 'fish' });
    }

    // Garden at park — warm/curious agents tend the garden
    if (park && (personality.warmth > 50 || personality.curiosity > 60)) {
      let gardenScore = 15 + (personality.warmth - 40) * 0.2;
      if (agentNeeds.fun < 60) gardenScore += 10;
      scores.push({ action: 'idle', score: addNoise(gardenScore), targetLocationId: park.id, source: 'garden' });
    }

    // Forage in groves — curious or poor agents forage
    if (park && (personality.curiosity > 60 || (agentEcon && agentEcon.money < 15))) {
      let forageScore = 10 + (personality.curiosity - 40) * 0.2;
      if (agentEcon && agentEcon.money < 15) forageScore += 20;
      scores.push({ action: 'idle', score: addNoise(forageScore), targetLocationId: park.id, source: 'forage' });
    }

    // Perform at town square fountain — vain/sensual agents perform
    if (square && personality.vanity > 45 && personality.sensuality > 40) {
      const performScore = 15 + (personality.vanity - 40) * 0.3 + (agentNeeds.social < 50 ? 10 : 0);
      scores.push({ action: 'idle', score: addNoise(performScore), targetLocationId: square.id, source: 'perform' });
    }

    // Jog around town — energetic agents with high comfort needs
    if (agentNeeds.comfort < 50 && personality.impulsiveness > 40) {
      const jogScore = 10 + (50 - agentNeeds.comfort) * 0.3;
      const jogTarget = park ?? square;
      if (jogTarget) {
        scores.push({ action: 'idle', score: addNoise(jogScore), targetLocationId: jogTarget.id, source: 'jog' });
      }
    }

    // Browse market stalls — curious shoppers or bored agents
    if (square && agentNeeds.fun < 50 && personality.curiosity > 40) {
      const browseScore = 12 + (personality.curiosity - 40) * 0.2 + (50 - agentNeeds.fun) * 0.2;
      scores.push({ action: 'idle', score: addNoise(browseScore), targetLocationId: square.id, source: 'browse' });
    }
  }

  // Work ethic — driven by personality engine
  if (mods && mods.workEthic > 0 && agent.workplace) {
    scores.push({ action: 'working', score: addNoise(mods.workEthic), targetLocationId: agent.workplace });
  } else if (!personality && agent.traits.includes('workaholic') && agent.workplace) {
    scores.push({ action: 'working', score: addNoise(30), targetLocationId: agent.workplace });
  }

  // Impulsiveness-driven idle preference (lazy agents)
  if (personality && personality.impulsiveness > 70) {
    for (const s of scores) {
      if (s.action === 'idle') s.score *= 1.3;
    }
  }

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

  // Economic behavior modifiers
  if (agentEcon) {
    if (agentEcon.money < 15) {
      for (const s of scores) {
        if (s.action === 'eating' && s.targetLocationId !== agent.home) s.score *= 0.5;
        if (s.action === 'shopping') s.score *= 0.3;
        if (tavern && s.targetLocationId === tavern.id) s.score *= 0.4;
      }
    }
    if (agentEcon.money > 80) {
      for (const s of scores) {
        if (tavern && s.targetLocationId === tavern.id) s.score *= 1.2;
        if (s.action === 'shopping') s.score *= 1.3;
      }
    }
  }

  // --- Opportunistic crime ---
  // Broke agents with low morality may attempt theft at shops or from nearby agents
  if (personality && agentEcon && agentEcon.money < 10 && personality.morality < 45) {
    const shop = nearestLocation(agent.position, allLocations, 'shop');
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

  return scores;
}

// --- Build action object ---

function buildAction(decision: ScoredAction): Record<string, unknown> {
  switch (decision.action) {
    case 'sleeping':
      return { type: 'sleeping' };
    case 'eating':
      return { type: 'eating', locationId: decision.targetLocationId ?? '' };
    case 'working':
      return { type: 'working', taskDescription: 'daily work' };
    case 'socializing':
      return { type: 'socializing', locationId: decision.targetLocationId ?? '' };
    case 'walking':
      return { type: 'walking', to: { x: 0, y: 0 } };
    case 'idle':
      return { type: 'idle', ...(decision.source ? { zoneActivity: decision.source } : {}) };
    case 'shopping':
      return { type: 'shopping', shopId: decision.targetLocationId ?? '', items: [] };
    default:
      return { type: 'idle' };
  }
}

// --- Main Tick ---

export function tick(world: WorldRow): void {
  const activeAgents = db
    .select()
    .from(agents)
    .where(eq(agents.is_active, true))
    .all();
  const allLocations = db.select().from(locations).all();
  const allRelationships = db.select().from(relationships).all();

  // Pre-load per-agent data into Maps to avoid N queries in the loop
  const allNeeds = db.select().from(needs).all();
  const needsMap = new Map(allNeeds.map(n => [n.agent_id, n]));
  const allEcon = db.select().from(economy).all();
  const econMap = new Map(allEcon.map(e => [e.agent_id, e]));

  // Pre-load active goals for goal alignment scoring
  const allActiveGoals = db.select().from(goals).where(eq(goals.status, 'active')).all();
  const goalsMap = new Map<number, (typeof allActiveGoals)>();
  for (const g of allActiveGoals) {
    const arr = goalsMap.get(g.agent_id) ?? [];
    arr.push(g);
    goalsMap.set(g.agent_id, arr);
  }

  // Cache conversation/queue data once per tick to avoid repeated full-table scans
  const allQueuedConvos = db.select().from(conversationQueue).all();
  const allActiveConvos = db.select().from(conversations).where(eq(conversations.status, 'active')).all();
  const allEndedConvos = db.select({ ended_at: conversations.ended_at, participants: conversations.participants })
    .from(conversations)
    .where(eq(conversations.status, 'ended'))
    .all();

  // Cache shared_knowledge for arrest mechanic
  const allActiveKnowledge = db.select().from(shared_knowledge)
    .where(eq(shared_knowledge.is_active, true))
    .all();

  const totalTicks = world.time.totalTicks;

  for (const agent of activeAgents) {
    // Skip agents whose current action is still in progress
    if (!isActionComplete(agent, totalTicks)) continue;

    // Plan generation: trigger when waking up OR when plan is stale during daytime.
    // The wake-up path catches the normal case; the stale-plan path catches agents
    // who missed a sleep→wake cycle (e.g., sick, depressed, or stuck agents).
    const completedActionType = (agent.current_action as any)?.type;
    const sched = agent.schedule as { wakeTime?: number; sleepTime?: number } | null;
    const wakeTime = sched?.wakeTime ?? 7;
    const sleepTime = sched?.sleepTime ?? 22;
    const effSleepTime = sleepTime === 0 ? 24 : sleepTime;
    const isDaytime = effSleepTime > wakeTime
      ? (world.time.hour >= wakeTime && world.time.hour < effSleepTime)
      : !(world.time.hour >= effSleepTime && world.time.hour < wakeTime);
    const currentPlan = (agent as any).daily_plan as { day: number } | null;
    const planIsStale = !currentPlan || currentPlan.day < (world.time.day ?? 1);

    if (completedActionType === 'sleeping' && world.time.hour >= wakeTime) {
      planGenerator.queueGeneration(agent.id, world.time.day ?? 1, world.time.totalTicks);
    } else if (isDaytime && planIsStale && completedActionType !== 'dead') {
      // Catch-all: agent has no plan for today but it's daytime — generate one now
      planGenerator.queueGeneration(agent.id, world.time.day ?? 1, world.time.totalTicks);
    }

    // Fetch per-agent data from pre-loaded Maps
    const agentNeeds = needsMap.get(agent.id);
    if (!agentNeeds) continue;

    const agentEcon = econMap.get(agent.id) ?? null;

    let decision: ScoredAction | null = null;

    // Phase 1: Emergency
    if (CONFIG.DECISIONS.EMERGENCY_OVERRIDE) {
      decision = checkEmergency(
        agent,
        agentNeeds,
        agentEcon,
        allLocations,
        allRelationships,
        activeAgents,
      );
    }

    // Phase 1b: Plan layer (score 6000 — above free-time, below emergency)
    if (!decision) {
      const planned = planExecutor.getPlannedAction(agent.id, world.time.hour, world.time.totalTicks, world.time.day);
      if (planned) {
        decision = planned;
      }
    }

    // Phase 2: Schedule
    if (!decision) {
      decision = checkSchedule(agent, world, allLocations);
    }

    // Phase 3: Free time scoring
    if (!decision) {
      const scored = scoreFreeTimeActions(
        agent,
        agentNeeds,
        agentEcon,
        allLocations,
        allRelationships,
        activeAgents,
        world,
        econMap,
      );
      if (scored.length > 0) {
        // Goal alignment bonus
        const agentGoals = goalsMap.get(agent.id) ?? [];
        for (const goal of agentGoals) {
          if (!goal.mapped_interactions) continue;
          let mapped: string[];
          try {
            const raw = goal.mapped_interactions;
            mapped = raw.startsWith('[') ? JSON.parse(raw) : raw.split(',').map((s: string) => s.trim());
          } catch { continue; }
          if (goal.target_id && mapped.length > 0) {
            const target = activeAgents.find(a => a.id === goal.target_id);
            if (target && agent.current_location === target.current_location) {
              for (const s of scored) {
                if (s.action === 'socializing' && s.targetAgentId === goal.target_id) {
                  s.score += Math.round(2500 * goal.priority);
                }
              }
            }
          }
        }

        scored.sort((a, b) => b.score - a.score);
        decision = scored[0];
      }
    }

    // Fallback
    if (!decision) {
      decision = { action: 'idle', score: 0, targetLocationId: agent.home };
    }

    // --- Validate action makes sense at target location ---
    if (decision != null && decision.targetLocationId != null) {
      const targetLoc = allLocations.find((l) => l.id === decision!.targetLocationId);
      if (targetLoc) {
        // Can't work at a location that isn't your workplace
        if (decision.action === 'working' && decision.targetLocationId !== agent.workplace) {
          decision = { action: 'idle', score: 0, targetLocationId: agent.home };
        }
        // Can't sleep anywhere except home
        if (decision!.action === 'sleeping' && decision!.targetLocationId !== agent.home) {
          decision = { action: 'sleeping', score: decision!.score, targetLocationId: agent.home };
        }
        // Check operating hours for commercial locations
        if (['eating', 'shopping'].includes(decision!.action) && targetLoc.operating_hours) {
          const hours = targetLoc.operating_hours as { open: number; close: number };
          if (world.time.hour < hours.open || world.time.hour >= hours.close) {
            decision = { action: 'idle', score: 0, targetLocationId: agent.home };
          }
        }
      }
    }

    // Build destination from the target location
    let destination: { x: number; y: number; locationId?: number } | null = null;
    let zoneTarget: { x: number; y: number } | null = null;
    let matchedZoneId: string | undefined;
    let matchedBuildingType: string | undefined;
    if (decision.targetLocationId) {
      const loc = allLocations.find((l) => l.id === decision!.targetLocationId);
      if (loc) {
        // Always pathfind to the entry point — this is guaranteed to be a walkable tile.
        // If the action targets an interior zone, store the zone center separately and
        // teleport the agent there on arrival (two-phase interior movement).
        const destX = loc.entry_point.x;
        const destY = loc.entry_point.y;

        const locType = loc.type as string;
        const zone = findAvailableZone(locType, decision!.action);
        if (zone) {
          const locPos = loc.position as { x: number; y: number; width: number; height: number };
          zoneTarget = {
            x: locPos.x + zone.center[0] * 32 + 16,
            y: locPos.y + zone.center[1] * 32 + 16,
          };
          matchedZoneId = zone.id;
          matchedBuildingType = locType;
        }

        destination = {
          x: destX,
          y: destY,
          locationId: loc.id,
        };
      }
    }

    // Determine action duration
    const durationKey = decision.action;
    const minDuration =
      CONFIG.DECISIONS.ACTION_MIN_DURATIONS[durationKey] ??
      CONFIG.DECISIONS.ACTION_MIN_DURATIONS['idle'];

    const actionDuration =
      decision.action === 'idle' &&
      agentNeeds.mood < CONFIG.NEEDS.MOOD_CRITICAL_THRESHOLD
        ? 120
        : minDuration;

    // If a zone target exists, embed its coordinates into the queued action so that
    // movement.ts can teleport the agent to the exact zone position on arrival.
    const baseAction = buildAction(decision);
    const finalAction = zoneTarget
      ? { ...baseAction, zoneX: zoneTarget.x, zoneY: zoneTarget.y, targetZone: matchedZoneId, targetBuildingType: matchedBuildingType }
      : baseAction;

    const needsToTravel =
      destination &&
      (Math.abs(agent.position.x - destination.x) > 4 ||
        Math.abs(agent.position.y - destination.y) > 4);

    if (needsToTravel) {
      db.update(agents)
        .set({
          current_action: { type: 'walking', to: { x: destination!.x, y: destination!.y } },
          current_destination: destination,
          action_started: totalTicks,
          action_duration: null,
          action_queue: [finalAction],
          current_path: null,
        })
        .where(eq(agents.id, agent.id))
        .run();
    } else {
      // Guard: never write a walking action without a destination — that creates an
      // unresolvable deadlock (movement skips it, decisions never re-assigns it).
      // If for any reason a 'walking' action reaches this branch, downgrade to idle.
      const safeAction =
        (finalAction as any).type === 'walking'
          ? { type: 'idle' }
          : finalAction;
      const safeDuration =
        (finalAction as any).type === 'walking'
          ? (CONFIG.DECISIONS.ACTION_MIN_DURATIONS['idle'] ?? 10)
          : actionDuration;

      // If action has zone coordinates and agent is already at the building,
      // move them to the interior zone position directly
      const zonePos = (safeAction as any).zoneX !== undefined && (safeAction as any).zoneY !== undefined
        ? { x: (safeAction as any).zoneX, y: (safeAction as any).zoneY }
        : undefined;

      db.update(agents)
        .set({
          current_action: safeAction,
          current_destination: null,
          action_started: totalTicks,
          action_duration: safeDuration,
          current_path: null,
          action_queue: [],
          ...(zonePos ? { position: zonePos } : {}),
        })
        .where(eq(agents.id, agent.id))
        .run();
    }

    // Log zone-driven activities to activity feed
    if (decision.source && ['contemplate', 'fish', 'garden', 'forage', 'perform', 'jog', 'browse', 'shoplifting', 'pickpocket'].includes(decision.source)) {
      const activityNames: Record<string, string> = {
        contemplate: 'is contemplating by the riverside',
        fish: 'is fishing at the river',
        garden: 'is tending the garden',
        forage: 'is foraging in the grove',
        perform: 'is performing in the town square',
        jog: 'is jogging around town',
        browse: 'is browsing the market stalls',
        shoplifting: 'is eyeing goods at the shop suspiciously',
        pickpocket: 'is lurking near someone with money',
      };
      logActivity({
        type: decision.source as string,
        initiator: agent.id,
        templateData: { agent: agent.name, description: `${agent.name} ${activityNames[decision.source] ?? decision.source}` },
      });
    }

    // Crime execution — resolve theft when agent starts the action
    if (decision.source === 'shoplifting' || decision.source === 'pickpocket') {
      const thief = agent;
      const thiefEcon = agentEcon;
      if (thiefEcon) {
        const stolenAmount = Math.floor(5 + Math.random() * 10); // $5-15
        const caught = Math.random() < 0.35; // 35% chance caught

        if (decision.source === 'pickpocket' && decision.targetAgentId) {
          const victimEcon = db.select().from(economy).where(eq(economy.agent_id, decision.targetAgentId)).get();
          const victimAgent = activeAgents.find(a => a.id === decision.targetAgentId);
          if (victimEcon && victimAgent && victimEcon.money >= stolenAmount) {
            db.update(economy).set({ money: victimEcon.money - stolenAmount }).where(eq(economy.id, victimEcon.id)).run();
            db.update(economy).set({ money: thiefEcon.money + stolenAmount }).where(eq(economy.id, thiefEcon.id)).run();
            if (caught) {
              createFact('theft', thief.id, decision.targetAgentId, 2, [thief.id, decision.targetAgentId], 'witnessed');
              simEvents.emit('economy:theft_caught', {
                agentId: thief.id, perpetratorId: thief.id, victimId: decision.targetAgentId,
                locationId: thief.current_location,
              });
              logActivity({ type: 'drama', initiator: thief.id, target: decision.targetAgentId,
                templateData: { description: `${thief.name} was caught pickpocketing $${stolenAmount} from ${victimAgent.name}!` } });
            } else {
              logActivity({ type: 'drama', initiator: thief.id,
                templateData: { description: `${thief.name} stole $${stolenAmount} from ${victimAgent.name} without being noticed` } });
              simEvents.emit('economy:theft_success', { agentId: thief.id, thief: thief.id, victim: decision.targetAgentId, amount: stolenAmount });
            }
          }
        } else if (decision.source === 'shoplifting') {
          // Steal from shop — no specific victim, just gain money
          db.update(economy).set({ money: thiefEcon.money + stolenAmount }).where(eq(economy.id, thiefEcon.id)).run();
          if (caught) {
            createFact('theft', thief.id, null, 2, [thief.id], 'witnessed');
            simEvents.emit('economy:theft_caught', {
              agentId: thief.id, perpetratorId: thief.id,
              locationId: thief.current_location,
            });
            logActivity({ type: 'drama', initiator: thief.id,
              templateData: { description: `${thief.name} was caught shoplifting $${stolenAmount} worth of goods!` } });
          } else {
            logActivity({ type: 'drama', initiator: thief.id,
              templateData: { description: `${thief.name} shoplifted $${stolenAmount} worth of goods` } });
          }
        }
      }
    }

    // Social decisions -> conversation queue (only if agents are at same location)
    // Skip if queue is already full
    if (decision.action === 'socializing' && decision.targetAgentId && allQueuedConvos.length < CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE * 3) {
      const agentId = agent.id;
      const targetId = decision.targetAgentId;

      // Both agents must be at the same location to start a conversation
      const targetAgent = activeAgents.find(a => a.id === targetId);
      if (!targetAgent) continue;
      const sameLocation = agent.current_location != null &&
        agent.current_location === targetAgent.current_location;
      const closeEnough = !sameLocation && targetAgent.position &&
        distance(agent.position, targetAgent.position) < 64; // within 2 tiles
      if (!sameLocation && !closeEnough) continue;

      // Check if this pair already has a queued conversation (from cached data)
      const existingQueue = allQueuedConvos.filter(q => {
        const p = q.participants as number[];
        return p.includes(agentId) && p.includes(targetId);
      });
      if (existingQueue.length > 0) continue; // Already queued

      // Check if this pair already has an active conversation (from cached data)
      const existingActive = allActiveConvos.filter(c => {
        const p = c.participants as number[];
        return p.includes(agentId) && p.includes(targetId);
      });
      if (existingActive.length > 0) continue; // Already talking

      // Cooldown: skip if this pair talked recently (prevents pair domination)
      const cooldownMs = CONFIG.CONVERSATIONS.COOLDOWN_SAME_PAIR_HOURS * 60 * 1000;
      const lastConvoForPair = allEndedConvos
        .filter(c => {
          const p = c.participants as number[];
          return p.includes(agentId) && p.includes(targetId);
        })
        .sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0))[0];
      if (lastConvoForPair?.ended_at && Date.now() - lastConvoForPair.ended_at < cooldownMs) continue;

      const rel = getRelationshipValues(
        allRelationships,
        agentId,
        targetId,
      );
      const friendship = rel?.friendship ?? 0;
      const romance = rel?.romance ?? 0;

      // Topic selection: use plan-provided topic if available, else personality-driven
      const agentPersonality = agent.personality as PersonalityProfile | null;
      let topic: string | null = decision.topic ?? null;
      if (!topic && agentPersonality) {
        const otherActiveAgents = activeAgents.filter(a => a.id !== agent.id && a.id !== targetId);
        topic = selectPersonalityTopic(
          agentPersonality,
          agentNeeds.mood,
          friendship,
          romance,
          otherActiveAgents.map(a => ({ name: a.name })),
        );
      }

      // Gossip override: dishonest + curious agents prefer to share real facts
      if (!topic && agentPersonality && agentPersonality.honesty < 40 && agentPersonality.curiosity > 60) {
        const gossipFacts = getShareableFacts(agentId, targetId, agentPersonality);
        if (gossipFacts.length > 0) {
          const subjectName = getAgentName((gossipFacts[0] as any).subject_id);
          topic = `gossip about ${subjectName}`;
        }
      }

      // Economic topic override
      if (!topic && agentEcon) {
        if (agentEcon.money < 15 && Math.random() < 0.3) {
          topic = 'financial struggles';
        } else if (agentEcon.money > 80 && friendship > 40 && Math.random() < 0.15) {
          topic = 'the town economy';
        }
      }

      // --- Determine conversation tier: LLM only for meaningful interactions ---
      const agentStatesArr = getAgentStates(agentId);
      // Depressed agents skip conversations entirely — don't queue them
      if ((agentStatesArr as string[]).includes('depressed')) continue;
      const targetStatesArr = getAgentStates(targetId);
      const dramaticStates = ['jealous', 'heartbroken', 'angry', 'alcoholic', 'in_debt', 'depressed', 'drunk', 'infatuated'] as const;
      const hasDramaticState = dramaticStates.some(s => (agentStatesArr as string[]).includes(s) || (targetStatesArr as string[]).includes(s));

      const dramaticTopics = ['gossip', 'flirting', 'confrontation', 'venting', 'seeking comfort'];
      const hasDramaticTopic = topic ? dramaticTopics.some(t => topic!.includes(t)) : false;

      const hasHighRomance = romance > 30;
      const isEmotionalExtreme = agentNeeds.mood < 25 || agentNeeds.mood > 85;

      // Check familiarity for first meetings
      const relRow = allRelationships.find(
        r => (r.agent_a === agentId && r.agent_b === targetId) ||
             (r.agent_b === agentId && r.agent_a === targetId),
      );
      const isFirstMeeting = !relRow || relRow.familiarity < 5;

      // Check for gossip to share
      const hasGossip = agentPersonality
        ? getShareableFacts(agentId, targetId, agentPersonality).length > 0
        : false;

      let tier: string;
      if (hasDramaticState || hasDramaticTopic || isFirstMeeting) {
        tier = 'llm_deep'; // 6 turns — dramatic moments
      } else if (hasHighRomance || isEmotionalExtreme || hasGossip) {
        tier = 'llm_standard'; // 4 turns — notable situations
      } else if (friendship > 40 || romance > 10 || agentNeeds.mood < 40 || agentNeeds.social < 30) {
        tier = 'llm_standard'; // 4 turns — friends talking, lonely/sad agents
      } else {
        tier = 'template'; // no LLM — acquaintances with nothing to say
      }

      const priority = Math.round(100 - agentNeeds.social + (friendship > 50 ? 20 : 0));

      db.insert(conversationQueue)
        .values({
          participants: [agentId, targetId],
          tier,
          priority,
          trigger_reason: 'needs_social',
          topic,
          queued_at: Date.now(),
          max_wait: 10000,
        })
        .run();
    }
  }

  // --- Tavern/Location Encounter: queue conversations between co-located agents ---
  // Groups agents by location, then queues conversations for pairs that aren't already talking
  const locationGroups = new Map<number, typeof activeAgents>();
  const socialLocTypes = new Set(['tavern', 'town_square', 'park']);
  for (const agent of activeAgents) {
    if (agent.current_location == null) continue;
    const action = agent.current_action as any;
    if (action?.type === 'talking' || action?.type === 'sleeping' || action?.type === 'working') continue;

    const group = locationGroups.get(agent.current_location) ?? [];
    group.push(agent);
    locationGroups.set(agent.current_location, group);
  }

  for (const [locId, group] of locationGroups) {
    if (group.length < 2) continue;
    const loc = allLocations.find(l => l.id === locId);
    if (!loc || !socialLocTypes.has(loc.type)) continue;

    // Pick a random pair from the group (max 1 new conversation per location per tick)
    if (Math.random() > 0.15) continue; // 15% chance per tick per social location
    const shuffled = group.sort(() => Math.random() - 0.5);
    const a = shuffled[0];
    const b = shuffled[1];

    // Check if this pair already has a queued or active conversation (from cached data)
    const existingQueue2 = allQueuedConvos.filter(q => {
      const p = q.participants as number[];
      return p.includes(a.id) && p.includes(b.id);
    });
    if (existingQueue2.length > 0) continue;

    const existingActive2 = allActiveConvos.filter(c => {
      const p = c.participants as number[];
      return p.includes(a.id) && p.includes(b.id);
    });
    if (existingActive2.length > 0) continue;

    // Cooldown check (from cached data)
    const cooldownMs2 = CONFIG.CONVERSATIONS.COOLDOWN_SAME_PAIR_HOURS * 60 * 1000;
    const lastConvo = allEndedConvos
      .filter(c => {
        const p = c.participants as number[];
        return p.includes(a.id) && p.includes(b.id);
      })
      .sort((x, y) => (y.ended_at ?? 0) - (x.ended_at ?? 0))[0];
    if (lastConvo?.ended_at && Date.now() - lastConvo.ended_at < cooldownMs2) continue;

    const rel = getRelationshipValues(allRelationships, a.id, b.id);
    const friendship = rel?.friendship ?? 0;
    const romance = rel?.romance ?? 0;

    // Use the same tier logic as regular socializing
    const aStates = getAgentStates(a.id);
    const bStates = getAgentStates(b.id);
    // Skip if either agent is depressed — they avoid conversations
    if ((aStates as string[]).includes('depressed') || (bStates as string[]).includes('depressed')) continue;
    const dramaticStates = ['jealous', 'heartbroken', 'angry', 'alcoholic', 'in_debt', 'drunk', 'infatuated'] as const;
    const hasDrama = dramaticStates.some(s => (aStates as string[]).includes(s) || (bStates as string[]).includes(s));

    const aNeeds = needsMap.get(a.id);
    const aMood = aNeeds?.mood ?? 50;

    let tier: string;
    if (hasDrama || friendship < -20) {
      tier = 'llm_deep';
    } else if (romance > 30 || aMood < 25 || aMood > 85) {
      tier = 'llm_standard';
    } else if (friendship > 40 || romance > 10 || aMood < 40) {
      tier = 'llm_standard';
    } else {
      tier = 'template';
    }

    const aPersonality = a.personality as PersonalityProfile | null;
    let topic: string | null = null;
    if (aPersonality) {
      const others = activeAgents.filter(x => x.id !== a.id && x.id !== b.id);
      topic = selectPersonalityTopic(aPersonality, aMood, friendship, romance, others.map(x => ({ name: x.name })));
    }

    db.insert(conversationQueue).values({
      participants: [a.id, b.id],
      tier,
      priority: 50,
      trigger_reason: `location_encounter:${loc.type}`,
      topic,
      queued_at: Date.now(),
      max_wait: 10000,
    }).run();
  }

  // --- Constable Arrest Mechanic ---
  // If the constable is at the same location as an agent with 8+ negative facts, arrest them
  for (const agent of activeAgents) {
    const agentEconRow = econMap.get(agent.id);
    if (!agentEconRow || agentEconRow.job !== 'constable') continue;
    if (agent.current_location == null) continue;
    if ((agent.current_action as any)?.type === 'sleeping') continue;

    // Find co-located agents with high negative fact counts
    for (const other of activeAgents) {
      if (other.id === agent.id || other.current_location !== agent.current_location) continue;
      if ((other.current_action as any)?.type === 'idle' && other.current_location != null) {
        // Check if already at prison (don't re-arrest)
        const loc = allLocations.find(l => l.id === other.current_location);
        if (loc?.type === 'prison') continue;
      }

      const negFacts = getNegativeFactCount(other.id);

      // Check if constable has direct knowledge of crimes by this target (from cached data)
      const allKnowledgeFacts = allActiveKnowledge
        .filter(f => {
          const knownBy = f.known_by as number[];
          return knownBy.includes(agent.id) && // constable knows
            f.subject_id === other.id && // about this target
            ['theft', 'blackmail', 'seduction'].includes(f.type);
        });

      const arrestThreshold = allKnowledgeFacts.length > 0 ? 4 : 8;
      if (negFacts < arrestThreshold) continue;

      // 25% chance when constable has direct crime knowledge, 10% otherwise
      const arrestChance = allKnowledgeFacts.length > 0 ? 0.25 : 0.1;
      if (Math.random() > arrestChance) continue;

      // Find the prison
      const prison = allLocations.find(l => l.type === 'prison');
      if (!prison) continue;

      // Arrest: teleport criminal to prison entrance, then idle for 480 ticks (8 hours)
      db.update(agents).set({
        current_action: { type: 'idle' },
        position: { x: prison.entry_point.x, y: prison.entry_point.y },
        current_destination: null,
        current_location: prison.id,
        action_started: totalTicks,
        action_duration: 480,
        action_queue: [],
        current_path: null,
      }).where(eq(agents.id, other.id)).run();

      // Log the arrest
      const [ordA, ordB] = [Math.min(agent.id, other.id), Math.max(agent.id, other.id)];
      db.insert(relationshipEvents).values({
        agent_a: ordA,
        agent_b: ordB,
        event_type: 'arrested',
        description: `${agent.name} arrested ${other.name}`,
        friendship_delta_ab: agent.id === ordA ? -10 : 0,
        friendship_delta_ba: agent.id === ordA ? 0 : -10,
        romance_delta_ab: 0, romance_delta_ba: 0,
        trust_delta_ab: agent.id === ordA ? -20 : 0,
        trust_delta_ba: agent.id === ordA ? 0 : -20,
        sentiment: -0.8,
        processed: false,
        timestamp: Date.now(),
      }).run();

      logActivity({
        type: 'drama',
        initiator: agent.id,
        target: other.id,
        templateData: { description: `${agent.name} arrested ${other.name}!` },
      });

      // Create arrest gossip fact
      createFact('arrest', other.id, agent.id, 2, [agent.id, other.id], 'witnessed', { detail: `arrested by ${agent.name}` });
      simEvents.emit('crime:arrested', { agentId: other.id, constableName: agent.name });

      // Arrest memories
      simEvents.emit('interaction:completed', {
        agentId: agent.id, otherName: other.name,
        action: `arrested ${other.name}`,
      });
      simEvents.emit('interaction:completed', {
        agentId: other.id, otherName: agent.name,
        action: `was arrested by ${agent.name}`,
      });

      break; // One arrest per tick
    }
  }

  emitter.markDirty('agents.all');
}
