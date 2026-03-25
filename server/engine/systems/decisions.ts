import { db } from '../../db';
import {
  agents,
  needs,
  economy,
  relationships,
  locations,
  conversationQueue,
  conversations,
} from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { distance } from '../../lib/utils';
import { emitter } from '../emitter';
import {
  PersonalityProfile,
  warmthMultiplier,
  neuroticismMoodFactor,
  loyaltyBonus,
  sensualityBonus,
  curiosityNoveltyBonus,
  selectPersonalityTopic,
} from '../../lib/personality';
import { getEffectivePersonality, getAgentStates } from '../../lib/states';
import { agentStates } from '../../db/schema';
import { createFact, getShareableFacts, getAgentName } from '../../lib/gossip';

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
}

// Tracks consecutive work skips per agent to detect work_issue pattern
const workSkipCount = new Map<number, number>();

// --- Helpers ---

function isActionComplete(agent: AgentRow, totalTicks: number): boolean {
  if (agent.current_action == null) return true;

  const actionType =
    typeof agent.current_action === 'object' ? (agent.current_action as any).type : agent.current_action;

  // Walking agents are never "complete" here — movement system handles arrival
  if (actionType === 'walking') return false;

  // Talking agents wait for conversation system to end the conversation
  if (actionType === 'talking') return false;

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

function cheapestFoodPrice(): number {
  return Math.min(
    CONFIG.ECONOMY.BASE_PRICES['food_raw'] ?? 3,
    CONFIG.ECONOMY.BASE_PRICES['food_prepared'] ?? 6,
  );
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

  // Sick → go home immediately, override schedule
  const agentStateTypes = getAgentStates(agent.id);
  if (agentStateTypes.includes('sick')) {
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

  // Sleep time: handle wrap-around
  if (hour >= sched.sleepTime || hour < sched.wakeTime) {
    return { action: 'sleeping', score: 5000, targetLocationId: agent.home };
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
    const foodLoc = nearestLocation(agent.position, allLocations, ['shop', 'tavern']);
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
  _agentEcon: EconRow | null,
  allLocations: LocationRow[],
  allRelationships: RelRow[],
  otherAgents: AgentRow[],
  world: WorldRow,
): ScoredAction[] {
  const scores: ScoredAction[] = [];
  const evening = isEvening(world.time.hour);
  const personality = getEffectivePersonality(agent.id) ?? agent.personality as PersonalityProfile | null;
  const mood = agentNeeds.mood;
  const agentStateTypes = getAgentStates(agent.id);

  // Eat
  let eatScore = (100 - agentNeeds.hunger) * 1.5 + (mood < 40 ? 10 : 0);
  if (personality) {
    eatScore *= 1 + (personality.impulsiveness / 200);
  }
  const foodLoc = nearestLocation(agent.position, allLocations, ['shop', 'tavern']);
  scores.push({
    action: 'eating',
    score: addNoise(eatScore),
    targetLocationId: foodLoc?.id ?? agent.home,
  });

  // Socialize per agent
  for (const other of otherAgents) {
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

    if (personality) {
      socScore *= warmthMultiplier(personality.warmth);
      socScore *= neuroticismMoodFactor(personality.neuroticism, mood);
      socScore += loyaltyBonus(personality.loyalty, friendship);
      socScore += sensualityBonus(personality.sensuality, romance);
      socScore += curiosityNoveltyBonus(personality.curiosity, interactionCount);
    } else {
      // Fallback: legacy trait checks
      if (agent.traits.includes('introverted')) socScore *= 0.7;
      if (agent.traits.includes('extroverted')) socScore *= 1.3;
    }

    // Personality-based warmth thresholds replace old string traits when personality is set
    if (personality && personality.warmth < 35) socScore *= 0.7;
    if (personality && personality.warmth > 65) socScore *= 1.3;

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

  // Tavern
  const tavern = nearestLocation(agent.position, allLocations, 'tavern');
  if (tavern) {
    let tavernScore = (100 - agentNeeds.fun) * 0.8 + (100 - agentNeeds.social) * 0.6;
    if (evening) tavernScore += 15;
    // Hungover → avoid tavern
    if (agentStateTypes.includes('hungover')) {
      tavernScore = 0;
    }
    scores.push({ action: 'socializing', score: addNoise(tavernScore), targetLocationId: tavern.id });
  }

  // Go home
  let homeScore = (100 - agentNeeds.energy) * 1.0;
  if (agentNeeds.comfort < 40) homeScore += 15;
  scores.push({ action: 'idle', score: addNoise(homeScore), targetLocationId: agent.home });

  // Walk in square
  const square = nearestLocation(agent.position, allLocations, 'town_square');
  if (square) {
    const walkScore = 20 + (agentNeeds.fun < 60 ? 10 : 0);
    scores.push({ action: 'walking', score: addNoise(walkScore), targetLocationId: square.id });
  }

  // Workaholic bonus (personality-based or legacy trait)
  const isWorkaholic = personality ? personality.impulsiveness < 25 : agent.traits.includes('workaholic');
  if (isWorkaholic && agent.workplace) {
    let workScore = 30;
    workScore *= 1.4;
    if (personality) {
      workScore *= (100 - personality.impulsiveness) / 100;
    }
    scores.push({ action: 'working', score: addNoise(workScore), targetLocationId: agent.workplace });
  }

  // Lazy bonus (personality-based or legacy trait)
  const isLazy = personality ? personality.impulsiveness > 70 : agent.traits.includes('lazy');
  if (isLazy) {
    for (const s of scores) {
      if (s.action === 'idle') s.score *= 1.3;
    }
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
      return { type: 'idle' };
    case 'shopping':
      return { type: 'shopping', shopId: decision.targetLocationId ?? '', items: [] };
    default:
      return { type: 'idle' };
  }
}

// --- Main Tick ---

export async function tick(world: WorldRow): Promise<void> {
  const activeAgents = db
    .select()
    .from(agents)
    .where(eq(agents.is_active, true))
    .all();
  const allLocations = db.select().from(locations).all();
  const allRelationships = db.select().from(relationships).all();

  const totalTicks = world.time.totalTicks;

  for (const agent of activeAgents) {
    // Skip agents whose current action is still in progress
    if (!isActionComplete(agent, totalTicks)) continue;

    // Fetch per-agent data
    const agentNeeds = db
      .select()
      .from(needs)
      .where(eq(needs.agent_id, agent.id))
      .get();
    if (!agentNeeds) continue;

    const agentEcon = db
      .select()
      .from(economy)
      .where(eq(economy.agent_id, agent.id))
      .get() ?? null;

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
      );
      if (scored.length > 0) {
        scored.sort((a, b) => b.score - a.score);
        decision = scored[0];
      }
    }

    // Fallback
    if (!decision) {
      decision = { action: 'idle', score: 0, targetLocationId: agent.home };
    }

    // Build destination from the target location
    let destination: { x: number; y: number; locationId?: number } | null = null;
    if (decision.targetLocationId) {
      const loc = allLocations.find((l) => l.id === decision!.targetLocationId);
      if (loc) {
        destination = {
          x: loc.entry_point.x,
          y: loc.entry_point.y,
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

    // If agent needs to travel to destination, walk first then do the action
    const finalAction = buildAction(decision);
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
      db.update(agents)
        .set({
          current_action: finalAction,
          current_destination: null,
          action_started: totalTicks,
          action_duration: actionDuration,
          current_path: null,
        })
        .where(eq(agents.id, agent.id))
        .run();
    }

    // Social decisions -> conversation queue
    if (decision.action === 'socializing' && decision.targetAgentId) {
      const agentId = agent.id;
      const targetId = decision.targetAgentId;

      // Check if this pair already has a queued conversation
      const existingQueue = db.select().from(conversationQueue).all()
        .filter(q => {
          const p = q.participants as number[];
          return p.includes(agentId) && p.includes(targetId);
        });
      if (existingQueue.length > 0) continue; // Already queued

      // Check if this pair already has an active conversation
      const existingActive = db.select().from(conversations)
        .where(eq(conversations.status, 'active')).all()
        .filter(c => {
          const p = c.participants as number[];
          return p.includes(agentId) && p.includes(targetId);
        });
      if (existingActive.length > 0) continue; // Already talking

      const rel = getRelationshipValues(
        allRelationships,
        agentId,
        targetId,
      );
      const friendship = rel?.friendship ?? 0;
      const romance = rel?.romance ?? 0;
      let tier = 'llm_standard';
      if (friendship > 70 || romance > 50) {
        tier = 'llm_deep';
      } else if (friendship < 10) {
        tier = 'template';
      }

      const priority = Math.round(100 - agentNeeds.social + (friendship > 50 ? 20 : 0));

      // Personality-driven topic selection
      const agentPersonality = agent.personality as PersonalityProfile | null;
      let topic: string | null = null;
      if (agentPersonality) {
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

  emitter.markDirty('agents.all');
}
