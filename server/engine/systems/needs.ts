import { db, sqlite } from '../../db';
import type { Statement } from 'better-sqlite3';
import { agents, needs, economy, locations, worldState, worldEvents } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { clamp } from '../../lib/utils';
import { emitter } from '../emitter';
import { getAgentStates } from '../../lib/states';
import { updateHungerTracking } from '../../lib/lifeEventsEngine';
import { simEvents } from '../../lib/simEvents';
import { sampleMood, getMoodMomentum } from '../../lib/moodMomentum';
import { adaptNeedsMood, moodBaseline } from '../../lib/moodBaseline';
import { carriedStress, stateMoodEffect } from '../../lib/stateMood';
import type { PersonalityProfile } from '../../lib/personality';
import { getHobbyLevel, getMentorshipOpportunity, applyMentorship } from '../../lib/hobbyEngine';
import { aggregateEventEffects, EVENT_WEATHER, type WorldEventType } from '../../data/worldEventCatalog';
import { gameMinutes, hourChanged } from '../../lib/gameClock';
import { serveMeal, hasPaidVisit, PANTRY_MOOD_PENALTY, PANTRY_MOOD_MINUTES, type Meal } from './economy';

// Track which agents already have an active critical need event to avoid spamming
const criticalNeedFired = new Map<number, Set<string>>();

/** Drop per-agent critical-need latches for a world replace (agent ids are reused). */
export function clearCriticalNeedFired(): void {
  criticalNeedFired.clear();
}

// Game minutes an agent has spent working without a break, accumulated one
// tick's worth (`tick_speed` minutes) per `needsTick`. Not `agents.action_started`
// (see the overwork block below for why that column is unusable here). It used
// to count ticks, so at 4x the 6-hour overwork gate took 24 game hours.
const consecutiveWorkMinutes = new Map<number, number>();

/** Drop per-agent overwork counters for a world replace (agent ids are reused). */
export function clearConsecutiveWorkMinutes(): void {
  consecutiveWorkMinutes.clear();
}

/**
 * Advance (or reset) an agent's consecutive-working counter by `elapsedMinutes`
 * and return it. Mirrors `updateHungerTracking` in lifeEventsEngine: the entry is
 * deleted the moment the condition stops holding, so work → sleep → work starts
 * over.
 */
export function updateWorkTracking(agentId: number, isWorking: boolean, elapsedMinutes: number): number {
  if (!isWorking) {
    consecutiveWorkMinutes.delete(agentId);
    return 0;
  }
  const next = (consecutiveWorkMinutes.get(agentId) ?? 0) + elapsedMinutes;
  consecutiveWorkMinutes.set(agentId, next);
  return next;
}

/**
 * The end-of-loop write, once per agent per tick. Drizzle builds and compiles a
 * fresh statement for every `db.update(...).set(...)` call (the tick profiler
 * counts one `prepare` per execution), which for thirteen residents is thirteen
 * SQLite compiles a tick for an identical query. Prepared once instead and
 * re-run with new parameters; JSON columns are stringified here exactly as
 * drizzle's `mode: 'json'` does.
 *
 * Lazy (first tick, not module load) so importing this file never needs the
 * `needs` table to exist yet, and cached against the module's `sqlite` handle —
 * the same single connection `db` wraps, which nothing swaps at runtime (a world
 * replace rewrites rows, tests point the whole process at their own file before
 * `server/db` loads). SQLite re-prepares a statement itself if the schema changes
 * underneath it. It is still an UPDATE on `needs`, so the write-count triggers
 * (db/index.ts) see it like any other.
 */
let writeNeedsStmt: Statement | undefined;
function writeNeedsRow(
  id: number,
  v: {
    hunger: number; energy: number; social: number; comfort: number; fun: number;
    mood: number; stress: number; moodModifiers: unknown; lastUpdated: number;
  },
): void {
  writeNeedsStmt ??= sqlite.prepare(
    'UPDATE needs SET hunger = ?, energy = ?, social = ?, comfort = ?, fun = ?, mood = ?, stress = ?, mood_modifiers = ?, last_updated = ? WHERE id = ?',
  );
  writeNeedsStmt.run(
    v.hunger, v.energy, v.social, v.comfort, v.fun, v.mood, v.stress,
    JSON.stringify(v.moodModifiers), v.lastUpdated, id,
  );
}

