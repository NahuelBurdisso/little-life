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
  worldEvents,
  worldState,
} from '../../db/schema';
import { logActivity } from '../../lib/activityLogger';
import { findAvailableZone, zoneSlotOffset, fallbackInteriorTile } from '../../lib/interiorGrid';
import { isSeatedZone } from '../../data/interiors';
import { cliqueSocialModifier } from '../../lib/cliques';
import { eq, and, gt } from 'drizzle-orm';
import { CONFIG } from '../../lib/constants';
import { gameMinutes, isOpenAt } from '../../lib/gameClock';
import { gameMinutesToMs } from '../../lib/worldClock';
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
import { simEvents } from '../../lib/simEvents';
import { planExecutor, planGenerator } from '../../lib/planning/instance';
import { getReputationSocialModifier } from '../../lib/reputationEngine';
import { getSharedHobbies } from '../../lib/hobbyEngine';
import { getFavorSocialModifier } from '../../lib/favorEngine';
import { getComfortVisit, completeComfortVisit } from '../../lib/lonelinessEngine';
import { quoteMeal, pantryWouldServe } from './economy';
import { foodCount, isFood } from '../../lib/economyEngine';
import { TRADE_RULES, ITEM_REGISTRY } from '../../data/economyData';

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

/** Drop per-agent work-skip counters for a world replace (agent ids are reused). */
export function clearWorkSkipCounts(): void {
  workSkipCount.clear();
}

// --- Helpers ---

/** Order-independent key for an agent pair. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * CLOCK: GAME MINUTES. `agents.action_started` is stamped with
 * `gameMinutes(world.time)` and `action_duration` (ACTION_MIN_DURATIONS, jail
 * sentences, ...) is in game minutes. It used to be `totalTicks` on both sides
 * of the subtraction, which is fine at tick_speed 1 but at 4x turned a 360-minute
 * night into 360 ticks = 24 game hours: the whole town slept round the clock.
 */
