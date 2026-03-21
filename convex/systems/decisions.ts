import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { CONFIG } from "../engine/constants";
import { distance } from "../lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Agent = Doc<"agents">;
type Needs = Doc<"needs">;
type Economy = Doc<"economy">;
type Location = Doc<"locations">;
type Relationship = Doc<"relationships">;
type WorldState = Doc<"worldState">;

interface ScoredAction {
  action: string;
  score: number;
  targetLocationId?: Id<"locations">;
  targetAgentId?: Id<"agents">;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isActionComplete(agent: Agent, totalTicks: number): boolean {
  if (
    agent.currentAction == null ||
    (typeof agent.currentAction === "object" && agent.currentAction.type === "idle" && agent.actionDuration === null)
  ) {
    return true;
  }
  if (agent.actionDuration !== null) {
    return (totalTicks - agent.actionStarted) >= agent.actionDuration;
  }
  // No duration set — treat as complete so we can reassign
  return true;
}

function nearestLocation(
  agentPos: { x: number; y: number },
  locations: Location[],
  typeFilter: string | string[],
): Location | null {
  const types = Array.isArray(typeFilter) ? typeFilter : [typeFilter];
  const candidates = locations.filter((l) => types.includes(l.type));
  if (candidates.length === 0) return null;

  let best: Location | null = null;
  let bestDist = Infinity;
  for (const loc of candidates) {
    const d = distance(agentPos, loc.entryPoint);
    if (d < bestDist) {
      bestDist = d;
      best = loc;
    }
  }
  return best;
}

function getRelationshipValues(
  relationships: Relationship[],
  agentId: Id<"agents">,
  otherId: Id<"agents">,
): { friendship: number; romance: number; trust: number } | null {
  for (const r of relationships) {
    if (r.agentA === agentId && r.agentB === otherId) {
      return { friendship: r.friendshipAB, romance: r.romanceAB, trust: r.trustAB };
    }
    if (r.agentB === agentId && r.agentA === otherId) {
      return { friendship: r.friendshipBA, romance: r.romanceBA, trust: r.trustBA };
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
    CONFIG.ECONOMY.BASE_PRICES["food_raw"] ?? 3,
    CONFIG.ECONOMY.BASE_PRICES["food_prepared"] ?? 6,
  );
}

// ---------------------------------------------------------------------------
// Core: Emergency Check
// ---------------------------------------------------------------------------

function checkEmergency(
  agent: Agent,
  needs: Needs,
  economy: Economy | null,
  locations: Location[],
  relationships: Relationship[],
  otherAgents: Agent[],
): ScoredAction | null {
  const critical = needs.thresholds?.critical ?? CONFIG.NEEDS.THRESHOLDS.critical;

  // Collect critically low needs
  const crises: { need: string; value: number }[] = [];
  if (needs.hunger < critical) crises.push({ need: "hunger", value: needs.hunger });
  if (needs.energy < critical) crises.push({ need: "energy", value: needs.energy });
  if (needs.social < critical) crises.push({ need: "social", value: needs.social });

  // Also check mood isolation
  if (needs.mood < CONFIG.NEEDS.MOOD_CRITICAL_THRESHOLD) {
    return {
      action: "idle",
      score: 9999,
      targetLocationId: agent.home,
    };
  }

  if (crises.length === 0) return null;

  // Pick worst crisis
  crises.sort((a, b) => a.value - b.value);
  const worst = crises[0];

  switch (worst.need) {
    case "hunger": {
      const money = economy?.money ?? 0;
      if (money >= cheapestFoodPrice()) {
        const shop = nearestLocation(agent.position, locations, "shop");
        if (shop) {
          return { action: "eating", score: 9999, targetLocationId: shop._id };
        }
      }
      // Can't afford food or no shop — go home
      return { action: "eating", score: 9999, targetLocationId: agent.home };
    }
    case "energy": {
      return { action: "sleeping", score: 9999, targetLocationId: agent.home };
    }
    case "social": {
      // Find nearest agent with friendship > 20
      let bestTarget: { agentId: Id<"agents">; locationId: Id<"locations"> | null; dist: number } | null = null;
      for (const other of otherAgents) {
        if (other._id === agent._id || !other.isActive) continue;
        const rel = getRelationshipValues(relationships, agent._id, other._id);
        if (rel && rel.friendship > 20) {
          const d = distance(agent.position, other.position);
          if (!bestTarget || d < bestTarget.dist) {
            bestTarget = { agentId: other._id, locationId: other.currentLocation, dist: d };
          }
        }
      }
      if (bestTarget) {
        // Go toward the friendly agent — if they're at a location, go there
        const targetLoc = bestTarget.locationId
          ? bestTarget.locationId
          : nearestLocation(agent.position, locations, "town_square")?._id ?? undefined;
        return { action: "socializing", score: 9999, targetLocationId: targetLoc, targetAgentId: bestTarget.agentId };
      }
      // Fallback: tavern or town square
      const social = nearestLocation(agent.position, locations, ["tavern", "town_square"]);
      if (social) {
        return { action: "socializing", score: 9999, targetLocationId: social._id };
      }
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Core: Schedule Check
// ---------------------------------------------------------------------------

function checkSchedule(
  agent: Agent,
  world: WorldState,
  locations: Location[],
): ScoredAction | null {
  const { hour, minute } = world.time;
  const sched = agent.schedule;

  // Sleep time: handle wrap-around (e.g. sleepTime=22, wakeTime=6)
  if (hour >= sched.sleepTime || hour < sched.wakeTime) {
    return { action: "sleeping", score: 5000, targetLocationId: agent.home };
  }

  // Work time
  if (agent.workplace && hour >= sched.workStart && hour < sched.workEnd) {
    return { action: "working", score: 4000, targetLocationId: agent.workplace };
  }

  // Lunch time (±30 min window)
  const lunchMinutes = sched.lunchTime * 60;
  const currentMinutes = hour * 60 + minute;
  if (Math.abs(currentMinutes - lunchMinutes) <= 30) {
    // Find food location
    const foodLoc = nearestLocation(agent.position, locations, ["shop", "tavern"]);
    if (foodLoc) {
      return { action: "eating", score: 3000, targetLocationId: foodLoc._id };
    }
    return { action: "eating", score: 3000, targetLocationId: agent.home };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core: Free Time Scoring
// ---------------------------------------------------------------------------

function scoreFreeTimeActions(
  agent: Agent,
  needs: Needs,
  economy: Economy | null,
  locations: Location[],
  relationships: Relationship[],
  otherAgents: Agent[],
  world: WorldState,
): ScoredAction[] {
  const scores: ScoredAction[] = [];
  const evening = isEvening(world.time.hour);

  // --- Eat ---
  const eatScore = (100 - needs.hunger) * 1.5 + (needs.mood < 40 ? 10 : 0);
  const foodLoc = nearestLocation(agent.position, locations, ["shop", "tavern"]);
  scores.push({
    action: "eating",
    score: addNoise(eatScore),
    targetLocationId: foodLoc?._id ?? agent.home,
  });

  // --- Socialize (per nearby agent) ---
  for (const other of otherAgents) {
    if (other._id === agent._id || !other.isActive) continue;
    const rel = getRelationshipValues(relationships, agent._id, other._id);
    const friendship = rel?.friendship ?? 0;
    const romance = rel?.romance ?? 0;
    const trust = rel?.trust ?? 0;

    let socScore = (100 - needs.social) * 1.2;
    if (friendship > 50) socScore += 15;
    if (romance > 30) socScore += 20;
    if (friendship < -30) socScore -= 25;
    if (needs.mood < 30 && trust > 50) socScore += 20;

    // Personality modifier
    if (agent.traits.includes("introverted")) socScore *= 0.7;
    if (agent.traits.includes("extroverted")) socScore *= 1.3;

    scores.push({
      action: "socializing",
      score: addNoise(socScore),
      targetAgentId: other._id,
      targetLocationId: other.currentLocation ?? undefined,
    });
  }

  // --- Visit tavern ---
  const tavern = nearestLocation(agent.position, locations, "tavern");
  if (tavern) {
    let tavernScore = (100 - needs.fun) * 0.8 + (100 - needs.social) * 0.6;
    if (evening) tavernScore += 15;
    scores.push({ action: "socializing", score: addNoise(tavernScore), targetLocationId: tavern._id });
  }

  // --- Go home ---
  let homeScore = (100 - needs.energy) * 1.0;
  if (needs.comfort < 40) homeScore += 15;
  scores.push({ action: "idle", score: addNoise(homeScore), targetLocationId: agent.home });

  // --- Walk in square ---
  const square = nearestLocation(agent.position, locations, "town_square");
  if (square) {
    let walkScore = 20 + (needs.fun < 60 ? 10 : 0);
    scores.push({ action: "walking", score: addNoise(walkScore), targetLocationId: square._id });
  }

  // --- Personality: workaholic bonus for working ---
  if (agent.traits.includes("workaholic") && agent.workplace) {
    let workScore = 30;
    workScore *= 1.4;
    scores.push({ action: "working", score: addNoise(workScore), targetLocationId: agent.workplace });
  }

  // --- Personality: lazy bonus for idle ---
  if (agent.traits.includes("lazy")) {
    for (const s of scores) {
      if (s.action === "idle") s.score *= 1.3;
    }
  }

  return scores;
}

// ---------------------------------------------------------------------------
// Build the action object matching AgentAction type
// ---------------------------------------------------------------------------

function buildAction(
  decision: ScoredAction,
): Record<string, unknown> {
  switch (decision.action) {
    case "sleeping":
      return { type: "sleeping" };
    case "eating":
      return { type: "eating", locationId: decision.targetLocationId ?? "" };
    case "working":
      return { type: "working", taskDescription: "daily work" };
    case "socializing":
      return { type: "socializing", locationId: decision.targetLocationId ?? "" };
    case "walking":
      return { type: "walking", to: { x: 0, y: 0 } }; // destination set via currentDestination
    case "idle":
      return { type: "idle" };
    case "shopping":
      return { type: "shopping", shopId: decision.targetLocationId ?? "", items: [] };
    default:
      return { type: "idle" };
  }
}

// ---------------------------------------------------------------------------
// Main Tick
// ---------------------------------------------------------------------------

export async function tick(ctx: MutationCtx, world: WorldState): Promise<void> {
  // Fetch all shared data once
  const allAgents = await ctx.db.query("agents").collect();
  const activeAgents = allAgents.filter((a) => a.isActive);
  const allLocations = await ctx.db.query("locations").collect();
  const allRelationships = await ctx.db.query("relationships").collect();

  const totalTicks = world.time.totalTicks;

  for (const agent of activeAgents) {
    // Skip agents whose current action is still in progress
    if (!isActionComplete(agent, totalTicks)) continue;

    // Fetch per-agent data
    const needs = await ctx.db
      .query("needs")
      .withIndex("by_agentId", (q) => q.eq("agentId", agent._id))
      .first();
    if (!needs) continue;

    const economy = await ctx.db
      .query("economy")
      .withIndex("by_agentId", (q) => q.eq("agentId", agent._id))
      .first();

    let decision: ScoredAction | null = null;

    // Phase 1: Emergency
    if (CONFIG.DECISIONS.EMERGENCY_OVERRIDE) {
      decision = checkEmergency(
        agent,
        needs,
        economy,
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
        needs,
        economy,
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
      decision = { action: "idle", score: 0, targetLocationId: agent.home };
    }

    // Build destination from the target location
    let destination: { x: number; y: number; locationId?: Id<"locations"> } | null = null;
    if (decision.targetLocationId) {
      const loc = allLocations.find((l) => l._id === decision!.targetLocationId);
      if (loc) {
        destination = {
          x: loc.entryPoint.x,
          y: loc.entryPoint.y,
          locationId: loc._id,
        };
      }
    }

    // Determine action duration
    const durationKey = decision.action;
    const minDuration =
      CONFIG.DECISIONS.ACTION_MIN_DURATIONS[durationKey] ??
      CONFIG.DECISIONS.ACTION_MIN_DURATIONS["idle"];

    // For mood-critical isolation, use long duration
    const actionDuration =
      decision.action === "idle" &&
      needs.mood < CONFIG.NEEDS.MOOD_CRITICAL_THRESHOLD
        ? 120
        : minDuration;

    // Patch the agent
    await ctx.db.patch(agent._id, {
      currentAction: buildAction(decision),
      currentDestination: destination,
      actionStarted: totalTicks,
      actionDuration: actionDuration,
      currentPath: null, // movement system handles pathfinding
    });

    // Phase 5: Social decisions → conversation queue
    if (decision.action === "socializing" && decision.targetAgentId) {
      // Determine conversation tier based on relationship strength
      const rel = getRelationshipValues(
        allRelationships,
        agent._id,
        decision.targetAgentId,
      );
      const friendship = rel?.friendship ?? 0;
      const romance = rel?.romance ?? 0;
      let tier = "llm_standard";
      if (friendship > 70 || romance > 50) {
        tier = "llm_deep";
      } else if (friendship < 10) {
        tier = "template";
      }

      // Calculate priority: higher need = higher priority
      const priority = Math.round(100 - needs.social + (friendship > 50 ? 20 : 0));

      await ctx.db.insert("conversationQueue", {
        participants: [agent._id, decision.targetAgentId],
        tier,
        priority,
        triggerReason: "needs_social",
        topic: null,
        queuedAt: Date.now(),
        maxWait: 10000,
      });
    }
  }
}