// Need names for iteration
const NEED_KEYS = ['hunger', 'energy', 'social', 'comfort', 'fun'] as const;

/*
 * WORK_FUN_NOTE. Why work barely costs fun, and why home gives a little back.
 *
 * Work used to drain fun at 1.3x the base rate: an 8.7 h shift cost ~40 points, ~55 once
 * stress amplified it, while the evening left after it (2-3 h, most of it spent walking)
 * can earn back ~13 at the tavern. No full-time worker could break even, so in a 10-day
 * soak 5 of 13 residents sat at fun 0. That is not just one flat bar: stress is computed
 * from the lowest need, so fun 0 pinned their stress near 80, stress amplifies every
 * other decay, and they ended each shift at energy ~20, went home instead of out, and
 * never recovered. The shopkeeper, the doctor and the baker were permanently miserable
 * for no reason the player could see or fix.
 *
 * Now a shift costs ~12 and a meal ~1, which an ordinary evening out covers. And someone
 * bored at home (fun under HOME_PASTIME.BELOW) potters about: a book, mending, the stove.
 * It lifts them slowly toward that line and no further, so home takes the edge off
 * boredom but going out is still the only way to be properly entertained.
 */
export const HOME_PASTIME = { BELOW: 40, FUN_MODIFIER: -0.6 } as const;

type NeedKey = (typeof NEED_KEYS)[number];

// Action modifier table: how each action affects need decay
// Negative = restorative, >1 = accelerated decay, <1 = slowed, 0 = no change
const ACTION_MODIFIERS: Record<string, Record<NeedKey, number>> = {
  sleeping:    { hunger: 0.5,  energy: -2.3, social: 1,    comfort: -0.5, fun: 0    },
  eating:      { hunger: -4.0, energy: 0.8,  social: 0.8,  comfort: -0.3, fun: 0.6  },
  // fun 0.85, not 1.3: see WORK_FUN_NOTE below.
  working:     { hunger: 1.2,  energy: 1.5,  social: 0.9,  comfort: 1.2,  fun: 0.85 },
  talking:     { hunger: 1,    energy: 1.1,  social: -2.5, comfort: 1,    fun: -0.5 },
  socializing: { hunger: 1,    energy: 1.1,  social: -3.0, comfort: -0.3, fun: -1.5 },
  idle:        { hunger: 0.8,  energy: -0.5, social: 1,    comfort: -1.0, fun: 1.2  },
  walking:     { hunger: 1.1,  energy: 1.2,  social: 1,    comfort: 0.9,  fun: -0.3 },
  shopping:    { hunger: 1,    energy: 1,    social: 0.9,  comfort: 1,    fun: -0.5 },
  comfort:     { hunger: 0.8, energy: -0.3, social: -0.5, comfort: -2.5, fun: -0.8 },
};

const DEFAULT_MODIFIERS: Record<NeedKey, number> = {
  hunger: 1, energy: 1, social: 1, comfort: 1, fun: 1,
};

// Zone activities provide better restoration than generic idle
const ZONE_ACTIVITY_MODIFIERS: Record<string, Partial<Record<NeedKey, number>>> = {
  contemplate: { comfort: -1.5, fun: -0.5, energy: -0.3 },
  fish:        { fun: -2.0, comfort: -0.8, hunger: 0.5 },
  garden:      { fun: -1.5, comfort: -1.0 },
  forage:      { fun: -1.0, hunger: -0.5 },
  perform:     { fun: -2.5, social: -1.5 },
  jog:         { comfort: -1.8, energy: 1.5, fun: -0.5 },
  browse:      { fun: -1.8, comfort: -0.3 },
  rest:        { energy: -1.5, comfort: -1.2, fun: -0.3 },
};

/**
 * Hunger modifier for "eating" with nothing to eat: sitting at an empty table
 * (idle's rate). Eating used to restore hunger at -4.0 whether or not there was
 * food, so a meal never needed buying (G2).
 */
const NO_FOOD_HUNGER_MODIFIER = 0.8;