export function isActionComplete(agent: AgentRow, nowMinutes: number): boolean {
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
    return (nowMinutes - agent.action_started) >= agent.action_duration;
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

/** Crowd size past which a venue is "busy" and extra bodies stop mattering. */
const GATHERING_SATURATION = 4;
/** Score added to a saturated venue for an agent of average warmth. */
const GATHERING_MAX_BONUS = 22;

/**
 * How much more inviting a social venue looks for already having people in it.
 *
 * Venue scores were computed as if the town were empty, so every agent picked
 * independently and the square never accumulated anyone — it read as abandoned
 * even at peak hours. The pull also applies to agents already there, which is
 * what makes a gathering last instead of dissolving on the next decision tick.
 *
 * Square-root falloff keeps a packed tavern from outranking everything else,
 * and the warmth scaling means recluses are nudged, not herded.
 */
export function gatheringBonus(occupants: number, warmth: number): number {
  if (occupants <= 0) return 0;
  const crowd = Math.min(occupants, GATHERING_SATURATION) / GATHERING_SATURATION;
  const sociability = 0.4 + (Math.max(0, Math.min(100, warmth)) / 100) * 1.2;
  return GATHERING_MAX_BONUS * Math.sqrt(crowd) * sociability;
}

function isEvening(hour: number): boolean {
  return hour >= 17 && hour < 22;
}

// --- Meals and groceries (G2 / E4) ---
//
// Hunger is only restored by a meal someone actually has: bought at a food
// vendor, or an item from the agent's own inventory (see serveMeal in
// economy.ts). Eating used to be free anywhere, so these choices didn't matter;
// now "eat at home" with an empty pantry feeds nobody, and the decision has to
// send the agent somewhere a meal exists.

/**
 * Where an eating decision should happen: a location id, or `here: true` for
 * "right where they stand" (a packed lunch at the farm, a snack on the bench).
 */
export type MealPlan = { locationId: number | undefined; here: boolean };

/**
 * Where this agent can actually eat right now, given where they meant to.
 * 1. already standing in a vendor that will serve them (open, food in stock,
 *    affordable — or their own): eat there;
 * 2. carrying food: eat it where they stand. Walking across town to buy a meal
 *    with groceries in the bag cost farmers an hour of their shift per meal,
 *    and the food at home went uneaten;
 * 3. the requested vendor, if it will serve them;
 * 4. the nearest vendor that will serve them;
 * 5. home, if the pantry would feed them (broke or starving, once a day);
 * 6. null: no meal to be had right now (vendors closed or sold out, pantry
 *    used). The caller drops the eating option instead — sitting at an empty
 *    table is what pinned a starving town in a 9999-score "eating" loop.
 */
export function chooseMealTarget(
  agent: Pick<AgentRow, 'id' | 'home' | 'position' | 'current_location'>,
  econ: Pick<EconRow, 'money' | 'inventory'> | null,
  requested: number | undefined,
  allLocations: LocationRow[],
  econMap: Map<number, EconRow>,
  time: { hour: number; season: string; day: number },
  hunger?: number,
  critical?: number,
): MealPlan | null {
  const money = econ?.money ?? 0;
  const canServe = (loc: LocationRow): boolean => {
    if (loc.owner == null || !isOpenAt(loc.operating_hours, time.hour)) return false;
    const ownerEcon = econMap.get(loc.owner);
    if (!ownerEcon) return false;
    const quote = quoteMeal(loc, ownerEcon, time.season, agent.id);
    return quote != null && (loc.owner === agent.id || money >= quote.price);
  };
  const at = (id: number): MealPlan => ({ locationId: id, here: false });

  const current = agent.current_location != null ? allLocations.find((l) => l.id === agent.current_location) : undefined;
  if (current && canServe(current)) return at(current.id);

  if (econ && foodCount(econ.inventory) > 0) {
    return { locationId: agent.current_location ?? undefined, here: true };
  }

  const req = requested != null ? allLocations.find((l) => l.id === requested) : undefined;
  if (req && canServe(req)) return at(req.id);

  let best: LocationRow | null = null;
  let bestDist = Infinity;
  for (const loc of allLocations) {
    if (!canServe(loc)) continue;
    const d = distance(agent.position, loc.entry_point);
    if (d < bestDist) { bestDist = d; best = loc; }
  }
  if (best) return at(best.id);
  if (agent.home != null && pantryWouldServe(agent.id, money, hunger, time.day, critical)) return at(agent.home);
  return null;
}

/**
 * Resolve an eating decision to where the meal is (see chooseMealTarget), or
 * null to drop it so the caller falls through to its next-best option.
 */
function withMeal(
  decision: ScoredAction,
  plan: (requested: number | undefined) => MealPlan | null,
): ScoredAction | null {
  if (decision.action !== 'eating') return decision;
  const meal = plan(decision.targetLocationId);
  if (!meal) return null;
  return { ...decision, targetLocationId: meal.locationId };
}

/** A shopping trip restocks food only while the agent holds fewer than this. */
const PANTRY_TARGET = 2;

/**
 * What a shopping trip to `shop` should buy, from needs: the two cheapest foods
 * the shop sells while the agent's pantry is low. The list used to be always
 * empty (`items: []`), so a trip bought nothing (E4).
 */
export function groceryList(econ: Pick<EconRow, 'inventory'> | null, shop: LocationRow | undefined): string[] {
  if (!econ || !shop) return [];
  const rule = TRADE_RULES[shop.type];
  if (!rule || foodCount(econ.inventory) >= PANTRY_TARGET) return [];
  return rule.sells
    .filter(isFood)
    .sort((a, b) => ITEM_REGISTRY[a].basePrice - ITEM_REGISTRY[b].basePrice)
    .slice(0, PANTRY_TARGET);
}

/**
 * The nearest open store (not the agent's own) with food on its shelves, for a
 * grocery run. Null if the agent can't afford even the cheapest thing there.
 */
function nearestGrocer(
  agent: Pick<AgentRow, 'id' | 'position'>,
  money: number,
  allLocations: LocationRow[],
  econMap: Map<number, EconRow> | undefined,
  hour: number,
): LocationRow | null {
  if (!econMap) return null;
  let best: LocationRow | null = null;
  let bestDist = Infinity;
  for (const loc of allLocations) {
    const rule = TRADE_RULES[loc.type];
    if (!rule || loc.owner == null || loc.owner === agent.id || !isOpenAt(loc.operating_hours, hour)) continue;
    const shelf = econMap.get(loc.owner)?.inventory ?? [];
    const affordable = shelf.some((i) => i.quantity > 0 && rule.sells.includes(i.itemId) && isFood(i.itemId)
      && ITEM_REGISTRY[i.itemId].basePrice * 2 <= money);
    if (!affordable) continue;
    const d = distance(agent.position, loc.entry_point);
    if (d < bestDist) { bestDist = d; best = loc; }
  }
  return best;
}

// --- Emergency Check ---

/** Below this hunger a hunger emergency takes someone off their shift. */
export const HUNGER_INTERRUPTS_WORK = 5;

export function checkEmergency(
  agent: AgentRow,
  agentNeeds: NeedsRow,
  allLocations: LocationRow[],
  allRelationships: RelRow[],
  otherAgents: AgentRow[],
  activeEventTypes?: Set<string>,
  mealTarget?: () => MealPlan | null,
): ScoredAction | null {
  const critical = agentNeeds.thresholds?.critical ?? CONFIG.NEEDS.THRESHOLDS.critical;

  // Storm/weather emergency: outdoor agents flee home in bad conditions
  if (agent.current_location === null && activeEventTypes?.has('storm')) {
    return { action: 'idle', score: 9999, targetLocationId: agent.home };
  }

  const crises: { need: string; value: number }[] = [];
  // A hunger crisis with no meal to be had anywhere is not actionable: it would
  // win every pass and hold the agent at an empty table. Let the next crisis
  // (sleep, company) or the normal layers run until a shop opens or restocks.
  //
  // Nor does it pull someone off a shift until they are truly starving: the
  // farm's output was half a shift a day once meals cost food, because every
  // dip under 15 walked the farmers into town. Workers eat at lunch
  // (checkSchedule) and, carrying food, where they stand.
  let hungerMeal: MealPlan | null = null;
  const onShift = (agent.current_action as { type?: string } | null)?.type === 'working';
  if (agentNeeds.hunger < critical && !(onShift && agentNeeds.hunger >= HUNGER_INTERRUPTS_WORK)) {
    hungerMeal = mealTarget ? mealTarget() : { locationId: agent.home ?? undefined, here: false };
    if (hungerMeal != null) crises.push({ need: 'hunger', value: agentNeeds.hunger });
  }
  if (agentNeeds.energy < critical) crises.push({ need: 'energy', value: agentNeeds.energy });
  if (agentNeeds.social < critical) crises.push({ need: 'social', value: agentNeeds.social });

  // Mood is a weighted average of the other needs, so a critical mood almost always
  // means a critical hunger/energy too. Checking it FIRST sent starving agents home
  // to idle instead of eating — and the 120-minute idle duration below pinned them
  // there while hunger kept falling. Real need crises win; despair is the fallback.
  if (crises.length === 0) {
    if (agentNeeds.mood < CONFIG.NEEDS.MOOD_CRITICAL_THRESHOLD) {
      return {
        action: 'idle',
        score: 9999,
        targetLocationId: agent.home,
      };
    }
    return null;
  }

  crises.sort((a, b) => a.value - b.value);
  const worst = crises[0];

  switch (worst.need) {
    case 'hunger': {
      // Where a meal actually is (see chooseMealTarget); used to be "the shop
      // if you have $3, else home" whatever the shop's hours or stock.
      return { action: 'eating', score: 9999, targetLocationId: hungerMeal?.locationId };
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
  hunger?: number,
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

  // Sleep time: personality-adjusted chronotype
  // Night owls (high impulsiveness, high sensuality) stay up later and wake later
  // Early birds (high morality, low impulsiveness) sleep earlier and wake earlier
  let sleepShift = 0; // hours to shift sleep schedule (positive = later, negative = earlier)
  if (personality) {
    // Impulsive/sensual agents are night owls: up to +2 hours later
    sleepShift += (personality.impulsiveness - 50) * 0.02;
    sleepShift += (personality.sensuality - 50) * 0.01;
    // Conscientious/moral agents are early birds: up to -1.5 hours earlier
    sleepShift -= (personality.morality - 50) * 0.015;
    // Neurotic agents need more regular sleep: dampen the shift
    if (personality.neuroticism > 60) sleepShift *= 0.5;
    // Clamp to reasonable range
    sleepShift = Math.max(-2, Math.min(3, Math.round(sleepShift)));
  }

  const baseSleepTime = sched.sleepTime === 0 ? 24 : sched.sleepTime;
  const effectiveSleepTime = Math.max(19, Math.min(26, baseSleepTime + sleepShift)) % 24 || 24;
  const effectiveWakeTime = Math.max(4, Math.min(12, sched.wakeTime + sleepShift));

  if (effectiveSleepTime > effectiveWakeTime) {
    // Normal case: sleep 22 → wake 7 → sleeping when hour >= 22 OR hour < 7
    if (hour >= effectiveSleepTime || hour < effectiveWakeTime) {
      return { action: 'sleeping', score: 5000, targetLocationId: agent.home };
    }
  } else {
    // Inverted case: sleep 2 → wake 10 → sleeping when hour >= 2 AND hour < 10
    if (hour >= effectiveSleepTime && hour < effectiveWakeTime) {
      return { action: 'sleeping', score: 5000, targetLocationId: agent.home };
    }
  }

  // Morning routine: personality-driven activities between wake and work
  if (hour >= effectiveWakeTime && agent.workplace && hour < sched.workStart) {
    // Morning window: agent is awake but work hasn't started yet
    if (personality) {
      // Athletic / impulsive agents: morning jog
      if (personality.impulsiveness > 55 && hour === effectiveWakeTime) {
        const park = nearestLocation(agent.position, allLocations, 'park');
        if (park) return { action: 'idle', score: 3500, targetLocationId: park.id, source: 'jog' };
      }
      // Social agents: visit a cafe/tavern for morning coffee
      if (personality.warmth > 55 && hour === effectiveWakeTime + 1) {
        const cafe = nearestLocation(agent.position, allLocations, ['tavern', 'bakery', 'shop']);
        if (cafe) return { action: 'eating', score: 3500, targetLocationId: cafe.id };
      }
      // Neurotic agents: need quiet time at home first
      if (personality.neuroticism > 60 && hour === effectiveWakeTime) {
        return { action: 'idle', score: 3500, targetLocationId: agent.home, source: 'contemplate' };
      }
    }
    // Default: eat breakfast at home
    if (hour === effectiveWakeTime) {
      return { action: 'eating', score: 3500, targetLocationId: agent.home };
    }
  }

  // Lunch time — a break in the shift. It sat below the work-time return, so
  // it only ever fed people with no job: every worker's lunchTime is inside
  // their shift. Skipped when already fed (a 60-minute meal that starts at the
  // window's opening edge would otherwise be followed by a second one).
  const lunchMinutes = sched.lunchTime * 60;
  const currentMinutes = hour * 60 + minute;
  if (Math.abs(currentMinutes - lunchMinutes) <= 30 && (hunger === undefined || hunger < LUNCH_BELOW_HUNGER)) {
    const foodLoc = nearestLocation(agent.position, allLocations, ['shop', 'tavern', 'bakery']);
    if (foodLoc) {
      return { action: 'eating', score: 3000, targetLocationId: foodLoc.id };
    }
    return { action: 'eating', score: 3000, targetLocationId: agent.home };
  }

  // Work time
  if (agent.workplace && hour >= sched.workStart && hour < sched.workEnd) {
    workSkipCount.set(agent.id, 0); // agent actually went to work — reset counter
    return { action: 'working', score: 4000, targetLocationId: agent.workplace };
  }

  return null;
}

/** Lunch is skipped by anyone fuller than this. */
const LUNCH_BELOW_HUNGER = 70;

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
  activeEventTypes?: Set<string>,
  weather?: string,
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

  // Grocery run: an empty pantry means the next meal at home is no meal (G2).
  // Scored below eating at the same hunger so a hungry agent eats out first;
  // a peckish one restocks. The trip's list comes from groceryList.
  if (agentEcon && foodCount(agentEcon.inventory) === 0) {
    const grocer = nearestGrocer(agent, agentEcon.money, allLocations, econMap, world.time.hour);
    if (grocer) {
      scores.push({
        action: 'shopping',
        score: addNoise(20 + (100 - agentNeeds.hunger) * 0.5),
        targetLocationId: grocer.id,
      });
    }
  }

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

  // Who is already where — the raw material for the crowd pull below.
  const occupancy = new Map<number, number>();
  for (const other of otherAgents) {
    if (other.id === agent.id || !other.is_active || other.current_location == null) continue;
    occupancy.set(other.current_location, (occupancy.get(other.current_location) ?? 0) + 1);
  }
  const crowdPull = (locationId: number) =>
    gatheringBonus(occupancy.get(locationId) ?? 0, personality?.warmth ?? 50);

  // Tavern — attraction driven by personality engine
  const tavern = nearestLocation(agent.position, allLocations, 'tavern');
  if (tavern) {
    let tavernScore = (100 - agentNeeds.fun) * 0.8 + (100 - agentNeeds.social) * 0.6;
    tavernScore += mods?.tavernAttraction ?? (evening ? 15 : 0);
    tavernScore += crowdPull(tavern.id);
    scores.push({ action: 'socializing', score: addNoise(tavernScore), targetLocationId: tavern.id });
  }

  // Go home — preference driven by personality engine
  let homeScore = (100 - agentNeeds.energy) * 1.0;
  if (agentNeeds.comfort < 40) homeScore += 15;
  homeScore *= mods?.homePreference ?? 1.0;
  scores.push({ action: 'idle', score: addNoise(homeScore), targetLocationId: agent.home });

  // Stroll in the town square — the social heart of town should actually draw people
  const square = nearestLocation(agent.position, allLocations, 'town_square');
  if (square) {
    let walkScore = 35 + (agentNeeds.fun < 60 ? 10 : 0);
    // Afternoon promenade: agents low on social gravitate to the square
    if (world.time.hour >= 14 && world.time.hour < 17 && agentNeeds.social < 70) walkScore += 15;
    walkScore += crowdPull(square.id);
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

    // Help at farm — warm agents or during harvest events
    if (farm && (personality.warmth > 55 || events.has('harvest') || events.has('bountiful_catch'))) {
      let farmScore = 10 + (personality.warmth - 40) * 0.2;
      if (events.has('harvest')) farmScore += 20;
      if (agentNeeds.fun < 50) farmScore += 5;
      scores.push({ action: 'idle', score: addNoise(farmScore), targetLocationId: farm.id, source: 'garden' });
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

  return scores;
}

// --- Build action object ---

function buildAction(decision: ScoredAction, shoppingList: string[] = []): Record<string, unknown> {
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
      return { type: 'shopping', shopId: decision.targetLocationId ?? '', items: shoppingList };
    case 'comfort':
      return { type: 'comfort', zoneActivity: 'comfort' };
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
  // Same-pair cooldown. Only conversations that ended inside the cooldown window
  // can block a pair, so load just those and index them by pair. This used to
  // load every ended conversation ever, every tick, then filter + sort that list
  // once per candidate pair — cost grew without bound as the town talked.
  // `ended_at` is Date.now(), so the game-hour cooldown is converted to wall
  // clock at the current speed. It was `hours * 60 * 1000` ms, i.e. one real
  // second per game minute: right at 1x, two game hours at 4x.
  const pairCooldownMs = gameMinutesToMs(CONFIG.CONVERSATIONS.COOLDOWN_SAME_PAIR_HOURS * 60, world.tick_speed);
  const lastEndedByPair = new Map<string, number>();
  for (const c of db.select({ ended_at: conversations.ended_at, participants: conversations.participants })
    .from(conversations)
    .where(and(eq(conversations.status, 'ended'), gt(conversations.ended_at, Date.now() - pairCooldownMs)))
    .all()) {
    const p = c.participants as number[];
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const key = pairKey(p[i], p[j]);
        lastEndedByPair.set(key, Math.max(lastEndedByPair.get(key) ?? 0, c.ended_at ?? 0));
      }
    }
  }
  const pairOnCooldown = (a: number, b: number) => {
    const endedAt = lastEndedByPair.get(pairKey(a, b));
    return endedAt !== undefined && Date.now() - endedAt < pairCooldownMs;
  };

  // Cache shared_knowledge for arrest mechanic
  const allActiveKnowledge = db.select().from(shared_knowledge)
    .where(eq(shared_knowledge.is_active, true))
    .all();

  // Cache active world events — agents react to storms, festivals, etc.
  const activeWorldEvents = db.select().from(worldEvents)
    .where(eq(worldEvents.is_active, true))
    .all();
  const activeEventTypes = new Set(activeWorldEvents.map(e => e.type));

  // Cache current weather for activity availability
  const worldRow = db.select({ weather: worldState.weather }).from(worldState).limit(1).get();
  const currentWeather = worldRow?.weather ?? 'sunny';

  // Action and agent-state stamps are game minutes (see isActionComplete).
  const nowMinutes = gameMinutes(world.time);

  for (const agent of activeAgents) {
    // Skip agents whose current action is still in progress
    if (!isActionComplete(agent, nowMinutes)) continue;

    // Jailed agents serve the sentence. This sits above every scoring tier on
    // purpose — the emergency override scores 9999 and would otherwise send a
    // starving prisoner walking out of the cell to find food.
    if (getAgentStates(agent.id).includes('arrested')) {
      const prisonLoc = allLocations.find(l => l.type === 'prison');
      if (prisonLoc) {
        // The jail feeds its prisoners (economy.ts serveMeal: 'ration'); a
        // sentence runs up to 48 game hours of the 72-hour starvation clock.
        const prisonerHunger = needsMap.get(agent.id)?.hunger ?? 100;
        const mealtime = prisonerHunger < CONFIG.NEEDS.THRESHOLDS.low;
        db.update(agents).set({
          current_action: mealtime ? { type: 'eating', locationId: prisonLoc.id } : { type: 'idle' },
          position: { x: prisonLoc.entry_point.x, y: prisonLoc.entry_point.y },
          current_destination: null,
          current_location: prisonLoc.id,
          action_started: nowMinutes,
          action_duration: 60,
          action_queue: [],
          current_path: null,
        }).where(eq(agents.id, agent.id)).run();
      }
      continue;
    }

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
    const currentPlan = (agent as any).daily_plan as { day: number; source?: string } | null;
    const planIsStale = !currentPlan || currentPlan.day < (world.time.day ?? 1);
    // A fallback plan (the LLM failed) is re-requested like a missing one so it
    // gets upgraded once the LLM recovers. That makes this call fire on most
    // passes for such agents, which is fine: queueGeneration is a no-op while a
    // request is in flight or the agent's retry backoff is running.
    const planIsFallback = currentPlan?.source === 'fallback';
    const planClock = { day: world.time.day ?? 1, hour: world.time.hour, minute: world.time.minute };

    if (completedActionType === 'sleeping' && world.time.hour >= wakeTime) {
      planGenerator.queueGeneration(agent.id, planClock);
    } else if (isDaytime && (planIsStale || planIsFallback) && completedActionType !== 'dead') {
      // Catch-all: agent has no plan for today but it's daytime — generate one now
      planGenerator.queueGeneration(agent.id, planClock);
    }

    // Fetch per-agent data from pre-loaded Maps
    const agentNeeds = needsMap.get(agent.id);
    if (!agentNeeds) continue;

    const agentEcon = econMap.get(agent.id) ?? null;
    const critical = agentNeeds.thresholds?.critical ?? CONFIG.NEEDS.THRESHOLDS.critical;
    const mealPlan = (requested: number | undefined) => chooseMealTarget(
      agent, agentEcon, requested, allLocations, econMap, world.time, agentNeeds.hunger, critical,
    );

    let decision: ScoredAction | null = null;

    // Phase 1: Emergency
    if (CONFIG.DECISIONS.EMERGENCY_OVERRIDE) {
      decision = checkEmergency(
        agent,
        agentNeeds,
        allLocations,
        allRelationships,
        activeAgents,
        activeEventTypes,
        () => mealPlan(agent.home ?? undefined),
      );
    }

    // Phase 1a: Comfort visit (score 7000 — above the day plan, below emergency).
    // A warm friend promised to look in on a lonely neighbour (lonelinessEngine).
    // Walk to wherever they are; the social-queue block below opens the
    // conversation once the two are together.
    if (!decision) {
      const visit = getComfortVisit(agent.id, nowMinutes);
      if (visit) {
        const lonely = activeAgents.find((a) => a.id === visit.lonelyAgentId);
        const lonelyAction = (lonely?.current_action as { type?: string } | null)?.type;
        if (!lonely || lonelyAction === 'dead') {
          completeComfortVisit(agent.id);
        } else if (lonelyAction !== 'sleeping') {
          // Asleep: leave the visit pending; it keeps until its window closes.
          decision = {
            action: 'socializing',
            score: 7000,
            targetLocationId:
              lonely.current_location ?? nearestLocation(lonely.position, allLocations, 'town_square')?.id,
            targetAgentId: lonely.id,
            topic: 'checking in on how they have been doing lately',
            source: 'comfort_visit',
          };
        }
      }
    }

    // Phase 1b: Plan layer (score 6000 — above free-time, below emergency)
    if (!decision) {
      const planned = planExecutor.getPlannedAction(agent.id, world.time.hour, world.time.totalTicks, world.time.day, world.time.minute);
      // A planned meal with no meal to be had falls through to the schedule.
      if (planned) {
        decision = withMeal(planned, mealPlan);
      }
    }

    // Phase 2: Schedule
    if (!decision) {
      const scheduled = checkSchedule(agent, world, allLocations, agentNeeds.hunger);
      decision = scheduled && withMeal(scheduled, mealPlan);
    }

    // Phase 2b: Event crowd behavior — idle agents gravitate toward active events
    if (!decision && activeEventTypes.size > 0) {
      // Festival/wedding/competition: head to town square to join the fun
      if (activeEventTypes.has('festival') || activeEventTypes.has('wedding') || activeEventTypes.has('competition')) {
        const square = nearestLocation(agent.position, allLocations, 'town_square');
        if (square && agent.current_location !== square.id && Math.random() < 0.4) {
          decision = { action: 'socializing', score: 3800, targetLocationId: square.id };
        }
      }
      // Storm: rush home if outdoors
      if (activeEventTypes.has('storm') && agent.current_location === null) {
        decision = { action: 'idle', score: 3800, targetLocationId: agent.home };
      }
      // Town meeting: head to town square
      if (activeEventTypes.has('town_meeting')) {
        const square = nearestLocation(agent.position, allLocations, 'town_square');
        if (square && agent.current_location !== square.id && Math.random() < 0.6) {
          decision = { action: 'socializing', score: 3900, targetLocationId: square.id };
        }
      }
      // Traveling merchant: browse the market
      if (activeEventTypes.has('traveling_merchant') && Math.random() < 0.25) {
        const square = nearestLocation(agent.position, allLocations, 'town_square');
        if (square) {
          decision = { action: 'idle', score: 3500, targetLocationId: square.id, source: 'browse' };
        }
      }
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
        activeEventTypes,
        currentWeather,
      );
      if (scored.length > 0) {
        // Goal alignment bonus — boost social actions toward goal targets
        const agentGoals = goalsMap.get(agent.id) ?? [];
        for (const goal of agentGoals) {
          if (!goal.target_id) continue;
          const target = activeAgents.find(a => a.id === goal.target_id);
          if (!target || !target.is_active) continue;

          // Co-located: massive score boost for socializing with target
          if (agent.current_location === target.current_location) {
            for (const s of scored) {
              if (s.action === 'socializing' && s.targetAgentId === goal.target_id) {
                s.score += Math.round(2500 * goal.priority);
              }
            }
          } else {
            // NOT co-located: add a "go find target" socializing option
            // Goal-driven agents seek out their targets
            const seekScore = Math.round(800 * goal.priority);
            scored.push({
              action: 'socializing',
              score: addNoise(seekScore),
              targetAgentId: target.id,
              targetLocationId: target.current_location ?? undefined,
              source: `goal:seek_target`,
            });
          }
        }

        // Safety net: if all scores suppressed to near-zero, add a minimum walk
        if (scored.every(s => s.score < 5)) {
          const square = allLocations.find(l => l.type === 'town_square');
          if (square) {
            scored.push({ action: 'socializing', score: 10, targetLocationId: square.id });
          }
        }

        // Eating options go where the meal is; with none to be had they are
        // dropped and the next-best action wins (it used to be a 10-minute
        // idle at home, re-decided into the same empty table).
        const viable = scored
          .map((s) => withMeal(s, mealPlan))
          .filter((s): s is ScoredAction => s != null);
        viable.sort((a, b) => b.score - a.score);
        decision = viable[0] ?? null;
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
        if (['eating', 'shopping'].includes(decision!.action)) {
          if (!isOpenAt(targetLoc.operating_hours, world.time.hour)) {
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
    let seatedZone = false;
    if (decision.targetLocationId) {
      const loc = allLocations.find((l) => l.id === decision!.targetLocationId);
      if (loc) {
        // Always pathfind to the entry point — this is guaranteed to be a walkable tile.
        // If the action targets an interior zone, store the zone center separately and
        // teleport the agent there on arrival (two-phase interior movement).
        const destX = loc.entry_point.x;
        const destY = loc.entry_point.y;

        const locType = loc.type as string;
        // Zone activities ride on `action: 'idle'` with the real intent in `source`
        // ('fish', 'garden', 'perform', ...). Passing the action alone sent every
        // activity to whichever zone happened to allow 'idle'.
        // `agent.id` is passed so the agent is not counted against the capacity of
        // the zone it is already standing in — otherwise a single-occupant zone
        // (home:bed) blocks its own occupant on every re-decision.
        const zone = findAvailableZone(locType, decision!.source ?? decision!.action, loc.id, agent.id);
        if (zone) {
          const locPos = loc.position as { x: number; y: number; width: number; height: number };
          const slot = zoneSlotOffset(agent.id);
          zoneTarget = {
            x: locPos.x + zone.center[0] * 32 + 16 + slot.dx,
            y: locPos.y + zone.center[1] * 32 + 16 + slot.dy,
          };
          matchedZoneId = zone.id;
          matchedBuildingType = locType;
          seatedZone = isSeatedZone(locType, zone.id);
        } else {
          // No zone matched (plenty of action/building pairs have no mapping —
          // 'idle' in a shop, 'resting' anywhere). Standing them on a floor tile
          // keeps them inside; the alternative is the entry_point, which is a
          // tile outside the south wall, so they'd loiter on the doorstep.
          const tile = fallbackInteriorTile(locType, agent.id);
          if (tile) {
            const locPos = loc.position as { x: number; y: number; width: number; height: number };
            const slot = zoneSlotOffset(agent.id);
            zoneTarget = {
              x: locPos.x + tile[0] * 32 + 16 + slot.dx,
              y: locPos.y + tile[1] * 32 + 16 + slot.dy,
            };
            matchedBuildingType = locType;
          }
        }

        // Every zone is genuinely full and the agent is already inside: keep them
        // where they stand. Re-routing to the entry_point would park them in the
        // doorway for the whole action.
        const alreadyHere = agent.current_location === loc.id;
        if (!zone && alreadyHere) {
          destination = null;
        } else {
          destination = {
            x: destX,
            y: destY,
            locationId: loc.id,
          };
        }
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
    const baseAction = buildAction(
      decision,
      decision.action === 'shopping'
        ? groceryList(agentEcon, allLocations.find((l) => l.id === decision!.targetLocationId))
        : [],
    );
    // `pose` is a cosmetic hint for the renderer. It rides on the action rather
    // than being derived client-side because the zone id is stripped from
    // `current_action` by the time movement.ts finishes the interior hop, and it
    // survives every one of those rewrites (they all spread the queued action).
    const finalAction = zoneTarget
      ? {
          ...baseAction,
          zoneX: zoneTarget.x,
          zoneY: zoneTarget.y,
          targetZone: matchedZoneId,
          targetBuildingType: matchedBuildingType,
          ...(seatedZone ? { pose: 'sitting' } : {}),
        }
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
          action_started: nowMinutes,
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
          action_started: nowMinutes,
          action_duration: safeDuration,
          current_path: null,
          action_queue: [],
          ...(zonePos ? { position: zonePos } : {}),
        })
        .where(eq(agents.id, agent.id))
        .run();
    }

    // Log zone-driven activities to activity feed
    if (decision.source && ['contemplate', 'fish', 'garden', 'forage', 'perform', 'jog', 'browse', 'rest', 'shoplifting', 'pickpocket'].includes(decision.source)) {
      const activityNames: Record<string, string> = {
        contemplate: 'is contemplating by the riverside',
        fish: 'is fishing at the river',
        garden: 'is tending the garden',
        forage: 'is foraging in the grove',
        perform: 'is performing in the town square',
        jog: 'is jogging around town',
        browse: 'is browsing the market stalls',
        rest: 'is resting at home',
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
      if (pairOnCooldown(agentId, targetId)) continue;

      const rel = getRelationshipValues(
        allRelationships,
        agentId,
        targetId,
      );
      const friendship = rel?.friendship ?? 0;
      const romance = rel?.romance ?? 0;

      // Date detection: romantic socializing in evening = date
      const isDate = romance > 30 && isEvening(world.time.hour);
      if (isDate) {
        const targetName = targetAgent?.name ?? 'someone';
        logActivity({
          type: 'drama',
          initiator: agentId,
          target: targetId,
          templateData: { description: `${agent.name} and ${targetName} are on a date` },
        });
      }

      // Topic selection: use plan-provided topic if available, else personality-driven
      const agentPersonality = agent.personality as PersonalityProfile | null;
      let topic: string | null = decision.topic ?? null;
      if (!topic && agentPersonality) {
        // Generate drama topic from current states
        const agentStatesForTopic = getAgentStates(agentId);
        let recentDrama: string | null = null;
        if (agentStatesForTopic.includes('heartbroken')) recentDrama = 'heartbreak';
        else if (agentStatesForTopic.includes('jealous')) recentDrama = 'jealousy and suspicion';
        else if (agentStatesForTopic.includes('in_debt')) recentDrama = 'money troubles';
        else if (agentStatesForTopic.includes('angry')) recentDrama = 'something that made you angry';
        else if (agentStatesForTopic.includes('infatuated')) recentDrama = 'someone special';

        const otherActiveAgents = activeAgents.filter(a => a.id !== agent.id && a.id !== targetId);
        topic = selectPersonalityTopic(
          agentPersonality,
          agentNeeds.mood,
          friendship,
          romance,
          otherActiveAgents.map(a => ({ name: a.name })),
          recentDrama,
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

      // Date topic override: romantic conversations
      if (!topic && isDate) {
        const dateTopics = [
          'flirting and getting to know each other better',
          'dreams and hopes for the future',
          'favorite memories together',
          'what they find attractive about each other',
          'planning something fun to do together',
        ];
        topic = dateTopics[Math.floor(Math.random() * dateTopics.length)];
      }

      // Context-driven topic overrides: weather, events, hobbies
      if (!topic && Math.random() < 0.35) {
        const contextTopics: string[] = [];

        // Weather commentary
        if (world.time.season === 'winter' && Math.random() < 0.4) contextTopics.push('the cold weather');
        if (world.time.season === 'spring' && Math.random() < 0.3) contextTopics.push('the beautiful spring weather');

        // Active world events
        if (activeEventTypes.has('festival')) contextTopics.push('the town festival');
        if (activeEventTypes.has('storm')) contextTopics.push('the terrible storm');
        if (activeEventTypes.has('wedding')) contextTopics.push('the wedding celebration');
        if (activeEventTypes.has('sickness')) contextTopics.push('the flu going around');
        if (activeEventTypes.has('full_moon')) contextTopics.push('the beautiful full moon');
        if (activeEventTypes.has('competition')) contextTopics.push('the town competition');
        if (activeEventTypes.has('mysterious_stranger')) contextTopics.push('the mysterious stranger in town');
        if (activeEventTypes.has('traveling_merchant')) contextTopics.push('the traveling merchant and their wares');

        // Shared hobbies
        const sharedHobbies = getSharedHobbies(agentId, targetId);
        if (sharedHobbies.length > 0) {
          contextTopics.push(`their shared love of ${sharedHobbies[0]}`);
        }

        if (contextTopics.length > 0) {
          topic = contextTopics[Math.floor(Math.random() * contextTopics.length)];
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

      // A comfort visit is the whole point of the walk over — never let it
      // collapse into a one-line template exchange.
      const isComfortVisit = decision.source === 'comfort_visit';
      if (isComfortVisit && tier === 'template') tier = 'llm_standard';

      // Recorded in the per-tick snapshot too: it was read once at the top of the
      // pass, so when A and B each decided to socialize with the other in the
      // same tick, both saw an empty queue and [A,B] and [B,A] were both queued.
      // The location-encounter pass below reads the same snapshot.
      allQueuedConvos.push(db.insert(conversationQueue)
        .values({
          participants: [agentId, targetId],
          tier,
          priority,
          trigger_reason: isComfortVisit ? 'comfort_visit' : 'needs_social',
          topic,
          queued_at: Date.now(),
          max_wait: 10000,
        })
        .returning()
        .get());
      if (isComfortVisit) completeComfortVisit(agentId);
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
    if (pairOnCooldown(a.id, b.id)) continue;

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

      if (getAgentStates(other.id).includes('arrested')) continue;

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

      // Sentence length scales with how much dirt the town has on them:
      // 8h base, +2h per negative fact past the arrest threshold, capped at 2 days.
      const sentence = Math.min(2880, 480 + (negFacts - arrestThreshold) * 120);

      // Arrest: teleport criminal to prison, then hold them for the sentence.
      // The `arrested` state is what actually confines them — the guard at the
      // top of the decision loop keeps re-idling them until it expires.
      db.update(agents).set({
        current_action: { type: 'idle' },
        position: { x: prison.entry_point.x, y: prison.entry_point.y },
        current_destination: null,
        current_location: prison.id,
        action_started: nowMinutes,
        action_duration: sentence,
        action_queue: [],
        current_path: null,
      }).where(eq(agents.id, other.id)).run();

      db.insert(agentStates).values({
        agent_id: other.id,
        type: 'arrested',
        severity: Math.min(1, sentence / 2880),
        started_at: nowMinutes,
        duration: sentence,
        target_agent_id: agent.id,
        source: 'arrest',
        metadata: { prison_id: prison.id, sentence },
      }).run();

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
        severity: Math.min(1, sentence / 2880),
        templateData: {
          description: `${agent.name} arrested ${other.name}! Sentence: ${Math.round(sentence / 60)} hours.`,
        },
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