/**
 * How filling a real meal is, as a multiplier on the eating/quality-tier hunger
 * rates below. Those rates were tuned for a town where eating was free and the
 * home/shop services topped everyone up all day; at 1x a one-hour home meal
 * came to ~29 hunger against ~106/day of decay, i.e. four meals a day, four
 * units of food per person — more than the farm grows (soak, G2). At 3x a
 * one-hour meal is ~55-70 (home / shop): with breakfast, lunch and dinner on
 * the schedule the soaks settle around hunger 55-65; at 2x they sat near 35-50
 * because the town manages only ~1.5 meals a person a day (sleep, walking and
 * the evening out take the rest of it).
 */
const MEAL_HUNGER_SCALE = 3;

/**
 * Being out somewhere as a patron — hanging about the tavern, sitting down to
 * a meal in company — takes in its social/fun services even though idle and
 * eating don't restore those needs on their own. Working, walking, shopping and
 * sleeping never do.
 */
const LEISURE_ACTIONS: ReadonlySet<string> = new Set(['idle', 'socializing', 'talking', 'eating', 'comfort']);

type LocationRow = typeof locations.$inferSelect;
type Service = NonNullable<LocationRow['services']>[number];

/**
 * Does this location service work on this agent right now? (G2)
 *
 * Services used to apply to anyone standing in the location, whatever they were
 * doing, ignoring `itemRequired` and never charging `cost`: every home fed its
 * sleepers +10 hunger/h and the shop fed its own clerks +15/h, so needs sat at
 * 100 and nobody bought food. A service now only amplifies an activity that
 * already restores that need here — the agent's own action modifiers (after
 * zone overrides and the no-food rule) must be restorative for the service's
 * need. That mapping is derived from ACTION_MODIFIERS rather than a second
 * table: eating → hunger, sleeping/idle → energy, socializing/talking → social,
 * leisure zone activities → fun, and working/walking-to-work never qualify.
 * Social and fun services also reach anyone at leisure there (LEISURE_ACTIONS).
 *
 * On top of that:
 * - hunger is only served with a meal had *here*: a priced menu (`cost`) needs
 *   a meal bought here (or the owner's own stock); a kitchen (`itemRequired`)
 *   needs a food item consumed here; the pantry safety net gets neither.
 * - any other paid service needs the owner, off-shift staff, or a patron who
 *   paid this visit's fee (economy.ts visitFee: the tavern cover, else the
 *   service's own cost — the Dive's fun, the clinic's energy).
 * - any other `itemRequired` needs the item in the agent's inventory.
 */
export function serviceApplies(
  service: Service,
  ctx: {
    agentId: number;
    location: Pick<LocationRow, 'id' | 'owner'>;
    modifiers: Record<NeedKey, number>;
    meal: Meal | null;
    inventory: readonly { itemId: string; quantity: number }[];
    paidVisit: boolean;
    /** The location is the agent's workplace (and they aren't working: see the action gate). */
    isStaff?: boolean;
    actionType?: string;
  },
): boolean {
  const need = service.needSatisfied as NeedKey;
  if (!NEED_KEYS.includes(need)) return false;
  const leisure = (need === 'social' || need === 'fun') && ctx.actionType !== undefined && LEISURE_ACTIONS.has(ctx.actionType);
  if (!(ctx.modifiers[need] < 0) && !leisure) return false;

  if (need === 'hunger') {
    const meal = ctx.meal;
    if (!meal || meal.locationId !== ctx.location.id || meal.source === 'pantry' || meal.source === 'ration') return false;
    if (service.cost > 0) return meal.source === 'bought' || meal.source === 'own_stock';
    if (service.itemRequired) return meal.source === 'own_food';
    return true;
  }

  if (service.itemRequired && !ctx.inventory.some((i) => i.itemId === service.itemRequired && i.quantity > 0)) {
    return false;
  }
  // Off-shift staff drink on the house: the bartender and the musician stay
  // for the evening where they work, and charging them their own venue's cover
  // (economy.ts exempts them) would just leave them without it.
  if (service.cost > 0) return ctx.location.owner === ctx.agentId || ctx.isStaff === true || ctx.paidVisit;
  return true;
}

function applyModifier(baseDecay: number, modifier: number): number {
  if (modifier < 0) {
    // Restorative: return negative value (will restore the need when subtracted)
    return modifier * Math.abs(baseDecay);
  }
  return baseDecay * modifier;
}

function getWeatherMoodEffect(weather: string, isIndoors: boolean): number {
  if (weather === 'rainy' && !isIndoors) return -2;
  if (weather === 'rainy' && isIndoors) return 1; // Cozy
  if (weather === 'stormy' && !isIndoors) return -5;
  if (weather === 'stormy' && isIndoors) return 0;
  if (weather === 'foggy' && !isIndoors) return -1;
  if (weather === 'snowy' && !isIndoors) return -1; // Cold but pretty
  if (weather === 'snowy' && isIndoors) return 2;   // Very cozy by the fire
  if (weather === 'windy' && !isIndoors) return -1;  // Annoying wind
  if (weather === 'hot' && !isIndoors) return -3;     // Oppressive heat
  if (weather === 'hot' && isIndoors) return -1;      // Still hot inside
  if (weather === 'sunny') return 1;
  return 0; // cloudy or unknown
}

export function needsTick(): void {
  const world = db.select().from(worldState).get();
  if (!world) return;

  const gameHoursElapsed = world.tick_speed / 60;

  // Fetch all active agents and all needs records
  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const allNeeds = db.select().from(needs).all();

  // Index needs by agent_id for fast lookup
  const needsByAgent = new Map<number, typeof allNeeds[0]>();
  for (const n of allNeeds) {
    needsByAgent.set(n.agent_id, n);
  }

  // Fetch economy records for money checks (location service affordability)
  const allEconomy = db.select().from(economy).all();
  const economyByAgent = new Map<number, typeof allEconomy[0]>();
  for (const e of allEconomy) {
    economyByAgent.set(e.agent_id, e);
  }

  // Pre-load all locations into a Map to avoid per-agent queries
  const allLocations = db.select().from(locations).all();
  const locationsById = new Map<number, typeof allLocations[0]>();
  for (const loc of allLocations) {
    locationsById.set(loc.id, loc);
  }

  const currentTime = gameMinutes(world.time!);
  const isNewHour = hourChanged(world.pending_transitions);

  // Load active world events and extract their effects for need modifiers.
  // The catalog decides how each key stacks: boosts add, energy_drain multiplies.
  const activeEvents = db.select().from(worldEvents).where(eq(worldEvents.is_active, true)).all();
  const eventEffects = aggregateEventEffects(activeEvents.map((e) => e.effects));
  // An event that brought the current weather with it (a Heavy Storm makes it
  // stormy, a heatwave hot) prices that weather outdoors through its own
  // `mood_outdoor`. Adding the plain weather penalty on top charged an agent
  // caught outside twice for the same storm, -15 and -5 (B18). The event's
  // figure is the one kept: it is the stronger, deliberate one, and plain
  // stormy weather without the event keeps its milder -5.
  const eventOwnsWeather = activeEvents.some(
    (e) => EVENT_WEATHER[e.type as WorldEventType] === world.weather && (e.effects as Record<string, number>)?.mood_outdoor,
  );

  for (const agent of activeAgents) {
    const agentNeeds = needsByAgent.get(agent.id);
    if (!agentNeeds) continue;

    // Step 1-2: Get action type and look up modifiers
    const actionType: string = (agent.current_action as any)?.type ?? 'idle';
    const zoneActivity: string | undefined = (agent.current_action as any)?.zoneActivity;
    const baseModifiers = ACTION_MODIFIERS[actionType] ?? DEFAULT_MODIFIERS;
    // Override with zone activity modifiers if present
    const zoneOverrides = zoneActivity ? ZONE_ACTIVITY_MODIFIERS[zoneActivity] : undefined;
    let modifiers = zoneOverrides ? { ...baseModifiers, ...zoneOverrides } : baseModifiers;
    if (actionType === 'idle' && !zoneActivity && agent.home != null && agent.current_location === agent.home
      && agentNeeds.fun < HOME_PASTIME.BELOW) {
      modifiers = { ...modifiers, fun: HOME_PASTIME.FUN_MODIFIER };
    }

    // A meal needs food (G2): serveMeal buys it from the vendor the agent is
    // eating at, or consumes an item they hold, or — broke or starving, at home,
    // once a day — the pantry. No meal: eating restores nothing. Called before
    // the economy phase so the meal starts feeding on the tick it starts.
    let meal: Meal | null = null;
    if (actionType === 'eating') {
      const here = agent.current_location != null ? locationsById.get(agent.current_location) ?? null : null;
      meal = serveMeal(world, agent, here, economyByAgent, {
        hunger: agentNeeds.hunger,
        critical: agentNeeds.thresholds?.critical,
      });
      if (!meal) modifiers = { ...modifiers, hunger: NO_FOOD_HUNGER_MODIFIER };
    }
    const mealBoughtHere = meal != null && (meal.source === 'bought' || meal.source === 'own_stock')
      && meal.locationId === agent.current_location;

    // Food quality tiers: eating location affects hunger restoration — for a meal
    // the vendor actually served, not a sandwich brought along.
    if (mealBoughtHere && agent.current_location) {
      const eatLoc = locationsById.get(agent.current_location);
      if (eatLoc) {
        const locType = eatLoc.type;
        if (locType === 'tavern') {
          // Tavern meals: best quality, also fun
          modifiers = { ...modifiers, hunger: -5.5, fun: -0.8 };
        } else if (locType === 'bakery') {
          // Bakery: good quality, comfort food
          modifiers = { ...modifiers, hunger: -4.8, comfort: -0.5 };
        } else if (locType === 'shop') {
          // Shop/market: decent quality
          modifiers = { ...modifiers, hunger: -4.5 };
        }
        // Home meals: base -4.0 (default), enhanced by cooking skill
      }
    }
    // Home cooking skill bonus — cooking needs ingredients
    if (meal?.source === 'own_food' && agent.current_location === agent.home) {
      const cookingSkill = getHobbyLevel(agent.id, 'cook') as number;
      if (cookingSkill > 0) {
        // Skilled cooks make better meals at home
        const skillBonus = Math.min(2.0, cookingSkill * 0.04); // up to -2.0 extra at level 50
        modifiers = { ...modifiers, hunger: (modifiers.hunger ?? -4.0) - skillBonus };
      }
    }

    if (meal && modifiers.hunger < 0) {
      modifiers = { ...modifiers, hunger: modifiers.hunger * MEAL_HUNGER_SCALE };
    }

    // Steps 3-6: Calculate decay per need with action modifier and stress amplifier
    const stressMultiplier = 1 + (agentNeeds.stress / 200);
    const updatedNeeds: Record<NeedKey, number> = {} as Record<NeedKey, number>;
    const agentStateTypes = getAgentStates(agent.id);

    for (const key of NEED_KEYS) {
      const decayRate = agentNeeds.decay_rates[key];
      const baseDecay = decayRate * gameHoursElapsed;
      let modifiedDecay = applyModifier(baseDecay, modifiers[key]);

      // Sick → double energy decay
      if (key === 'energy' && agentStateTypes.includes('sick')) {
        modifiedDecay *= 2;
      }

      // Sleep quality: stress/drunk/mood affect energy restoration while sleeping
      // Penalties are soft to prevent unrecoverable energy spirals
      if (key === 'energy' && actionType === 'sleeping' && modifiedDecay < 0) {
        // Stressed agents sleep slightly worse
        if (agentNeeds.stress > 60) {
          modifiedDecay *= 0.75; // 25% less restoration
        } else if (agentNeeds.stress > 40) {
          modifiedDecay *= 0.85;
        }
        // Drunk agents pass out — poor but not terrible sleep
        if (agentStateTypes.includes('drunk')) {
          modifiedDecay *= 0.7; // 30% penalty
        }
        // Good mood momentum = better sleep
        const momentum = getMoodMomentum(agent.id);
        if (momentum > 5) {
          modifiedDecay *= 1.2; // well-rested from good mood
        } else if (momentum < -5) {
          modifiedDecay *= 0.8; // restless from bad mood
        }
      }

      // Weather-aware decay modifiers for outdoor agents
      const agentIsOutdoors = agent.current_location === null;
      if (agentIsOutdoors && modifiedDecay > 0) {
        if (world.weather === 'rainy') {
          if (key === 'comfort') modifiedDecay *= 1.8;
          if (key === 'fun') modifiedDecay *= 1.3;
        } else if (world.weather === 'stormy') {
          if (key === 'comfort') modifiedDecay *= 2.5;
          if (key === 'energy') modifiedDecay *= 1.5;
          if (key === 'fun') modifiedDecay *= 1.8;
        } else if (world.weather === 'sunny') {
          if (key === 'energy') modifiedDecay *= 0.8;
          if (key === 'fun') modifiedDecay *= 0.85;
        } else if (world.weather === 'foggy') {
          if (key === 'comfort') modifiedDecay *= 1.3;
        } else if (world.weather === 'snowy') {
          if (key === 'comfort') modifiedDecay *= 2.0;  // cold and wet
          if (key === 'energy') modifiedDecay *= 1.4;   // trudging through snow
          if (key === 'fun') modifiedDecay *= 0.7;      // snow is fun!
        } else if (world.weather === 'windy') {
          if (key === 'comfort') modifiedDecay *= 1.5;  // wind chill
          if (key === 'energy') modifiedDecay *= 1.2;   // fighting the wind
        } else if (world.weather === 'hot') {
          if (key === 'energy') modifiedDecay *= 1.8;   // heat exhaustion
          if (key === 'comfort') modifiedDecay *= 1.6;  // sweating
        }
      }
      // Indoors during bad weather: cozy bonus
      if (!agentIsOutdoors && modifiedDecay > 0) {
        if (['rainy', 'stormy', 'snowy'].includes(world.weather) && key === 'comfort') {
          modifiedDecay *= 0.6; // cozy inside
        }
      }

      // Only amplify decay (positive values) with stress — never amplify restoration.
      // Hunger is exempt: hunger feeds stress (stress is 100 minus a blend of the
      // lowest and average need), so letting stress speed hunger up closed a
      // loop — hungry → stressed → hungrier — that a town paying for its food
      // could not climb out of between meals.
      const amplified = modifiedDecay > 0 && key !== 'hunger';
      const finalDecay = amplified ? modifiedDecay * stressMultiplier : modifiedDecay;
      updatedNeeds[key] = agentNeeds[key] - finalDecay;
    }

    // Step 7: Apply location service bonuses
    if (agent.current_location) {
      const location = locationsById.get(agent.current_location);
      if (location && location.services) {
        const ctx = {
          agentId: agent.id,
          location,
          modifiers,
          meal,
          inventory: (economyByAgent.get(agent.id)?.inventory ?? []) as { itemId: string; quantity: number }[],
          paidVisit: hasPaidVisit(agent.id, location.id),
          isStaff: agent.workplace === location.id,
          actionType,
        };
        for (const service of location.services) {
          if (serviceApplies(service, ctx)) {
            updatedNeeds[service.needSatisfied as NeedKey] += service.amount * gameHoursElapsed;
          }
        }
      }
    }

    // Step 7b: Performer/spectator fun boost — co-located agents benefit from performances
    if (agent.current_location) {
      const coLocated = activeAgents.filter(
        (other) => other.id !== agent.id && other.current_location === agent.current_location,
      );
      const performerNearby = coLocated.some(
        (other) => (other.current_action as any)?.zoneActivity === 'perform',
      );
      if (performerNearby) {
        updatedNeeds.fun += 1.5 * gameHoursElapsed; // watching a performance is fun
        updatedNeeds.social += 0.5 * gameHoursElapsed;
      }

      // Group activity bonus: 3+ agents at same location creates emergent gathering
      if (coLocated.length >= 2) { // agent + 2 others = 3 total
        const groupSize = coLocated.length + 1;
        const socializingCount = coLocated.filter(
          (other) => {
            const action = (other.current_action as any)?.type;
            return action === 'socializing' || action === 'talking' || action === 'idle';
          },
        ).length;

        // Group synergy: more people socializing = better atmosphere
        if (socializingCount >= 2) {
          const groupBonus = Math.min(3.0, 0.5 * socializingCount); // caps at 3.0
          updatedNeeds.social += groupBonus * gameHoursElapsed;
          updatedNeeds.fun += groupBonus * 0.6 * gameHoursElapsed;

          // Large gatherings (5+) create party atmosphere
          if (groupSize >= 5) {
            updatedNeeds.fun += 1.0 * gameHoursElapsed;
            updatedNeeds.comfort += 0.5 * gameHoursElapsed;
          }
        }
      }

      // Mentorship: experienced agents teaching co-located agents with same zone activity
      if (zoneActivity && coLocated.length > 0) {
        for (const other of coLocated) {
          const otherActivity = (other.current_action as any)?.zoneActivity;
          if (otherActivity !== zoneActivity) continue;
          const mentorHobby = getMentorshipOpportunity(agent.id, other.id);
          if (mentorHobby) {
            // Agent is mentoring — boost social and fun
            updatedNeeds.social += 1.5 * gameHoursElapsed;
            updatedNeeds.fun += 1.0 * gameHoursElapsed;
            applyMentorship(agent.id, other.id, mentorHobby, currentTime);
            break; // Only mentor one agent at a time
          }
        }
      }
    }

    // Step 7c: Apply world event effects to needs
    const isIndoors = agent.current_location !== null;
    if (eventEffects.social_boost) {
      updatedNeeds.social += eventEffects.social_boost * gameHoursElapsed * 0.1;
    }
    if (eventEffects.fun_boost) {
      updatedNeeds.fun += eventEffects.fun_boost * gameHoursElapsed * 0.1;
    }
    if (eventEffects.energy_drain !== 1) {
      updatedNeeds.energy -= (eventEffects.energy_drain - 1) * 2 * gameHoursElapsed;
    }
    // mood_outdoor / mood_boost are applied in the mood recalculation (Step 11).
    // Romance boost from events (weddings, full moon, starry night) → social/fun boost
    if (eventEffects.romance_boost) {
      if (actionType === 'socializing' || actionType === 'talking') {
        updatedNeeds.social += eventEffects.romance_boost * gameHoursElapsed * 0.05;
        updatedNeeds.fun += eventEffects.romance_boost * gameHoursElapsed * 0.03;
      }
    }

    // Step 8: Weather mood effect
    const weatherModifier = eventOwnsWeather && !isIndoors ? 0 : getWeatherMoodEffect(world.weather, isIndoors);

    // Step 9: Clamp all need values to 0-100
    for (const key of NEED_KEYS) {
      updatedNeeds[key] = clamp(updatedNeeds[key], 0, 100);
    }

    // Step 10: Expire mood modifiers past their expiresAt
    const activeMoodModifiers = agentNeeds.mood_modifiers.filter(
      (m) => m.expiresAt > currentTime
    );
    // Scraping a meal together from the cupboards is a bad day, not a free
    // lunch. One pantry meal a day and the penalty outlasts the meal, so this
    // lands once per pantry meal.
    if (meal?.source === 'pantry' && !activeMoodModifiers.some((m) => m.source === 'meager_meal')) {
      activeMoodModifiers.push({ source: 'meager_meal', value: PANTRY_MOOD_PENALTY, expiresAt: currentTime + PANTRY_MOOD_MINUTES });
    }

    // Step 11: Recalculate mood
    const moodModifierSum = activeMoodModifiers.reduce(
      (sum, m) => sum + m.value,
      0
    );
    // World event mood effects: outdoor-only (storms, starry nights) plus
    // town-wide (scandal, blessing).
    const eventMoodEffect =
      ((!isIndoors && eventEffects.mood_outdoor) ? eventEffects.mood_outdoor : 0) +
      (eventEffects.mood_boost ?? 0);

    // Mood momentum: yesterday's average mood affects today's baseline
    const moodMomentum = getMoodMomentum(agent.id);

    // The needs, adapted around this resident's temperament (lib/moodBaseline.ts): comfort
    // counts at half strength above their usual self, want nearly in full below it. Taken
    // raw, a well-fed, well-rested town read as ~90 for weeks.
    const needsComposite =
      updatedNeeds.hunger * 0.2 +
      updatedNeeds.energy * 0.2 +
      updatedNeeds.social * 0.25 +
      updatedNeeds.comfort * 0.15 +
      updatedNeeds.fun * 0.2;
    const baseline = moodBaseline(agent.personality as PersonalityProfile | null);

    // Grief, heartbreak, a cell, jealousy... (lib/stateMood.ts). Rebuilt here
    // every tick like the rest, because the direct `needs.mood` writes these
    // states used to make were overwritten by this very line on the next tick.
    const stateMood = stateMoodEffect(agentStateTypes);

    let baseMood =
      adaptNeedsMood(needsComposite, baseline) +
      moodModifierSum +
      weatherModifier +
      eventMoodEffect +
      moodMomentum +
      stateMood;

    // Depressed → halve positive mood gains (clamp positive delta)
    if (agentStateTypes.includes('depressed')) {
      const currentMood = agentNeeds.mood;
      const moodDelta = baseMood - currentMood;
      if (moodDelta > 0) {
        baseMood = currentMood + moodDelta * 0.5;
      }
    }

    const mood = clamp(baseMood, 0, 100);

    // Step 12: Recalculate stress — base from needs + modifiers from states and overwork
    const needValues = NEED_KEYS.map((k) => updatedNeeds[k]);
    const lowestNeed = Math.min(...needValues);
    const averageNeed =
      needValues.reduce((sum, v) => sum + v, 0) / needValues.length;
    let stress = clamp(100 - (lowestNeed * 0.6 + averageNeed * 0.4), 0, 100);

    // Overwork: working adds stress proportional to consecutive time spent working.
    //
    // CLOCK: `consecutiveWorkMinutes` is a duration accumulated per tick, not a
    // stamp on the absolute clock (`currentTime` carries the start-day offset and
    // would put every agent past the gate on the world's first tick).
    //
    // WHY NOT `agents.action_started` (a game-minute stamp): the decision engine
    // rewrites `action_started` every time it re-issues an action, and it has no
    // "same action → keep the old stamp" short-circuit. `working` has an
    // ACTION_MIN_DURATION of 60 game minutes, so `isActionComplete` fires every
    // hour, the schedule path re-decides `working`, and `action_started` is reset
    // to now. Its age therefore tops out around 65 minutes (60 plus the
    // interior-transition padding in movement.ts) and can never reach 6 hours. A counter that survives action re-issue is the only
    // way to measure a genuinely long shift.
    const workMinutes = updateWorkTracking(agent.id, actionType === 'working', world.tick_speed);
    if (workMinutes > 360) { // 6 game hours
      stress = clamp(stress + (workMinutes - 360) * 0.02, 0, 100);
    }

    // State-driven stress modifiers
    if (agentStateTypes.includes('in_debt')) stress = clamp(stress + 10, 0, 100);
    if (agentStateTypes.includes('jealous')) stress = clamp(stress + 8, 0, 100);
    if (agentStateTypes.includes('alcoholic')) stress = clamp(stress + 5, 0, 100);
    if (agentStateTypes.includes('heartbroken')) stress = clamp(stress + 12, 0, 100);
    if (agentStateTypes.includes('angry')) stress = clamp(stress + 6, 0, 100);

    // Carry-over: what the needs say is the floor, but a shock written straight
    // to `needs.stress` (a snap breakdown, a witnessed crime, a cascade's
    // stressDelta) fades over hours instead of vanishing on this recompute.
    stress = carriedStress(stress, agentNeeds.stress, world.tick_speed);


    // Step 12.4: Emit critical need events (once per threshold crossing, not every tick)
    const agentCritical = criticalNeedFired.get(agent.id) ?? new Set<string>();
    const CRITICAL_THRESHOLD = 15;
    const needActionMap: Record<string, string> = {
      hunger: 'eat',
      energy: 'sleep',
      social: 'socialize',
    };
    for (const [needKey, action] of Object.entries(needActionMap)) {
      const value = updatedNeeds[needKey as NeedKey];
      if (value <= CRITICAL_THRESHOLD && !agentCritical.has(needKey)) {
        simEvents.emit('need:critical', { agentId: agent.id, action });
        agentCritical.add(needKey);
      } else if (value > CRITICAL_THRESHOLD + 10) {
        agentCritical.delete(needKey); // Reset so it can fire again if need drops again
      }
    }
    criticalNeedFired.set(agent.id, agentCritical);

    // Step 12.5: Track hunger-at-zero for death mechanic
    updateHungerTracking(agent.id, updatedNeeds.hunger, world.tick_speed);

    // Step 12.6: Sample mood for momentum tracking (once per game hour).
    // `minute === 0` never matched at 2x/4x once the clock started on an odd
    // (or non-multiple-of-4) minute, so momentum had no samples at all.
    if (isNewHour) {
      sampleMood(agent.id, mood);
    }

    // Step 13: Write updated values
    writeNeedsRow(agentNeeds.id, {
      hunger: updatedNeeds.hunger,
      energy: updatedNeeds.energy,
      social: updatedNeeds.social,
      comfort: updatedNeeds.comfort,
      fun: updatedNeeds.fun,
      mood,
      stress,
      moodModifiers: activeMoodModifiers,
      lastUpdated: currentTime,
    });
  }

  emitter.markDirty('agents.all');
}
